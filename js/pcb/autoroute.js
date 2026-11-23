// 自動配線（格子上の A* 探索＋引き直し）
// - 既定は表と裏の2層。opt.layers で内層（例: 4層の In2）も信号に使える。層の移動は貫通ビア
// - 障害物（他のネットのパッド・配線・ビア・穴・基板外形）を「間隔＋線幅の半分」だけ太らせて格子に塗り、
//   空いているマスだけを通る。対角に進むときは両脇のマスも空いていること（角をかすめない）
// - ネットごとに、まだつながっていない島どうし（ラッツネスト）を短い順に1本ずつ結ぶ
// - 引けない接続は「この実行で引いた配線」を横切ってよいことにして経路を探し、邪魔になった配線をはがして先に通し、
//   はがした接続は後で引き直す（はがし直しは回数に上限あり）
// - 実行前からある配線・ビアには手を付けない
// 単位: mm（基板座標）。PCB には nm で書き込む。

import { allPads, pointInPad, toMm, toNm, boardRect, copperLayers, padHole, addTrackPath, addVia } from './model.js';
import { DSU } from '../core/util.js';
import { pointInRing } from '../core/geom2d.js';
import { computePcbConnectivity } from './connectivity.js';
import { fillAllZones } from './zonefill.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const BLOCK = 0xffff;

/** 2分ヒープ（優先度つき待ち行列） */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * @param pcb PCB（tracks・vias に追加する）
 * @param rules 設計ルール（drcRules）
 * @param opt.layers 配線に使う層（既定 ['F.Cu','B.Cu']）
 * @param opt.grid 格子の間隔 mm（既定 0.05）
 * @param opt.trackWidth 信号の線幅 mm（既定 0.15。ルールの最小幅未満にはしない）
 * @param opt.powerWidth 電源・GND の線幅 mm（既定 0.3。パッドより太いとき・通れないときは信号の線幅）
 * @param opt.netWidth (net) => mm。電流から求めた必要な線幅（0 なら上の既定）。この幅より細くは引かない
 * @param opt.nets 配線するネット（既定: 未配線のある全ネット）
 * @param opt.maxRips はがし直しの総数の上限（既定 300）
 * @param opt.seed 0 以外にすると引く順番を少し変える（結果が悪いときに別の順番を試す）
 * @param opt.onProgress (done, total, net) => void
 * @param opt.yieldEvery 何本ごとに処理を戻すか（画面を固めない）
 * @returns { routed, failed:[{net,a,b}], tracks, vias, rips }
 */
