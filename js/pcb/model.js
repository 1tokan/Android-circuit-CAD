// PCB のデータと操作（純粋関数。DOM に依存しない）
// 保存座標は nm 整数（丸め誤差を製造データに持ち込まない）。計算・表示は mm の実数で行う。
// 層: 'F.Cu' 表銅 / 'In1.Cu'〜'In4.Cu' 内層（4・6層のとき）/ 'B.Cu' 裏銅 / 'F.SilkS' 'B.SilkS' シルク / 'Edge.Cuts' 外形
// 層数は pcb.settings.layers（2・4・6）。ビアとスルーホールは全層を貫通する（ブラインド・ベリードビアは扱わない）

import { newId } from '../core/project.js';
import { pointSegDist as distToSeg, pointInRing as pointInPolygon } from '../core/geom2d.js';

export const NM = 1e6;
export const toNm = (mm) => Math.round(Number(mm) * NM);
export const toMm = (nm) => nm / NM;
/** 銅箔層の一覧（表から裏の順） */
export function copperLayers(pcbOrCount) {
  const n = typeof pcbOrCount === 'number' ? pcbOrCount : pcbOrCount?.settings?.layers || 2;
  return ['F.Cu', ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => `In${i + 1}.Cu`), 'B.Cu'];
}
/** 層の表示名 */
export function layerName(layer) {
  return layer === 'F.Cu' ? '表' : layer === 'B.Cu' ? '裏' : /^In(\d)\.Cu$/.test(layer) ? `内層${layer[2]}` : layer;
}
/** 表裏を入れ替えたときの層（内層も上下を反転） */
export function mirrorLayer(layer, pcb) {
  const cu = copperLayers(pcb);
  const i = cu.indexOf(layer);
  return i < 0 ? layer : cu[cu.length - 1 - i];
}

/** 既定値で補った PCB データ（旧形式・空データにも対応） */
export function ensurePcb(project) {
  const p = project.pcb || {};
  if (p.version === 2 && p.settings && p.outline && !Array.isArray(p.outline)) return p; // 既に新形式（同じオブジェクトを返す）
  const out = {
    version: 2,
    outline: p.outline && !Array.isArray(p.outline) ? p.outline : { type: 'rect', x: 0, y: 0, w: toNm(50), h: toNm(40) },
    footprints: Array.isArray(p.footprints) ? p.footprints : [],
    tracks: Array.isArray(p.tracks) ? p.tracks : [],
    vias: Array.isArray(p.vias) ? p.vias : [],
    zones: Array.isArray(p.zones) ? p.zones : [],
    texts: Array.isArray(p.texts) ? p.texts : [],
    holes: Array.isArray(p.holes) ? p.holes : [],
    settings: {
      trackWidth: toNm(0.25),
      viaDiameter: toNm(0.6),
      viaDrill: toNm(0.3),
      grid: toNm(0.25),
      layers: 2,
      angleMode: '45',
      ...(p.settings || {}),
    },
    netlistHash: p.netlistHash || null,
  };
  project.pcb = out;
  return out;
}

