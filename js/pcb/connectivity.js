// PCB の接続計算とラッツネスト（未配線の接続を示す線）
// 接続とみなすもの:
//  - 配線の端点がパッドの銅箔内（同じ層。スルーホールは両層）
//  - 配線の端点が、同じ層の他の配線の端点または線上（線幅の半分以内）
//  - 配線の端点・パッドがビアの銅箔内（ビアは両層）
//  - ベタ: 塗りつぶし計算（zonefill.js）の結果の「島」ごとに、そのネットのパッド中心・ビア・配線端点が島の中にあれば接続
//    （クリアランスで分断された島どうしはつながらない）
// 配線のネットは「始点のネット」で付けるが、接続はすべて形状から計算し直す。

import { allPads, pointInPad, distToSeg, toMm } from './model.js';
import { cachedFills, pointInPolyWithHoles } from './zonefill.js';
import { DSU } from '../core/util.js';


const mm = (q) => ({ x: toMm(q.x), y: toMm(q.y) });
const EPS = 1e-4; // 0.1µm

/** @param opt { rules: 設計ルール（ベタのクリアランス）, allowStaleFill: ドラッグ中は前回の塗りつぶしを使う } */
export function computePcbConnectivity(pcb, { rules = {}, allowStaleFill = false } = {}) {
  const dsu = new DSU();
  const pads = allPads(pcb);
  const tracks = pcb.tracks.map((t) => ({ t, a: mm(t.a), b: mm(t.b), hw: toMm(t.width) / 2 }));
  const vias = pcb.vias.map((v) => ({ v, c: mm(v), r: toMm(v.diameter) / 2 }));
  pads.forEach((p) => dsu.add(p.key));
  tracks.forEach(({ t }) => dsu.add(`t:${t.id}`));
  vias.forEach(({ v }) => dsu.add(`v:${v.id}`));

  // 配線の端点
  for (const tr of tracks) {
    const key = `t:${tr.t.id}`;
    for (const e of [tr.a, tr.b]) {
      for (const p of pads) if (p.layers.includes(tr.t.layer) && pointInPad(p.inst, p.pad, e.x, e.y)) dsu.union(key, p.key);
      for (const o of tracks) {
        if (o === tr || o.t.layer !== tr.t.layer) continue;
        if (distToSeg(e, o.a, o.b) <= Math.max(EPS, o.hw)) dsu.union(key, `t:${o.t.id}`);
      }
      for (const vi of vias) if (Math.hypot(e.x - vi.c.x, e.y - vi.c.y) <= vi.r + EPS) dsu.union(key, `v:${vi.v.id}`);
    }
  }
  // ビアとパッドの重なり（パッド上のビア）
  for (const vi of vias) for (const p of pads) if (pointInPad(p.inst, p.pad, vi.c.x, vi.c.y)) dsu.union(`v:${vi.v.id}`, p.key);
  // ベタ（塗りつぶしの島ごと）
  const { fills, stale: fillStale } = cachedFills(pcb, rules, { allowStale: allowStaleFill });
  for (const z of pcb.zones) {
    const f = fills.get(z.id);
    if (!z.net || !f) continue;
    f.polygons.forEach((poly, i) => {
      const key = `z:${z.id}:${i}`;
      dsu.add(key);
      for (const p of pads) if (p.net === z.net && p.layers.includes(z.layer) && pointInPolyWithHoles(p, poly)) dsu.union(key, p.key);
      for (const vi of vias) if (vi.v.net === z.net && pointInPolyWithHoles(vi.c, poly)) dsu.union(key, `v:${vi.v.id}`);
      for (const tr of tracks) if (tr.t.layer === z.layer && tr.t.net === z.net && (pointInPolyWithHoles(tr.a, poly) || pointInPolyWithHoles(tr.b, poly))) dsu.union(key, `t:${tr.t.id}`);
    });
  }

  // ネットごとにパッドの島を作り、島どうしを最短で結ぶ（最小全域木）
  const byNet = new Map();
  for (const p of pads) {
    if (!p.net) continue;
    if (!byNet.has(p.net)) byNet.set(p.net, []);
    byNet.get(p.net).push(p);
  }
  const ratsnest = [];
  const netStatus = {};
  for (const [net, list] of byNet) {
    const islands = new Map();
    for (const p of list) {
      const r = dsu.find(p.key);
      if (!islands.has(r)) islands.set(r, []);
      islands.get(r).push(p);
    }
    const isl = [...islands.values()];
    netStatus[net] = { pads: list.length, islands: isl.length };
    if (isl.length < 2) continue;
    // Prim 法（島間距離 = 最も近いパッド対）
    const inTree = new Set([0]);
    while (inTree.size < isl.length) {
      let best = null;
      for (const i of inTree) for (let j = 0; j < isl.length; j++) {
        if (inTree.has(j)) continue;
        for (const a of isl[i]) for (const b of isl[j]) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (!best || d < best.d) best = { d, j, a, b };
        }
      }
      inTree.add(best.j);
      ratsnest.push({ net, a: { x: best.a.x, y: best.a.y }, b: { x: best.b.x, y: best.b.y }, aKey: best.a.key, bKey: best.b.key });
    }
  }

  // 異なるネットのパッドが銅でつながっている＝短絡（第5段階DRCで詳しく検査）
  const netsOfGroup = new Map();
  for (const p of pads) {
    if (!p.net) continue;
    const r = dsu.find(p.key);
    if (!netsOfGroup.has(r)) netsOfGroup.set(r, new Set());
    netsOfGroup.get(r).add(p.net);
  }
  const shorts = [...netsOfGroup.values()].filter((s) => s.size > 1).map((s) => [...s].sort());

  return { ratsnest, unrouted: ratsnest.length, netStatus, shorts, groupOf: (key) => dsu.find(key), fills, fillStale };
}

/** 点 p(mm) に接続できる対象（パッド中心・配線端点・ビア）を探して吸着点とネットを返す */
export function snapTarget(pcb, p, tol, layer) {
  let best = null;
  const consider = (x, y, net, kind, key) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= tol && (!best || d < best.d)) best = { x, y, net, kind, key, d };
  };
  for (const pad of allPads(pcb)) {
    if (!pad.layers.includes(layer)) continue;
    if (pointInPad(pad.inst, pad.pad, p.x, p.y)) consider(pad.x, pad.y, pad.net, 'pad', pad.key);
    else consider(pad.x, pad.y, pad.net, 'pad', pad.key);
  }
  for (const v of pcb.vias) consider(toMm(v.x), toMm(v.y), v.net, 'via', `v:${v.id}`);
  for (const t of pcb.tracks) {
    if (t.layer !== layer) continue;
    consider(toMm(t.a.x), toMm(t.a.y), t.net, 'track', `t:${t.id}`);
    consider(toMm(t.b.x), toMm(t.b.y), t.net, 'track', `t:${t.id}`);
  }
  // パッドの銅箔内をタップしたら、距離に関係なくそのパッド
  if (!best || best.kind !== 'pad') {
    for (const pad of allPads(pcb)) {
      if (pad.layers.includes(layer) && pointInPad(pad.inst, pad.pad, p.x, p.y)) return { x: pad.x, y: pad.y, net: pad.net, kind: 'pad', key: pad.key, d: 0 };
    }
  }
  return best;
}
