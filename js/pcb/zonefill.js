// ベタ（塗りつぶし）の形状計算
//  塗りつぶし = ベタの範囲 ∩ (基板外形 − 縁のクリアランス)
//             − (別ネットのパッド・配線・ビア・取付穴 ＋ クリアランス)
//             − (同ネットのパッド ＋ 隙間)  ＋ サーマルのスポーク（同ネットのパッドへ4方向）
//  その後、同ネットのパッド・ビア・配線につながらない島を取り除く。
// 丸い形は、内側に入り込まないよう外接多角形で近似する（クリアランスが必ず指定値以上になる）。
// 座標は mm。結果の多角形は [[[x,y],...外周], [[x,y],...穴]...] の配列（polygon-clipping 形式）。

import pc from '../vendor/polygon-clipping.js';
import { allPads, toMm, boardRect, fpToBoard, boardHoles, holeClearRadiusMm } from './model.js';
import { hash } from '../netlist/netlist.js';
import { pointInRing as inRing } from '../core/geom2d.js';
import { withDefaults } from '../check/rules.js';

const SEG = 24; // 円の分割数

export const ZONE_DEFAULTS = {
  clearanceMm: 0.3,      // 別ネットの銅とのクリアランス
  thermalGapMm: 0.3,     // 同ネットのパッドの周りの隙間
  spokeWidthMm: 0.35,    // サーマルのスポーク幅
  edgeClearanceMm: 0.5,  // 基板外形から
  npthClearanceMm: 0.5,  // 取付穴から
};

// ---------- 形状 → 多角形（膨らませ込み） ----------
/** 線分 a-b を半径 r で太らせたカプセル（外接） */
export function capsulePoly(a, b, r) {
  const R = r / Math.cos(Math.PI / SEG);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const pts = [];
  const half = SEG / 2;
  for (let i = 0; i <= half; i++) { const t = ang + Math.PI / 2 + (Math.PI * i) / half; pts.push([a.x + R * Math.cos(t), a.y + R * Math.sin(t)]); }
  for (let i = 0; i <= half; i++) { const t = ang - Math.PI / 2 + (Math.PI * i) / half; pts.push([b.x + R * Math.cos(t), b.y + R * Math.sin(t)]); }
  return close(pts);
}
/** 凸多角形を d だけ外へ広げる（角は円弧で丸め、円弧は外接多角形で近似） */
export function offsetConvex(pts, d) {
  if (d <= 0) return close(pts.map((p) => [p.x, p.y]));
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p.x * q.y - q.x * p.y; }
  const ccw = area > 0;
  const normal = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y; return ccw ? Math.atan2(-dx, dy) : Math.atan2(dx, -dy); };
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], p = pts[i], next = pts[(i + 1) % n];
    const t1 = normal(prev, p);
    let delta = normal(p, next) - t1;
    if (ccw) { while (delta < 0) delta += 2 * Math.PI; while (delta >= 2 * Math.PI) delta -= 2 * Math.PI; }
    else { while (delta > 0) delta -= 2 * Math.PI; while (delta <= -2 * Math.PI) delta += 2 * Math.PI; }
    const steps = Math.max(1, Math.ceil((Math.abs(delta) / (2 * Math.PI)) * SEG));
    const step = delta / steps;
    const R = d / Math.cos(step / 2);
    out.push([p.x + d * Math.cos(t1), p.y + d * Math.sin(t1)]);
    for (let k = 0; k < steps; k++) { const t = t1 + step * (k + 0.5); out.push([p.x + R * Math.cos(t), p.y + R * Math.sin(t)]); }
    out.push([p.x + d * Math.cos(t1 + delta), p.y + d * Math.sin(t1 + delta)]);
  }
  return close(out);
}
function close(pts) { const r = pts.slice(); if (r.length && (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1])) r.push([r[0][0], r[0][1]]); return r; }