// ---------------- 座標変換 ----------------
/** フットプリント内の座標(mm) → 基板座標(mm)。裏面は左右反転してから回転 */
export function fpToBoard(inst, lx, ly) {
  const x = inst.side === 'bottom' ? -lx : lx;
  const a = ((inst.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: toMm(inst.x) + x * c - ly * s, y: toMm(inst.y) + x * s + ly * c };
}
/** 基板座標(mm) → フットプリント内の座標(mm) */
export function boardToFp(inst, bx, by) {
  const dx = bx - toMm(inst.x), dy = by - toMm(inst.y);
  const a = (-(inst.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return { x: inst.side === 'bottom' ? -x : x, y };
}

/**
 * パッドの穴（フットプリント内の座標）。丸穴は a=b、長穴は両端の中心。d は穴の幅
 * 長穴は pad.slot = { w, h }（パッドの向きでの長穴の外形）。drill は短い方
 */
export function padHoleLocal(pad) {
  if (!pad.slot) return { a: { x: pad.x, y: pad.y }, b: { x: pad.x, y: pad.y }, d: pad.drill };
  const { w, h } = pad.slot, d = Math.min(w, h), half = (Math.max(w, h) - d) / 2;
  return w >= h ? { a: { x: pad.x - half, y: pad.y }, b: { x: pad.x + half, y: pad.y }, d } : { a: { x: pad.x, y: pad.y - half }, b: { x: pad.x, y: pad.y + half }, d };
}
/** パッドの穴（基板座標 mm） */
export function padHole(inst, pad) {
  const l = padHoleLocal(pad);
  return { a: fpToBoard(inst, l.a.x, l.a.y), b: fpToBoard(inst, l.b.x, l.b.y), d: l.d, slot: !!pad.slot };
}
/** 穴の SVG（丸穴は円、長穴は丸端の線） */
export function holeSvg(h, cls) {
  if (h.a.x === h.b.x && h.a.y === h.b.y) return `<circle class="${cls}" cx="${h.a.x}" cy="${h.a.y}" r="${h.d / 2}"/>`;
  return `<path class="${cls} slot" d="M${h.a.x} ${h.a.y}L${h.b.x} ${h.b.y}" stroke-width="${h.d}" stroke-linecap="round"/>`;
}

export function padLayers(inst, pad, cu = ['F.Cu', 'B.Cu']) {
  if (pad.type === 'tht') return cu;
  return [inst.side === 'bottom' ? 'B.Cu' : 'F.Cu'];
}

/** 点(mm, 基板座標)がパッドの銅箔内か */
export function pointInPad(inst, pad, bx, by, grow = 0) {
  const l = boardToFp(inst, bx, by);
  const dx = Math.abs(l.x - pad.x), dy = Math.abs(l.y - pad.y);
  const hw = pad.w / 2 + grow, hh = pad.h / 2 + grow;
  if (pad.shape === 'circle') return Math.hypot(dx, dy) <= Math.max(hw, hh);
  if (pad.shape === 'oval') {
    const r = Math.min(hw, hh);
    const ex = Math.max(0, dx - (hw - r)), ey = Math.max(0, dy - (hh - r));
    return Math.hypot(ex, ey) <= r;
  }
  return dx <= hw && dy <= hh;
}

/** 全パッドの一覧（基板座標 mm・層・ネット） */
export function allPads(pcb) {
  const out = [];
  const cu = copperLayers(pcb);
  for (const inst of pcb.footprints) {
    inst.fpDef.pads.forEach((pad, k) => {
      const c = fpToBoard(inst, pad.x, pad.y);
      out.push({ key: `p:${inst.id}:${k}`, inst, pad, k, x: c.x, y: c.y, layers: padLayers(inst, pad, cu), net: inst.padNets?.[pad.num] || null, ref: inst.ref });
    });
  }
  return out;
}

// ---------------- 基板外形 ----------------
export function boardRect(pcb) {
  const o = pcb.outline;
  return { x0: toMm(o.x), y0: toMm(o.y), x1: toMm(o.x + o.w), y1: toMm(o.y + o.h) };
}
export function boardSizeText(pcb) {
  const o = pcb.outline;
  return `${toMm(o.w).toFixed(1)} × ${toMm(o.h).toFixed(1)} mm`;
}

// ---------------- ネットリスト取込 ----------------
/**
 * ネットリストを PCB に反映する。
 *  - 回路図の部品ID（無ければ部品番号）で既存のフットプリントと対応づけ、位置は保つ
 *  - フットプリント定義はその時点のものを各部品に保存（後で生成ロジックが変わっても配置済みの形を変えない）
 *  - 新しい部品は基板の下側に並べる
 *  - ネットリストに無くなった部品は削除（配線は残す）
 * @param resolveFp (component) => フットプリント定義 | null
 */
export function importNetlist(pcb, nl, resolveFp) {
  const report = { added: [], updated: [], removed: [], noFootprint: [], fpChanged: [] };
  const padNetsOf = new Map();
  for (const n of nl.nets) for (const node of n.nodes) {
    if (!padNetsOf.has(node.ref)) padNetsOf.set(node.ref, {});
    padNetsOf.get(node.ref)[node.pad] = n.name;
  }
  const byComp = new Map(pcb.footprints.map((f) => [f.compId || `ref:${f.ref}`, f]));
  const byRef = new Map(pcb.footprints.map((f) => [f.ref, f]));
  const keep = new Set();
  const br = boardRect(pcb);
  let col = 0;
  for (const c of nl.components) {
    const def = resolveFp(c);
    if (!def) { report.noFootprint.push(c.ref); continue; }
    const snap = JSON.parse(JSON.stringify({ id: def.id, name: def.name, package: def.package || '', pads: def.pads, body: def.body, courtyard: def.courtyard, generated: !!def.generated, verified: !!def.verified }));
    let inst = (c.compId && byComp.get(c.compId)) || byRef.get(c.ref);
    if (inst) {
      if (inst.fpDef.id !== snap.id || JSON.stringify(inst.fpDef.pads) !== JSON.stringify(snap.pads) || JSON.stringify(inst.fpDef.body) !== JSON.stringify(snap.body)) { inst.fpDef = snap; report.fpChanged.push(c.ref); }
      inst.ref = c.ref; inst.value = c.value; inst.compId = c.compId || inst.compId;
      inst.padNets = padNetsOf.get(c.ref) || {};
      inst.lcsc = c.lcsc; inst.dnp = !!c.dnp;
      report.updated.push(c.ref);
    } else {
      const w = Math.max(2, snap.courtyard.x1 - snap.courtyard.x0), h = Math.max(2, snap.courtyard.y1 - snap.courtyard.y0);
      inst = {
        id: newId('f'), compId: c.compId || null, ref: c.ref, value: c.value, lcsc: c.lcsc, dnp: !!c.dnp,
        // 新しい部品は基板の下に並べる（位置はグリッドに乗せる）
        fpDef: snap, x: toNm(snapMm(br.x0 + 2 + col + w / 2, toMm(pcb.settings.grid))), y: toNm(snapMm(br.y1 + 4 + h / 2, toMm(pcb.settings.grid))), rot: 0, side: 'top', locked: false,
        padNets: padNetsOf.get(c.ref) || {},
      };
      col += w + 2;
      pcb.footprints.push(inst);
      report.added.push(c.ref);
    }
    keep.add(inst.id);
  }
  report.removed = pcb.footprints.filter((f) => !keep.has(f.id)).map((f) => f.ref);
  pcb.footprints = pcb.footprints.filter((f) => keep.has(f.id));
  pcb.netlistHash = nl.sourceHash;
  return report;
}

// ---------------- 配線の経路（45°・90°・自由） ----------------
/**
 * a→b の経路。'45': 直線＋45°斜め（diagonalFirst で順序入替）/ '90': L字 / 'free': 直線
 */
export function routePath(a, b, mode = '45', diagonalFirst = false) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (mode === 'free' || dx === 0 || dy === 0) return [a, b];
  if (mode === '90') return diagonalFirst ? [a, { x: a.x, y: b.y }, b] : [a, { x: b.x, y: a.y }, b];
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (Math.abs(adx - ady) < 1e-9) return [a, b];
  const d = Math.min(adx, ady);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const straight = adx > ady ? { x: sx * (adx - d), y: 0 } : { x: 0, y: sy * (ady - d) };
  const mid = diagonalFirst ? { x: a.x + sx * d, y: a.y + sy * d } : { x: a.x + straight.x, y: a.y + straight.y };
  return [a, mid, b];
}

export const snapMm = (v, gridMm) => Math.round(v / gridMm) * gridMm;

// ---------------- 追加 ----------------
/** 点列（mm）を配線にする。長さ0は作らない。追加した配線を返す */
export function addTrackPath(pcb, pts, layer, widthNm, net) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = { x: toNm(pts[i - 1].x), y: toNm(pts[i - 1].y) }, b = { x: toNm(pts[i].x), y: toNm(pts[i].y) };
    if (a.x === b.x && a.y === b.y) continue;
    const t = { id: newId('t'), layer, width: widthNm, a, b, net: net || null };
    pcb.tracks.push(t);
    out.push(t);
  }
  return out;
}

