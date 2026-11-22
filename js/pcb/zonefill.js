// ベタ（塗りつぶし）の形状計算
//  塗りつぶし = ベタの範囲 ∩ (基板外形 − 縁のクリアランス)
//             − (別ネットのパッド・配線・ビア・取付穴 ＋ クリアランス)
//             − (同ネットのパッド ＋ 隙間)  ＋ サーマルのスポーク（同ネットのパッドへ4方向）
//  その後、同ネットのパッド・ビア・配線につながらない島を取り除く。
// 丸い形は、内側に入り込まないよう外接多角形で近似する（クリアランスが必ず指定値以上になる）。
// 座標は mm。結果の多角形は [[[x,y],...外周], [[x,y],...穴]...] の配列（polygon-clipping 形式）。

import pc from '../vendor/polygon-clipping.js';
import { allPads, toMm, boardRect, fpToBoard } from './model.js';
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
  };
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
  const anchors = [];
  const pads = allPads(pcb).filter((p) => p.layers.includes(z.layer));
  for (const p of pads) {
    if (z.net && p.net === z.net) {
      anchors.push({ x: p.x, y: p.y });
      if (P.padConnection === 'solid') continue;
      gaps.push([padPoly(p.inst, p.pad, P.thermalGap)]);
      // スポーク: パッドの縦横方向（部品の回転に合わせる）。パッド中心を通る十字
      const L = Math.max(p.pad.w, p.pad.h) / 2 + P.thermalGap + P.spoke;
      const hw = P.spoke / 2;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const a = fpToBoard(p.inst, p.pad.x - dx * L, p.pad.y - dy * L);
        const b = fpToBoard(p.inst, p.pad.x + dx * L, p.pad.y + dy * L);
        const ux = (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y), uy = (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y);
        const nx = -uy * hw, ny = ux * hw;
        spokes.push([close([[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny]])]);
      }
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
  for (const h of pcb.holes) {
    const c = { x: toMm(h.x), y: toMm(h.y) };
    obstacles.push([capsulePoly(c, c, toMm(h.drill) / 2 + P.npth)]);
  }

  let fill = obstacles.length ? safeDifference(area, obstacles) : area;
  if (gaps.length && fill.length) {
    const cut = safeDifference(fill, gaps);
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
  return { polygons, islandsRemoved, params: P };
}

/**
 * polygon-clipping は、ほぼ同じ直線上に並ぶ短い辺が重なると稀に計算に失敗する（SweepLine の例外）。
 * そのときは障害物を1つずつ引き、失敗した障害物はほんの少し（0.2µm）太らせて引き直す。
 * 太らせるのは障害物側なので、間隔は狭くならない。
 */
function safeDifference(base, subs) {
  try { return pc.difference(base, ...subs); } catch { /* 1つずつにする */ }
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
    f: pcb.footprints.map((f) => [f.id, f.x, f.y, f.rot, f.side, f.padNets, f.fpDef.pads]),
    t: pcb.tracks, v: pcb.vias, h: pcb.holes, z: pcb.zones,
    r: [rules.minClearanceMm, rules.minPadClearanceMm, rules.boardEdgeClearanceMm, rules.minNpthToCopperMm],
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