/** パッドを d だけ太らせた多角形（基板座標） */
export function padPoly(inst, pad, d) {
  if (pad.shape === 'circle') { const c = fpToBoard(inst, pad.x, pad.y); return capsulePoly(c, c, Math.max(pad.w, pad.h) / 2 + d); }
  if (pad.shape === 'oval') {
    const r = Math.min(pad.w, pad.h) / 2;
    const hx = pad.w / 2 - r, hy = pad.h / 2 - r;
    return capsulePoly(fpToBoard(inst, pad.x - hx, pad.y - hy), fpToBoard(inst, pad.x + hx, pad.y + hy), r + d);
  }
  const hw = pad.w / 2, hh = pad.h / 2;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => fpToBoard(inst, pad.x + x, pad.y + y));
  return offsetConvex(pts, d);
}

// ---------- 点と多角形 ----------
/** 点が「穴あき多角形」（[外周, 穴...]）の内側か */
export function pointInPolyWithHoles(p, poly) {
  if (!inRing(p, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (inRing(p, poly[i])) return false;
  return true;
}
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

// ---------- 塗りつぶし ----------
function zoneParams(z, rules = {}) {
  return {
    clearance: Math.max(z.clearance ? toMm(z.clearance) : ZONE_DEFAULTS.clearanceMm, rules.minClearanceMm ?? 0, rules.minPadClearanceMm ?? 0),
    thermalGap: z.thermalGap ? toMm(z.thermalGap) : ZONE_DEFAULTS.thermalGapMm,
    spoke: z.spokeWidth ? toMm(z.spokeWidth) : ZONE_DEFAULTS.spokeWidthMm,
    edge: Math.max(ZONE_DEFAULTS.edgeClearanceMm, rules.boardEdgeClearanceMm ?? 0),
    npth: Math.max(ZONE_DEFAULTS.npthClearanceMm, rules.minNpthToCopperMm ?? 0),
    padConnection: z.padConnection || 'thermal', // 'thermal' | 'solid'
    minSpokes: rules.minThermalSpokes ?? null, // これより少ないパッドは 45° のスポークを試す
    minWidth: z.minWidth ? toMm(z.minWidth) : 0.25, // ベタの最小幅（KiCad はこれより細い所を塗らない）
  };
}

/**
 * スポークの先端 q の先に、半径 r の円が塗れる場所があるか（KiCad はベタの最小幅より細い所を塗らない）。
 * 円の中心は先端、または先端から横（スポークに直角）へ r ずらした所。円は中心と円周の 8 点で調べる
 */
function fatIn(q, polys, r) {
  const inside = (x, y) => polys.some((poly) => pointInPolyWithHoles({ x, y }, poly));
  const disc = (cx, cy) => inside(cx, cy) && Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4).every((a) => inside(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  const nx = -(q.uy || 0), ny = q.ux || 0;
  return disc(q.x, q.y) || disc(q.x + nx * r, q.y + ny * r) || disc(q.x - nx * r, q.y - ny * r);
}

/**
 * サーマルのスポークの形と先端（基板座標）。angle 0 = パッドの縦横の 4 本、45 = 斜めの 4 本（KiCad のスポークの角度 90°／45°）
 * 先端は隙間の外側（ベタにつながったかを数える点）
 */
export function spokeGeom(p, P, angle = 0) {
  const pad = p.pad, hw = P.spoke / 2;
  const dirs = angle === 45 ? [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([x, y]) => [x / Math.SQRT2, y / Math.SQRT2]) : [[1, 0], [0, 1], [-1, 0], [0, -1]];
  // パッドの中心から方向 (dx,dy) に進んで、パッドの外へ出るまでの長さ
  const exitLen = (dx, dy) => Math.min(dx ? pad.w / 2 / Math.abs(dx) : Infinity, dy ? pad.h / 2 / Math.abs(dy) : Infinity);
  const tips = [], rects = [];
  for (const [dx, dy] of dirs) {
    const slant = dx && dy ? Math.SQRT2 : 1; // 斜めに横切ると隙間の幅が長くなる
    const e = exitLen(dx, dy) + P.thermalGap * slant;
    // 先端は隙間の外へ「ベタの最小幅の半分」だけ出た点。そこを中心に最小幅の円が塗れていれば、つながったとみなす（KiCad は細い所を塗らない）
    const t = fpToBoard(p.inst, pad.x + dx * (e + P.spoke / 2 + P.minWidth / 2), pad.y + dy * (e + P.spoke / 2 + P.minWidth / 2));
    const o = fpToBoard(p.inst, pad.x, pad.y), l = Math.hypot(t.x - o.x, t.y - o.y) || 1;
    tips.push({ x: t.x, y: t.y, ux: (t.x - o.x) / l, uy: (t.y - o.y) / l });
  }
  // 中心を通る 2 本の棒（向かい合う 2 方向で 1 本）
  for (const [dx, dy] of dirs.slice(0, 2)) { // 直交する 2 方向
    const L = exitLen(dx, dy) + P.thermalGap * (dx && dy ? Math.SQRT2 : 1) + P.spoke;
    const a = fpToBoard(p.inst, pad.x - dx * L, pad.y - dy * L), b = fpToBoard(p.inst, pad.x + dx * L, pad.y + dy * L);
    const l = Math.hypot(b.x - a.x, b.y - a.y), nx = (-(b.y - a.y) / l) * hw, ny = ((b.x - a.x) / l) * hw;
    rects.push([close([[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny]])]);
  }
  return { tips, rects };
}

/**
 * 1つのベタを塗る
 * @returns {{ polygons, islandsRemoved, params }}
 */
export function fillZone(pcb, z, rules = {}) {
  const P = zoneParams(z, withDefaults(rules));
  const br = boardRect(pcb);
  const e = P.edge;
  const boardArea = [[[br.x0 + e, br.y0 + e], [br.x1 - e, br.y0 + e], [br.x1 - e, br.y1 - e], [br.x0 + e, br.y1 - e], [br.x0 + e, br.y0 + e]]];
  const zonePoly = [close(z.polygon.map((q) => [toMm(q.x), toMm(q.y)]))];
  let area = pc.intersection(zonePoly, boardArea);
  if (!area.length) return { polygons: [], islandsRemoved: 0, params: P };

  const obstacles = [];
  const gaps = [];
  const spokes = [];
  const thermal = []; // サーマルでつなぐパッドと、4 本のスポークの先端（ベタにつながったかを後で数える）
  const anchors = [];
  const pads = allPads(pcb).filter((p) => p.layers.includes(z.layer));
  for (const p of pads) {
    if (z.net && p.net === z.net) {
      anchors.push({ x: p.x, y: p.y });
      if (P.padConnection === 'solid' || p.inst.zoneConnect === 'solid') continue; // 直結（部品ごとの設定もある）
      gaps.push([padPoly(p.inst, p.pad, P.thermalGap)]);
      // スポークの向きは、まずパッドの縦横（部品の回転に合わせる）。足りなければ後で 45°（片面のパッドだけ。KiCad のパッドの「スポークの角度」）
      thermal.push({ ref: p.ref, pad: p.pad.num, x: p.x, y: p.y, p, angle: 0, single: p.layers.length === 1 });
    } else {
      obstacles.push([padPoly(p.inst, p.pad, P.clearance)]);
    }
  }
  for (const t of pcb.tracks) {
    if (t.layer !== z.layer) continue;
    const a = { x: toMm(t.a.x), y: toMm(t.a.y) }, b = { x: toMm(t.b.x), y: toMm(t.b.y) };
    if (z.net && t.net === z.net) { anchors.push(a, b); continue; }
    obstacles.push([capsulePoly(a, b, toMm(t.width) / 2 + P.clearance)]);
  }
  for (const v of pcb.vias) {
    const c = { x: toMm(v.x), y: toMm(v.y) };
    if (z.net && v.net === z.net) { anchors.push(c); continue; } // ビアはベタに直結
    obstacles.push([capsulePoly(c, c, toMm(v.diameter) / 2 + P.clearance)]);
  }
  for (const h of boardHoles(pcb)) {
    const c = { x: toMm(h.x), y: toMm(h.y) };
    obstacles.push([capsulePoly(c, c, holeClearRadiusMm(h, P.npth))]); // ネジの頭の範囲（keepout）にもベタを入れない
  }

  let fill = obstacles.length ? safeDifference(area, obstacles) : area;
  if (gaps.length && fill.length) {
    const cut = safeDifference(fill, gaps);
    // スポークの先端が、隙間を空けたあとのベタに届くか（ベタにつながる本数）
    const reach = (tips) => tips.filter((q) => fatIn(q, cut, P.minWidth / 2)).length;
    for (const t of thermal) {
      const g0 = spokeGeom(t.p, P, 0);
      t.angle = 0; t.tips = g0.tips; t.rects = g0.rects;
      if (!t.single || P.minSpokes == null) continue;
      const n0 = reach(g0.tips);
      if (n0 >= P.minSpokes) continue;
      const g45 = spokeGeom(t.p, P, 45);
      if (reach(g45.tips) > n0) { t.angle = 45; t.tips = g45.tips; t.rects = g45.rects; }
    }
    for (const t of thermal) spokes.push(...t.rects);
    const sp = spokes.length ? pc.intersection(pc.union(...spokes), fill) : [];
    fill = sp.length ? pc.union(cut, sp) : cut;
  }
  // 島の除去（ネット無しのベタは島を残す）
  let islandsRemoved = 0;
  if (z.net) {
    const kept = fill.filter((poly) => anchors.some((a) => pointInPolyWithHoles(a, poly)));
    islandsRemoved = fill.length - kept.length;
    fill = kept;
  }
  const r6 = (v) => Math.round(v * 1e5) / 1e5;
  const polygons = fill.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r6(x), r6(y)])));
  // パッドごとの、ベタにつながったスポークの数（KiCad の「サーマルのスポーク不足」と同じ考え方。配線でのつながりは数えない）
  const spokeCount = thermal.map((t) => ({ ref: t.ref, pad: t.pad, x: t.x, y: t.y, angle: t.angle, spokes: (t.tips || []).filter((q) => fatIn(q, fill, P.minWidth / 2)).length }));
  return { polygons, islandsRemoved, spokeCount, params: P };
}