export function addVia(pcb, x, y, net) {
  const v = { id: newId('v'), x: toNm(x), y: toNm(y), diameter: pcb.settings.viaDiameter, drill: pcb.settings.viaDrill, net: net || null };
  pcb.vias.push(v);
  return v;
}

/** 基板外形から縁のクリアランス分内側の長方形ベタ */
export function addBoardZone(pcb, layer, net, edgeClearanceMm = 0.5) {
  const r = boardRect(pcb);
  const e = edgeClearanceMm;
  const poly = [[r.x0 + e, r.y0 + e], [r.x1 - e, r.y0 + e], [r.x1 - e, r.y1 - e], [r.x0 + e, r.y1 - e]].map(([x, y]) => ({ x: toNm(x), y: toNm(y) }));
  const z = { id: newId('z'), layer, net, polygon: poly, clearance: toNm(0.3), minWidth: toNm(0.25), filled: false };
  pcb.zones.push(z);
  return z;
}

export function addText(pcb, x, y, text, layer = 'F.SilkS', sizeMm = 1) {
  const t = { id: newId('x'), layer, text: String(text), x: toNm(x), y: toNm(y), size: toNm(sizeMm), rot: 0 };
  pcb.texts.push(t);
  return t;
}

export function addHole(pcb, x, y, drillMm = 3.2) {
  const h = { id: newId('h'), x: toNm(x), y: toNm(y), drill: toNm(drillMm) };
  pcb.holes.push(h);
  return h;
}