export async function autoroute(pcb, rules, opt = {}) {
  const g = opt.grid || 0.05;
  const W = Math.max(rules.minTrackWidthMm, opt.trackWidth || 0.15);
  const PW = Math.max(W, opt.powerWidth || 0.3);
  const viaD = toMm(pcb.settings.viaDiameter), viaH = toMm(pcb.settings.viaDrill);
  const clr = rules.minClearanceMm + 0.01, padClr = Math.max(rules.minPadClearanceMm, rules.minClearanceMm) + 0.005;
  const margin = 0.005; // 格子の点の間を線が通るときに近づく分（0.002mm 未満）＋丸め
  const br = boardRect(pcb);
  const cu = copperLayers(pcb);
  const LAY = (opt.layers || ['F.Cu', 'B.Cu']).filter((l) => cu.includes(l));
  const K = LAY.length;
  const nx = Math.ceil((br.x1 - br.x0) / g) + 1, ny = Math.ceil((br.y1 - br.y0) / g) + 1, N = nx * ny;
  const X = (i) => br.x0 + i * g, Y = (j) => br.y0 + j * g;
  const isPower = opt.isPower || ((n) => /^(GND|AGND|DGND|PGND|VBUS|VCC|VDD|VIN|VBAT|VSS)$|^\+\d/.test(n));
  const maxNodes = opt.maxNodes || 600000;
  let maxNodesNow = maxNodes;

  // ネット番号
  const netIds = new Map();
  const nid = (n) => { if (!n) return BLOCK; if (!netIds.has(n)) netIds.set(n, netIds.size + 1); return netIds.get(n); };

  // ---- 格子 ----
  // base: 実行前からある物（パッド・既存の配線とビア・穴・外形）。run: この実行で引いた配線。値は「通ってよいネット」
  const base = { t: Object.fromEntries(LAY.map((l) => [l, new Uint16Array(N)])), v: new Uint16Array(N) };
  let run, own;
  const resetRun = () => {
    run = { t: Object.fromEntries(LAY.map((l) => [l, new Uint16Array(N)])), v: new Uint16Array(N) };
    own = { t: Object.fromEntries(LAY.map((l) => [l, new Int32Array(N)])), v: new Int32Array(N) }; // どの接続の配線か（番号+1）
  };
  resetRun();
  const mark = (arr, i, id) => { const o = arr[i]; arr[i] = o === 0 || o === id ? id : BLOCK; };
  const paint = (arr, x0, y0, x1, y1, id, test, ownArr, who) => {
    const i0 = Math.max(0, Math.floor((x0 - br.x0) / g)), i1 = Math.min(nx - 1, Math.ceil((x1 - br.x0) / g));
    const j0 = Math.max(0, Math.floor((y0 - br.y0) / g)), j1 = Math.min(ny - 1, Math.ceil((y1 - br.y0) / g));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (test(X(i), Y(j))) { const c = j * nx + i; mark(arr, c, id); if (ownArr) ownArr[c] = who; }
  };
  const segD = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const capsule = (arr, a, b, r, id, ownArr, who) => paint(arr, Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r, id, (x, y) => segD({ x, y }, a, b) < r, ownArr, who);
  const paintTrack = (M, L, a, b, w, id, who) => {
    if (M.t[L]) capsule(M.t[L], a, b, w / 2 + W / 2 + clr + margin, id, who && own.t[L], who);
    capsule(M.v, a, b, w / 2 + viaD / 2 + clr + margin, id, who && own.v, who);
  };
  // d・h: そのビアの外径・穴径（既存のビアは設定と違う大きさのことがある）
  const paintVia = (M, c, id, who, d = viaD, h = viaH) => {
    for (const L of LAY) capsule(M.t[L], c, c, d / 2 + W / 2 + clr + margin, id, who && own.t[L], who);
    capsule(M.v, c, c, Math.max(d / 2 + viaD / 2 + clr, h / 2 + viaH / 2 + rules.minHoleToHoleMm) + margin, id, who && own.v, who);
  };

  const pads = allPads(pcb);
  const padByKey = new Map(pads.map((p) => [p.key, p]));
  for (const p of pads) {
    const id = nid(p.net);
    const tI = W / 2 + padClr + margin, vI = viaD / 2 + padClr + margin;
    const ext = Math.max(p.pad.w, p.pad.h) / 2 + vI;
    for (const L of p.layers) if (base.t[L]) paint(base.t[L], p.x - ext, p.y - ext, p.x + ext, p.y + ext, id, (x, y) => pointInPad(p.inst, p.pad, x, y, tI));
    paint(base.v, p.x - ext, p.y - ext, p.x + ext, p.y + ext, id, (x, y) => pointInPad(p.inst, p.pad, x, y, vI));
    if (p.pad.type === 'tht') { const h = padHole(p.inst, p.pad); capsule(base.v, h.a, h.b, h.d / 2 + viaH / 2 + rules.minHoleToHoleMm + margin, id); }
  }
  for (const t of pcb.tracks) paintTrack(base, t.layer, { x: toMm(t.a.x), y: toMm(t.a.y) }, { x: toMm(t.b.x), y: toMm(t.b.y) }, toMm(t.width), nid(t.net));
  for (const v of pcb.vias) paintVia(base, { x: toMm(v.x), y: toMm(v.y) }, nid(v.net), 0, toMm(v.diameter), toMm(v.drill));
  for (const h of pcb.holes) {
    const c = { x: toMm(h.x), y: toMm(h.y) }, r = toMm(h.drill) / 2;
    for (const L of LAY) capsule(base.t[L], c, c, r + rules.minNpthToCopperMm + W / 2 + margin, BLOCK);
    capsule(base.v, c, c, r + Math.max(rules.minNpthToCopperMm + viaD / 2, rules.minHoleToHoleMm + viaH / 2) + margin, BLOCK);
  }
  const isInner = (l) => l !== 'F.Cu' && l !== 'B.Cu';
  const eT = LAY.map((l) => (isInner(l) ? rules.innerEdgeClearanceMm || rules.boardEdgeClearanceMm : rules.boardEdgeClearanceMm) + W / 2 + margin);
  const eV = Math.max(rules.boardEdgeClearanceMm, cu.length > 2 ? rules.innerEdgeClearanceMm || 0 : 0) + viaD / 2 + margin;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = X(i), y = Y(j), d = Math.min(x - br.x0, br.x1 - x, y - br.y0, br.y1 - y);
    LAY.forEach((l, k) => { if (d < eT[k]) base.t[l][j * nx + i] = BLOCK; });
    if (d < eV) base.v[j * nx + i] = BLOCK;
  }

  // ---- 通れるか ----
  const okCell = (o, id) => o === 0 || o === id;
  const freeT = (L, i, j, id, ex, relaxed) => {
    for (let dj = -ex; dj <= ex; dj++) for (let di = -ex; di <= ex; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) return false;
      const c = jj * nx + ii;
      if (!okCell(base.t[L][c], id)) return false;
      if (!relaxed && !okCell(run.t[L][c], id)) return false;
    }
    return true;
  };
  const freeV = (c, id, relaxed) => okCell(base.v[c], id) && (relaxed || okCell(run.v[c], id));
  const extraCells = (w) => Math.max(0, Math.ceil((w - W) / 2 / g));

  // ---- A* ----
  const VIA_COST = 1.2 / g; // ビア1個 ≒ 1.2mm 分の遠回り
  const TURN_COST = 0.3;
  const RUN_COST = 6;       // はがす前提で他の配線を横切る費用（1マスあたり）
  const gScore = new Float32Array(K * N), from = new Int32Array(K * N), seen = new Uint32Array(K * N);
  let stamp = 0;
  function search(src, dst, target, id, w, relaxed) {
    const isGoal = typeof dst === 'function' ? dst : (s) => dst.has(s);
    stamp++;
    const ex = extraCells(w);
    const heap = new Heap();
    const h = !target ? () => 0 : (s) => { const c = s % N, i = c % nx, j = (c / nx) | 0; const dx = Math.abs(X(i) - target.x) / g, dy = Math.abs(Y(j) - target.y) / g; return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy); };
    for (const s of src) { gScore[s] = 0; from[s] = -1; seen[s] = stamp; heap.push(h(s), s); }
    let n = 0;
    const crossing = (L, c) => (relaxed && !okCell(run.t[L][c], id) ? RUN_COST : 0);
    while (heap.size) {
      const s = heap.pop();
      if (isGoal(s)) return s;
      if (++n > maxNodesNow) return -1;
      const l = (s / N) | 0, c = s - l * N, i = c % nx, j = (c / nx) | 0, gs = gScore[s];
      const pf = from[s];
      let pdx = 0, pdy = 0;
      if (pf >= 0 && ((pf / N) | 0) === l) { const pc = pf - l * N; pdx = i - (pc % nx); pdy = j - ((pc / nx) | 0); }
      const L = LAY[l];
      for (const [di, dj] of DIRS) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        if (di && dj && (!freeT(L, ii, j, id, 0, relaxed) || !freeT(L, i, jj, id, 0, relaxed))) continue; // 角をかすめない
        if (!freeT(L, ii, jj, id, ex, relaxed)) continue;
        const cc = jj * nx + ii, t = l * N + cc;
        const cost = gs + (di && dj ? 1.4142 : 1) + ((pdx || pdy) && (pdx !== di || pdy !== dj) ? TURN_COST : 0) + crossing(L, cc);
        if (seen[t] === stamp && gScore[t] <= cost) continue;
        seen[t] = stamp; gScore[t] = cost; from[t] = s;
        heap.push(cost + h(t), t);
      }
      if (freeV(c, id, relaxed)) {
        const vc = relaxed && !okCell(run.v[c], id) ? RUN_COST * 4 : 0;
        for (let m = 0; m < K; m++) {
          if (m === l || !freeT(LAY[m], i, j, id, ex, relaxed)) continue;
          const t = m * N + c, cost = gs + VIA_COST + vc;
          if (!(seen[t] === stamp && gScore[t] <= cost)) { seen[t] = stamp; gScore[t] = cost; from[t] = s; heap.push(cost + h(t), t); }
        }
      }
    }
    return -1;
  }

  /** パッドの中のマス（パッドが載る配線層） */
  const padCells = (p, id, ex, relaxed) => {
    const out = [];
    const e2 = Math.max(p.pad.w, p.pad.h) / 2;
    const i0 = Math.max(0, Math.floor((p.x - e2 - br.x0) / g)), i1 = Math.min(nx - 1, Math.ceil((p.x + e2 - br.x0) / g));
    const j0 = Math.max(0, Math.floor((p.y - e2 - br.y0) / g)), j1 = Math.min(ny - 1, Math.ceil((p.y + e2 - br.y0) / g));
    for (let l = 0; l < K; l++) {
      if (!p.layers.includes(LAY[l])) continue;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (!pointInPad(p.inst, p.pad, X(i), Y(j), -0.01)) continue;
        if (freeT(LAY[l], i, j, id, ex, relaxed)) out.push(l * N + j * nx + i);
      }
    }
    return out;
  };

  // ---- 面（配線に使わない層のベタ）: 電源・GND のパッドは、近くにビアを打ってこの面につなげばよい ----
  const planeMask = new Map(); // ネット → このマスにビアを打てば面に届く（値 = 面の番号+1）
  const planeZones = []; // 面の番号 → ベタ
  if (opt.planes !== false) {
    for (const z of pcb.zones) {
      if (!z.net || LAY.includes(z.layer) || !cu.includes(z.layer)) continue;
      const ring = z.polygon.map((q) => ({ x: toMm(q.x), y: toMm(q.y) }));
      const m = planeMask.get(z.net) || new Uint16Array(N);
      planeZones.push(z);
      const pz = planeZones.length;
      const inset = toMm(z.clearance || 0) + viaD / 2 + 0.3;
      const xs = ring.map((q) => q.x), ys = ring.map((q) => q.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const i0 = Math.max(0, Math.floor((x0 - br.x0) / g)), i1 = Math.min(nx - 1, Math.ceil((x1 - br.x0) / g));
      const j0 = Math.max(0, Math.floor((y0 - br.y0) / g)), j1 = Math.min(ny - 1, Math.ceil((y1 - br.y0) / g));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = X(i), y = Y(j);
        if (!pointInRing({ x, y }, ring)) continue;
        // 外周から inset 以上内側
        let near = false;
        for (let q = 0; q < ring.length && !near; q++) { const a = ring[q], b = ring[(q + 1) % ring.length]; if (segD({ x, y }, a, b) < inset) near = true; }
        if (!near && !m[j * nx + i]) m[j * nx + i] = pz;
      }
      planeMask.set(z.net, m);
    }
  }
  // パッドの中（ビアをパッドに打たない。露出パッドは別）
  const inPad = new Uint8Array(N);
  for (const p of pads) {
    if (p.pad.w >= 1.5 && p.pad.h >= 1.5) continue;
    const e2 = Math.max(p.pad.w, p.pad.h) / 2 + 0.1;
    paint(inPad, p.x - e2, p.y - e2, p.x + e2, p.y + e2, 1, (x, y) => pointInPad(p.inst, p.pad, x, y, 0.05));
  }

  if (opt.debug) Object.assign(opt.debug, { base, get run() { return run; }, nx, ny, N, g, br, LAY, padCells, nid, freeT });
  // ---- 接続の一覧 ----
  // 配線に使う層のベタは、これから引く配線で分断されるので「つながり」に数えない（面としても使わない）
  const conn0 = computePcbConnectivity({ ...pcb, zones: pcb.zones.filter((z) => !LAY.includes(z.layer)) }, { rules });
  const want = opt.nets ? new Set(opt.nets) : null;
  const edges = conn0.ratsnest.filter((e) => !want || want.has(e.net)).map((e, k) => ({ ...e, k, len: Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y), rips: 0 }));
  // 面のあるネット: 面にまだつながっていないパッドごとに「近くのビアで面へ」を足す（短いので先に引かれる）
  // 面ごとに、実行前の接続計算での島の根（その面につながっているパッドを知るため）
  const planeRoots = planeZones.map((z) => {
    const set = new Set();
    const f = conn0.fills.get(z.id);
    f?.polygons.forEach((_, i) => { const r = conn0.groupOf(`z:${z.id}:${i}`); if (r !== undefined) set.add(r); });
    return set;
  });
  const planesOf = (p) => planeZones.map((z, i) => (z.net === p.net && planeRoots[i].has(conn0.groupOf(p.key)) ? i + 1 : 0)).filter(Boolean);
  const onPlane = (p) => planesOf(p).length > 0;
  for (const p of pads) {
    if (!planeMask.has(p.net) || (want && !want.has(p.net)) || onPlane(p)) continue;
    if (p.pad.w >= 1.5 && p.pad.h >= 1.5) continue; // 露出パッドは中のビアでつなぐ（別途）
    edges.push({ net: p.net, aKey: p.key, bKey: null, plane: true, k: edges.length, len: 0.3, rips: 0, a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } });
  }
  // 短い接続から（混む前に近いものを確実に）。seed を変えると順番を少し揺らして別の解を試せる
  let rnd = opt.seed ? (opt.seed * 2654435761) >>> 0 : 0;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  for (const e of edges) e.order = opt.seed ? e.len * (0.6 + 0.8 * rand()) : e.len;
  edges.sort((a, b) => a.order - b.order);

  // 島（つながっているパッドの集まり）。出発・到着は島のどのパッドでもよい（近い方から引ける）
  const isl = new DSU();
  const initIslands = () => {
    for (const p of pads) if (p.net) {
      isl.add(p.key); isl.add(`g:${conn0.groupOf(p.key)}`); isl.union(p.key, `g:${conn0.groupOf(p.key)}`);
      for (const k of planesOf(p)) { isl.add(`P:${k}`); isl.union(p.key, `P:${k}`); }
    }
  };
  initIslands();
  const netPads = new Map();
  for (const p of pads) if (p.net) (netPads.get(p.net) || netPads.set(p.net, []).get(p.net)).push(p);
  const islandOf = (p) => netPads.get(p.net).filter((q) => isl.find(q.key) === isl.find(p.key));
  const committed = new Map(); // 接続番号 → { edge, tracks, vias, segs, viaPts, w }
  const repaintRun = () => {
    resetRun();
    for (const [k, c] of committed) {
      const id = nid(c.edge.net);
      for (const sg of c.segs) paintTrack(run, sg.L, sg.a, sg.b, c.w, id, k + 1);
      for (const v of c.viaPts) paintVia(run, v, id, k + 1);
    }
  };
  const rip = (k) => {
    const c = committed.get(k);
    if (!c) return;
    const tIds = new Set(c.tracks.map((t) => t.id)), vIds = new Set(c.vias.map((v) => v.id));
    pcb.tracks = pcb.tracks.filter((t) => !tIds.has(t.id));
    pcb.vias = pcb.vias.filter((v) => !vIds.has(v.id));
    committed.delete(k);
    rebuildIslands();
  };
  function rebuildIslands() {
    isl.p.clear();
    initIslands();
    for (const c of committed.values()) { isl.add(c.from); isl.add(c.to); isl.union(c.from, c.to); }
  }

  /** 経路（マスの列）を配線・ビアにして PCB に書く */
  function commit(e, end, w, pa, pb) {
    const cells = [];
    for (let s = end; s >= 0; s = from[s]) cells.push(s);
    cells.reverse();
    const pts = cells.map((s) => { const c = s % N; return { l: (s / N) | 0, x: +X(c % nx).toFixed(4), y: +Y((c / nx) | 0).toFixed(4) }; });
    // パッドの中心から出てパッドの中心に入る（パッドの中なので間隔は問題ない）
    const runs = [];
    let cur = { l: pts[0].l, pts: [{ x: pa.x, y: pa.y }, pts[0]] };
    for (let q = 1; q < pts.length; q++) {
      if (pts[q].l !== cur.l) { runs.push(cur); cur = { l: pts[q].l, pts: [pts[q - 1], pts[q]], via: pts[q] }; continue; }
      cur.pts.push(pts[q]);
    }
    if (pb) cur.pts.push({ x: pb.x, y: pb.y });
    runs.push(cur);
    const c = { edge: e, tracks: [], vias: [], segs: [], viaPts: [], w };
    const id = nid(e.net);
    for (const r of runs) {
      const simp = simplify(r.pts);
      const L = LAY[r.l];
      c.tracks.push(...addTrackPath(pcb, simp, L, toNm(w), e.net));
      for (let q = 1; q < simp.length; q++) { c.segs.push({ L, a: simp[q - 1], b: simp[q] }); paintTrack(run, L, simp[q - 1], simp[q], w, id, e.k + 1); }
      if (r.via) { c.vias.push(addVia(pcb, r.via.x, r.via.y, e.net)); c.viaPts.push(r.via); paintVia(run, r.via, id, e.k + 1); }
    }
    if (!pb) { const v = pts[pts.length - 1]; c.vias.push(addVia(pcb, v.x, v.y, e.net)); c.viaPts.push(v); paintVia(run, v, id, e.k + 1); }
    c.from = pa.key; c.to = pb ? pb.key : `P:${planeMask.get(e.net)[cells[cells.length - 1] % N]}`;
    if (!pb) isl.add(c.to);
    committed.set(e.k, c);
    isl.union(c.from, c.to);
  }

  /** 経路が通るマス（線幅分の周り・層を移る位置）にある、この実行の他ネットの接続 */
  function blockers(end, id, ex) {
    const vs = new Set();
    let prevL = -1;
    for (let s = end; s >= 0; s = from[s]) {
      const l = (s / N) | 0, c = s - l * N, i = c % nx, j = (c / nx) | 0, L = LAY[l];
      for (let dj = -ex; dj <= ex; dj++) for (let di = -ex; di <= ex; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const cc = jj * nx + ii;
        if (!okCell(run.t[L][cc], id) && own.t[L][cc]) vs.add(own.t[L][cc] - 1);
      }
      if (prevL >= 0 && prevL !== l && !okCell(run.v[c], id) && own.v[c]) vs.add(own.v[c] - 1);
      prevL = l;
    }
    return [...vs].filter((k) => committed.has(k) && nid(committed.get(k).edge.net) !== id);
  }

  /** 1本引く。通らなければ、この実行の配線を横切る経路を探し、邪魔な接続をはがす */
  function routeEdge(e, allowRip) {
    if (e.plane) return routePlane(e, allowRip);
    const pa0 = padByKey.get(e.aKey), pb0 = padByKey.get(e.bKey);
    if (isl.find(pa0.key) === isl.find(pb0.key)) return { ok: true, ripped: [] }; // 既にほかの経路でつながった
    const A = islandOf(pa0), B = islandOf(pb0);
    const id = nid(e.net);
    // セル → パッド（経路の両端がどのパッドか）
    let cellPad;
    const cellsOf = (list, ex, relaxed) => { const out = []; for (const p of list) for (const c of padCells(p, id, ex, relaxed)) { out.push(c); cellPad.set(c, p); } return out; };
    const tryOnce = (w, relaxed) => {
      cellPad = new Map();
      const ex = extraCells(w);
      const src = cellsOf(A.filter((p) => w <= Math.min(p.pad.w, p.pad.h) || w === W || need > 0), ex, relaxed);
      const dst = cellsOf(B.filter((p) => w <= Math.min(p.pad.w, p.pad.h) || w === W || need > 0), ex, relaxed);
      if (!src.length || !dst.length) return null;
      const end = search(src, new Set(dst), { x: pb0.x, y: pb0.y }, id, w, relaxed);
      if (end < 0) return null;
      let s0 = end; while (from[s0] >= 0) s0 = from[s0];
      return { end, pa: cellPad.get(s0), pb: cellPad.get(end) };
    };
    // 電流を設定したネットは必要な線幅だけで引く（細い線に逃げない）
    const need = opt.netWidth ? opt.netWidth(e.net) : 0;
    // 電流の決まったネット・電源は、まず太め（powerWidth）で引き、通らなければ必要な幅ちょうどまで細くする（必要な幅より細くはしない）
    const min = need > 0 ? Math.max(W, Math.ceil(need * 1000) / 1000) : W;
    const widths = (need > 0 || isPower(e.net)) && PW > min ? [PW, min] : [min];
    for (const w of widths) {
      const r = tryOnce(w, false);
      if (r) { commit(e, r.end, w, r.pa, r.pb); return { ok: true, ripped: [] }; }
    }
    if (!allowRip) return { ok: false, ripped: [] };
    const ripped = [];
    // 横切った相手をはがす → 厳密に探し直す、を数回（own は最後に塗った接続しか覚えていないので、残りは次の回で見つける）
    for (let round = 0; round < 4; round++) {
      const r = tryOnce(W, true);
      if (!r) break;
      const vs = blockers(r.end, id, extraCells(W));
      if (!vs.length) break;
      for (const k of vs) { rip(k); ripped.push(k); }
      repaintRun();
      if (isl.find(pa0.key) === isl.find(pb0.key)) return { ok: true, ripped };
      const r2 = tryOnce(W, false);
      if (r2) { commit(e, r2.end, W, r2.pa, r2.pb); return { ok: true, ripped }; }
    }
    return { ok: false, ripped };
  }

  /** パッド → 近くのビア → 面 */
  function routePlane(e, allowRip) {
    const pa = padByKey.get(e.aKey);
    if (planeZones.some((z, i) => z.net === e.net && isl.p.has(`P:${i + 1}`) && isl.find(pa.key) === isl.find(`P:${i + 1}`))) return { ok: true, ripped: [] };
    const id = nid(e.net), mask = planeMask.get(e.net);
    const goal = (relaxed) => (s) => { const c = s % N; return mask[c] > 0 && !inPad[c] && freeV(c, id, relaxed); };
    // 電流を設定したネットは、面へのビアまでの引き出しも必要な線幅で
    const need = opt.netWidth ? opt.netWidth(e.net) : 0;
    const PWn = need > 0 ? Math.max(W, Math.ceil(need * 1000) / 1000) : W;
    const ex = extraCells(PWn);
    const saved = maxNodesNow; maxNodesNow = 60000; // 面へは近くで見つかるはず
    try {
      const src = padCells(pa, id, ex, false);
      if (src.length) {
        const end = search(src, goal(false), null, id, PWn, false);
        if (end >= 0) { commit(e, end, PWn, pa, null); return { ok: true, ripped: [] }; }
      }
      if (!allowRip) return { ok: false, ripped: [] };
      const srcR = padCells(pa, id, ex, true);
      if (!srcR.length) return { ok: false, ripped: [] };
      const end = search(srcR, goal(true), null, id, PWn, true);
      if (end < 0) return { ok: false, ripped: [] };
      const vs = blockers(end, id, ex);
      // ビアの位置の相手も
      const c = end % N; if (!okCell(run.v[c], id) && own.v[c] && committed.has(own.v[c] - 1)) vs.push(own.v[c] - 1);
      const ripped = [...new Set(vs)];
      if (!ripped.length) return { ok: false, ripped: [] };
      for (const k of ripped) rip(k);
      repaintRun();
      const end2 = search(padCells(pa, id, ex, false), goal(false), null, id, PWn, false);
      if (end2 >= 0) { commit(e, end2, PWn, pa, null); return { ok: true, ripped }; }
      return { ok: false, ripped };
    } finally { maxNodesNow = saved; }
  }

  const maxRips = opt.maxRips ?? 300;
  let rips = 0, done = 0;
  const queue = edges.slice();
  const failed = new Map();
  const byK = new Map(edges.map((e) => [e.k, e]));
  const total = edges.length;
  while (queue.length) {
    const e = queue.shift();
    if (committed.has(e.k)) continue;
    const r = routeEdge(e, rips < maxRips && e.rips < 4);
    for (const k of r.ripped) { const v = byK.get(k); v.rips++; rips++; queue.push(v); }
    if (r.ok) failed.delete(e.k);
    else failed.set(e.k, e);
    done++;
    opt.onProgress?.(Math.min(done, total), total, e.net);
    if (opt.yieldEvery && done % opt.yieldEvery === 0) await new Promise((res) => setTimeout(res, 0));
    if (opt.signal?.aborted) break;
  }
  // 引けなかったものを最後にもう一度（はがしなし）
  for (const e of [...failed.values()]) if (!committed.has(e.k) && routeEdge(e, false).ok) failed.delete(e.k);
  for (const k of [...failed.keys()]) if (committed.has(k)) failed.delete(k);

  fillAllZones(pcb, rules);
  return {
    routed: [...committed.values()].map((c) => ({ net: c.edge.net, width: c.w })),
    failed: [...failed.values()].map((e) => { const pa = padByKey.get(e.aKey), pb = e.bKey && padByKey.get(e.bKey); return { net: e.net, a: `${pa.ref}-${pa.pad.num}`, b: pb ? `${pb.ref}-${pb.pad.num}` : '内層の面' }; }),
    tracks: [...committed.values()].reduce((s, c) => s + c.tracks.length, 0),
    vias: [...committed.values()].reduce((s, c) => s + c.vias.length, 0),
    rips,
  };
}

/** 一直線に並んだ点を間引く */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 1e-9 && Math.abs(out[out.length - 1].y - p.y) < 1e-9) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const cr = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cr) < 1e-9 && dot >= 0) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}