/**
 * polygon-clipping は、ほぼ同じ直線上に並ぶ短い辺が重なると稀に計算に失敗する（SweepLine の例外）。
 * そのときは障害物を1つずつ引き、失敗した障害物はほんの少し（0.2µm）太らせて引き直す。
 * 太らせるのは障害物側なので、間隔は狭くならない。
 */
function safeDifference(base, subs) {
  try { return pc.difference(base, ...subs); } catch { /* 区画に分けて引く */ }
  // 基板をいくつかの区画に分け、区画ごとにその区画にかかる障害物だけを引く（失敗の起きる所を狭くし、1 つずつ引く所を減らす）。
  // 区画どうしは少し重ねて切り、最後にまとめる（つなぎ目に切れ目を作らない）
  const bb = bboxOf(base);
  const nx = Math.max(1, Math.ceil((bb.x1 - bb.x0) / 8)), ny = Math.max(1, Math.ceil((bb.y1 - bb.y0) / 8));
  const sx = (bb.x1 - bb.x0) / nx, sy = (bb.y1 - bb.y0) / ny, ov = 0.05;
  const sb = subs.map((q) => bboxOf(q));
  const pieces = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const r = { x0: bb.x0 + i * sx - ov, y0: bb.y0 + j * sy - ov, x1: bb.x0 + (i + 1) * sx + ov, y1: bb.y0 + (j + 1) * sy + ov };
    const rect = [[[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x0, r.y0]]];
    let piece = pc.intersection(base, rect);
    if (!piece.length) continue;
    const local = subs.filter((_, k) => sb[k].x1 >= r.x0 && sb[k].x0 <= r.x1 && sb[k].y1 >= r.y0 && sb[k].y0 <= r.y1);
    piece = diffOneByOne(piece, local, true);
    if (piece.length) pieces.push(piece);
  }
  if (!pieces.length) return [];
  try { return pc.union(...pieces); } catch { /* まとめるのに失敗したら 1 つずつ足す */ }
  let out = pieces[0];
  for (const p of pieces.slice(1)) out = pc.union(out, p.map((poly) => grow(poly, 0.0002)));
  return out;
}
/** まとめて引き、失敗したら 1 つずつ（失敗した障害物はほんの少し太らせて）引く */
function diffOneByOne(base, subs, tryBatch = false) {
  if (tryBatch && subs.length) { try { return pc.difference(base, ...subs); } catch { /* 1 つずつ */ } }
  let out = base;
  for (const s of subs) {
    if (!out.length) break;
    let ok = false;
    for (let k = 0; k < 4 && !ok; k++) {
      try { out = pc.difference(out, k ? grow(s, 0.0002 * k) : s); ok = true; } catch { /* 少し太らせて再試行 */ }
    }
    if (!ok) throw new Error('ベタの計算に失敗しました（形が複雑すぎます）');
  }
  return out;
}
function bboxOf(mp) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const walk = (a) => { if (typeof a[0] === 'number') { b.x0 = Math.min(b.x0, a[0]); b.x1 = Math.max(b.x1, a[0]); b.y0 = Math.min(b.y0, a[1]); b.y1 = Math.max(b.y1, a[1]); } else for (const q of a) walk(q); };
  walk(mp);
  return b;
}
/** 多角形を重心から外へ d だけ広げる（凸形の障害物用の近似） */
function grow(poly, d) {
  return poly.map((ring) => {
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    return ring.map(([x, y]) => { const l = Math.hypot(x - cx, y - cy) || 1; return [x + ((x - cx) / l) * d * 2, y + ((y - cy) / l) * d * 2]; });
  });
}