export function setOutlineRect(pcb, wMm, hMm) {
  pcb.outline = { ...pcb.outline, type: 'rect', w: toNm(wMm), h: toNm(hMm) };
}

// ---------------- 選択・ヒットテスト ----------------
export { pointSegDist as distToSeg } from '../core/geom2d.js';
const mmPt = (q) => ({ x: toMm(q.x), y: toMm(q.y) });

/** フットプリントの外接矩形（基板座標 mm） */
export function fpBox(inst) {
  const c = inst.fpDef.courtyard;
  const pts = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].map(([x, y]) => fpToBoard(inst, x, y));
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
}

/**
 * 点 p(mm) の要素キー。優先: ビア > 配線(作業層) > 文字 > 穴 > フットプリント > 配線(他層) > ベタ
 * キー: 'f:'フットプリント 't:'配線 'v:'ビア 'z:'ベタ 'x:'文字 'h:'穴
 */
export function hitTest(pcb, p, tol, activeLayer = 'F.Cu') {
  for (const v of pcb.vias) if (Math.hypot(p.x - toMm(v.x), p.y - toMm(v.y)) <= toMm(v.diameter) / 2 + tol) return `v:${v.id}`;
  const trackHit = (layerOk) => {
    let best = null, bd = Infinity;
    for (const t of pcb.tracks) {
      if (!layerOk(t.layer)) continue;
      const d = distToSeg(p, mmPt(t.a), mmPt(t.b));
      if (d <= toMm(t.width) / 2 + tol && d < bd) { bd = d; best = `t:${t.id}`; }
    }
    return best;
  };
  // パッドの銅箔上・部品本体の範囲内なら部品（配線が下を通っていても部品を選べるように）
  for (const f of pcb.footprints) {
    for (const pad of f.fpDef.pads) if (pointInPad(f, pad, p.x, p.y)) return `f:${f.id}`;
    const b = f.fpDef.body;
    if (b) { const l = boardToFp(f, p.x, p.y); if (Math.abs(l.x - (b.cx || 0)) <= b.w / 2 && Math.abs(l.y - (b.cy || 0)) <= b.h / 2) return `f:${f.id}`; }
  }
  const tAct = trackHit((l) => l === activeLayer);
  if (tAct) return tAct;
  for (const t of pcb.texts) {
    const s = toMm(t.size), w = s * 0.7 * t.text.length;
    if (Math.abs(p.x - toMm(t.x)) <= w / 2 + tol && Math.abs(p.y - toMm(t.y)) <= s / 2 + tol) return `x:${t.id}`;
  }
  for (const h of pcb.holes) if (Math.hypot(p.x - toMm(h.x), p.y - toMm(h.y)) <= toMm(h.drill) / 2 + tol) return `h:${h.id}`;
  let best = null, area = Infinity;
  for (const f of pcb.footprints) {
    const b = fpBox(f);
    if (p.x >= b.x0 - tol && p.x <= b.x1 + tol && p.y >= b.y0 - tol && p.y <= b.y1 + tol) {
      const a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (a < area) { area = a; best = `f:${f.id}`; }
    }
  }
  if (best) return best;
  const tOther = trackHit(() => true);
  if (tOther) return tOther;
  for (const z of pcb.zones) if (pointInPolygon(p, z.polygon.map(mmPt))) return `z:${z.id}`;
  return null;
}

