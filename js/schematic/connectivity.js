// 電気的接続の計算（純粋関数）
// ルール:
//  - ピン同士: 先端が同じ点なら接続
//  - ピン/ラベル ↔ 配線: 点が配線上（端点・途中どちらでも）にあれば接続
//  - 配線 ↔ 配線: 一方の端点が他方の上（端点・途中）にあれば接続（T分岐）
//  - 配線の途中同士が交差しているだけ → 接続しない
//  - 同名のネットラベル、同名の電源記号はシート全体で同一ネット
// 3つ以上の接続が集まる点に接続ドット（ジャンクション）を描く。

import { xform, onSegment, onSegmentInterior, key } from './geom.js';
import { getSymbol } from './symbols.js';

class DSU {
  constructor() { this.p = new Map(); }
  add(a) { if (!this.p.has(a)) this.p.set(a, a); }
  find(a) {
    let r = a;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(a) !== r) { const n = this.p.get(a); this.p.set(a, r); a = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

/** 全ピンのシート上の位置 */
export function pinPositions(sheet) {
  const out = [];
  for (const c of sheet.components) {
    const sym = getSymbol(c);
    for (const p of sym.pins) {
      const at = xform(p, c);
      out.push({ node: `p:${c.id}:${p.num}`, compId: c.id, ref: c.ref, pin: p.num, name: p.name, type: p.type, x: at.x, y: at.y, isPower: !!sym.isPower, comp: c });
    }
  }
  return out;
}

export function computeConnectivity(sheet) {
  const dsu = new DSU();
  const pins = pinPositions(sheet);
  const wires = sheet.wires.filter((w) => !(w.a.x === w.b.x && w.a.y === w.b.y));
  const labels = sheet.labels || [];

  pins.forEach((p) => dsu.add(p.node));
  wires.forEach((w) => dsu.add(`w:${w.id}`));
  labels.forEach((l) => dsu.add(`l:${l.id}`));

  // 点（ピン・ラベル）の接続
  const points = [
    ...pins.map((p) => ({ node: p.node, x: p.x, y: p.y })),
    ...labels.map((l) => ({ node: `l:${l.id}`, x: l.x, y: l.y })),
  ];
  const byPt = new Map();
  for (const pt of points) {
    const k = key(pt.x, pt.y);
    if (!byPt.has(k)) byPt.set(k, []);
    byPt.get(k).push(pt.node);
  }
  for (const nodes of byPt.values()) for (let i = 1; i < nodes.length; i++) dsu.union(nodes[0], nodes[i]);
  for (const pt of points) {
    for (const w of wires) if (onSegment(pt, w.a, w.b)) dsu.union(pt.node, `w:${w.id}`);
  }
  // 配線同士（端点が相手の上にある場合のみ）
  for (const w of wires) {
    for (const v of wires) {
      if (w === v) continue;
      if (onSegment(w.a, v.a, v.b) || onSegment(w.b, v.a, v.b)) dsu.union(`w:${w.id}`, `w:${v.id}`);
    }
  }

  // 名前によるグローバル接続
  const byName = new Map();
  const nameOf = (node, name, source) => {
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ node, source });
  };
  labels.forEach((l) => nameOf(`l:${l.id}`, l.name.trim(), 'label'));
  pins.filter((p) => p.isPower).forEach((p) => nameOf(p.node, p.name, 'power'));
  for (const list of byName.values()) for (let i = 1; i < list.length; i++) dsu.union(list[0].node, list[i].node);

  // ネットにまとめる
  const groups = new Map();
  const get = (node) => {
    const r = dsu.find(node);
    if (!groups.has(r)) groups.set(r, { pins: [], wires: [], labels: [], names: new Set() });
    return groups.get(r);
  };
  pins.forEach((p) => {
    const g = get(p.node);
    if (p.isPower) g.names.add(p.name);
    else g.pins.push({ compId: p.compId, ref: p.ref, pin: p.pin, name: p.name, type: p.type });
    if (p.isPower) g.powerSymbols = (g.powerSymbols || 0) + 1;
  });
  wires.forEach((w) => get(`w:${w.id}`).wires.push(w.id));
  labels.forEach((l) => { const g = get(`l:${l.id}`); g.labels.push(l.id); if (l.name.trim()) g.names.add(l.name.trim()); });

  const nets = [];
  for (const g of groups.values()) {
    if (!g.pins.length && !g.names.size) continue; // 配線だけの浮きネットは除外
    const names = [...g.names].sort();
    g.pins.sort((a, b) => cmpRef(a.ref, b.ref) || cmpRef(a.pin, b.pin));
    const auto = g.pins.length ? `Net-(${g.pins[0].ref}-${g.pins[0].pin})` : '';
    nets.push({
      name: names[0] || auto,
      named: names.length > 0,
      conflictingNames: names.length > 1 ? names : null,
      pins: g.pins,
      wires: g.wires,
      labels: g.labels,
    });
  }
  nets.sort((a, b) => (b.named - a.named) || a.name.localeCompare(b.name));

  // 物理的に何も触れていないピン・ラベルは「未接続」（名前だけで結ばれた電源記号も含む）
  const physical = new Set();
  for (const nodes of byPt.values()) if (nodes.length > 1) nodes.forEach((n) => physical.add(n));
  for (const pt of points) for (const w of wires) if (onSegment(pt, w.a, w.b)) physical.add(pt.node);
  const unconnectedPins = pins.filter((p) => !physical.has(p.node)).map((p) => ({ compId: p.compId, ref: p.ref, pin: p.pin, x: p.x, y: p.y, isPower: p.isPower }));
  const danglingLabels = labels.filter((l) => !physical.has(`l:${l.id}`)).map((l) => l.id);

  return { nets, junctions: findJunctions(wires, pins), unconnectedPins, danglingLabels };
}

/** 3方向以上が集まる点。配線の途中に乗る点は2方向として数える */
export function findJunctions(wires, pins) {
  const cand = new Map();
  const add = (x, y) => cand.set(key(x, y), { x, y });
  wires.forEach((w) => { add(w.a.x, w.a.y); add(w.b.x, w.b.y); });
  const out = [];
  for (const pt of cand.values()) {
    let deg = 0;
    for (const w of wires) {
      if ((w.a.x === pt.x && w.a.y === pt.y) || (w.b.x === pt.x && w.b.y === pt.y)) deg += 1;
      else if (onSegmentInterior(pt, w.a, w.b)) deg += 2;
    }
    for (const p of pins) if (p.x === pt.x && p.y === pt.y) deg += 1;
    if (deg >= 3) out.push(pt);
  }
  return out;
}

/** R2 < R10 となる自然順比較 */
export function cmpRef(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}