/** 塗りつぶし結果に影響する情報のハッシュ */
export function fillHash(pcb, rules = {}) {
  const geo = {
    o: pcb.outline,
    f: pcb.footprints.map((f) => [f.id, f.x, f.y, f.rot, f.side, f.padNets, f.fpDef.pads, f.zoneConnect || '']),
    t: pcb.tracks, v: pcb.vias, h: pcb.holes, z: pcb.zones,
    r: [rules.minClearanceMm, rules.minPadClearanceMm, rules.boardEdgeClearanceMm, rules.minNpthToCopperMm, rules.minThermalSpokes],
  };
  return hash(JSON.stringify(geo));
}

/** 全ベタを塗る → Map(zoneId → 結果) */
export function fillAllZones(pcb, rules = {}) {
  const out = new Map();
  for (const z of pcb.zones) out.set(z.id, fillZone(pcb, z, rules));
  return out;
}

// 直近の結果を覚えておく（同じ形なら計算し直さない）
let cache = { key: null, fills: null };
/**
 * @param allowStale true なら形が変わっていても前回の結果を返す（ドラッグ中の描画用）
 * @returns {{ fills: Map, stale: boolean }}
 */
export function cachedFills(pcb, rules = {}, { allowStale = false } = {}) {
  if (!pcb.zones.length) return { fills: new Map(), stale: false };
  rules = withDefaults(rules); // 呼び出し元によらず同じルールで塗る
  const key = fillHash(pcb, rules);
  if (cache.key === key) return { fills: cache.fills, stale: false };
  if (allowStale && cache.fills && [...cache.fills.keys()].every((id) => pcb.zones.some((z) => z.id === id))) return { fills: cache.fills, stale: true };
  const fills = fillAllZones(pcb, rules);
  cache = { key, fills };
  return { fills, stale: false };
}