export { pointInRing as pointInPolygon } from '../core/geom2d.js';

export function itemsInRect(pcb, a, b) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inR = (q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
  const out = new Set();
  pcb.footprints.forEach((f) => { const bx = fpBox(f); if (bx.x0 >= x0 && bx.x1 <= x1 && bx.y0 >= y0 && bx.y1 <= y1) out.add(`f:${f.id}`); });
  pcb.tracks.forEach((t) => { if (inR(mmPt(t.a)) && inR(mmPt(t.b))) out.add(`t:${t.id}`); });
  pcb.vias.forEach((v) => { if (inR(mmPt(v))) out.add(`v:${v.id}`); });
  pcb.texts.forEach((t) => { if (inR(mmPt(t))) out.add(`x:${t.id}`); });
  pcb.holes.forEach((h) => { if (inR(mmPt(h))) out.add(`h:${h.id}`); });
  return out;
}

const LIST = { f: 'footprints', t: 'tracks', v: 'vias', z: 'zones', x: 'texts', h: 'holes' };
export function findItem(pcb, key) {
  const [k, id] = [key[0], key.slice(2)];
  return pcb[LIST[k]]?.find((o) => o.id === id) || null;
}

// ---------------- 変形 ----------------
export function moveSelection(pcb, sel, dxMm, dyMm) {
  const dx = toNm(dxMm), dy = toNm(dyMm);
  if (!dx && !dy) return false;
  let moved = false;
  for (const key of sel) {
    const o = findItem(pcb, key);
    if (!o || o.locked) continue;
    if (key[0] === 't') { o.a = { x: o.a.x + dx, y: o.a.y + dy }; o.b = { x: o.b.x + dx, y: o.b.y + dy }; }
    else if (key[0] === 'z') o.polygon = o.polygon.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    else { o.x += dx; o.y += dy; }
    moved = true;
  }
  return moved;
}

/** フットプリント・文字は自身の原点で回転、配線は選択の中心で回転 */
export function rotateSelection(pcb, sel, deg = 90) {
  let changed = false;
  const tracks = [...sel].filter((k) => k[0] === 't').map((k) => findItem(pcb, k)).filter(Boolean);
  for (const key of sel) {
    const o = findItem(pcb, key);
    if (!o || o.locked) continue;
    if (key[0] === 'f' || key[0] === 'x') { o.rot = (((o.rot || 0) + deg) % 360 + 360) % 360; changed = true; }
  }
  if (tracks.length) {
    const xs = tracks.flatMap((t) => [t.a.x, t.b.x]), ys = tracks.flatMap((t) => [t.a.y, t.b.y]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r = (q) => ({ x: Math.round(cx - (q.y - cy)), y: Math.round(cy + (q.x - cx)) });
    for (const t of tracks) { t.a = r(t.a); t.b = r(t.b); }
    changed = true;
  }
  return changed;
}

/** 表裏の入替（フットプリント・文字・配線の層） */
export function flipSelection(pcb, sel) {
  let changed = false;
  for (const key of sel) {
    const o = findItem(pcb, key);
    if (!o || o.locked) continue;
    if (key[0] === 'f') { o.side = o.side === 'bottom' ? 'top' : 'bottom'; changed = true; }
    if (key[0] === 'x') { o.layer = o.layer === 'B.SilkS' ? 'F.SilkS' : 'B.SilkS'; changed = true; }
    if (key[0] === 't' || key[0] === 'z') { o.layer = mirrorLayer(o.layer, pcb); changed = true; }
  }
  return changed;
}

export function deleteSelection(pcb, sel) {
  let changed = false;
  for (const [k, list] of Object.entries(LIST)) {
    const ids = new Set([...sel].filter((s) => s[0] === k).map((s) => s.slice(2)));
    if (!ids.size) continue;
    const before = pcb[list].length;
    pcb[list] = pcb[list].filter((o) => !ids.has(o.id) || (k === 'f' && o.locked));
    changed = changed || pcb[list].length !== before;
  }
  return changed;
}

// ---------------- 基板内に並べる ----------------
/**
 * 基板の外にある部品（または指定した部品）を、基板の中の空いている場所に左上から並べる（棚詰め）。
 * すでに基板内にある部品は動かさず、その外形枠を避ける。位置はグリッドに乗せる。
 * @returns {{ moved: string[], notFit: string[] }}
 */
export function arrangeInBoard(pcb, { refs = null, gapMm = 1.0, edgeMm = 1.0 } = {}) {
  const br = boardRect(pcb);
  const grid = toMm(pcb.settings?.grid || toNm(0.25));
  const inside = (b) => b.x0 >= br.x0 && b.x1 <= br.x1 && b.y0 >= br.y0 && b.y1 <= br.y1;
  // 外形枠の上に部品番号のシルク（高さ1mm＋隙間）が載るので、その分も場所を取る
  const REF_H = 1.5;
  const boxOf = (f) => { const b = fpBox(f); return f.hideRef ? b : { ...b, y0: b.y0 - REF_H }; };
  const targets = pcb.footprints.filter((f) => !f.locked && (refs ? refs.includes(f.ref) : !inside(fpBox(f))));
  const fixed = pcb.footprints.filter((f) => !targets.includes(f)).map(boxOf);
  // 大きい部品から（詰めやすい）、同じ大きさなら部品番号順
  const cmp = (a, b) => String(a.ref).localeCompare(String(b.ref), 'en', { numeric: true });
  targets.sort((a, b) => (fpArea(b) - fpArea(a)) || cmp(a, b));
  const placed = [...fixed];
  const moved = [], notFit = [];
  const hits = (b) => placed.some((q) => b.x0 < q.x1 + gapMm && q.x0 < b.x1 + gapMm && b.y0 < q.y1 + gapMm && q.y0 < b.y1 + gapMm);
  for (const f of targets) {
    const b0 = boxOf(f);
    const w = b0.x1 - b0.x0, h = b0.y1 - b0.y0;
    const cx = toMm(f.x) - b0.x0, cy = toMm(f.y) - b0.y0; // 原点から外形枠左上までの距離
    let done = false;
    for (let y = br.y0 + edgeMm; y + h <= br.y1 - edgeMm + 1e-9 && !done; y += grid * 2) {
      for (let x = br.x0 + edgeMm; x + w <= br.x1 - edgeMm + 1e-9; x += grid * 2) {
        const px = snapMm(x + cx, grid), py = snapMm(y + cy, grid);
        const b = { x0: px - cx, y0: py - cy, x1: px - cx + w, y1: py - cy + h };
        if (b.x0 < br.x0 + edgeMm - 1e-9 || b.y0 < br.y0 + edgeMm - 1e-9 || b.x1 > br.x1 - edgeMm + 1e-9 || b.y1 > br.y1 - edgeMm + 1e-9) continue;
        if (hits(b)) continue;
        f.x = toNm(px); f.y = toNm(py);
        placed.push(b); moved.push(f.ref); done = true;
        break;
      }
    }
    if (!done) notFit.push(f.ref);
  }
  return { moved, notFit };
}
function fpArea(f) { const b = fpBox(f); return (b.x1 - b.x0) * (b.y1 - b.y0); }
