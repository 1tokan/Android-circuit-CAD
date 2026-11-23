// GND のつなぎビア（ステッチング）
//
// 表と裏の同じネットのベタを、一定の間隔のビアで内層のベタとつなぐ。
//   ・放熱: 部品のまわりの表のベタの熱を内層・裏へ逃がす
//   ・ノイズ: 帰りの電流の道を短くする。電源層の分割をまたぐ配線の近くに打つと、またぐ所の帰り道ができる
// ビアは、どの層の配線・パッド・穴・ほかのビア・基板の縁からも規則の間隔を空けた所にだけ打ち、
// 表と裏の両方でそのネットのベタの中（塗られた所）にある点に限る（打っても孤立しない）。
import { toMm, toNm, boardRect, allPads, padHole, pointInPad } from './model.js';
import { newId } from '../core/project.js';
import { fillAllZones, pointInPolyWithHoles } from './zonefill.js';

const distSeg = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
};

/**
 * @param {object} pcb
 * @param {object} rules drcRules の結果
 * @param {object} o
 *   net: つなぐネット（既定 GND）、pitchMm: 格子の間隔、near: [{x,y}] 優先して打つ点（mm）、nearRadiusMm: その点からの探す範囲、
 *   dryRun: true なら pcb を変えない
 * @returns {{ added: [{x,y}], nearHit: number, nearMiss: number }}
 */
export function addStitchVias(pcb, rules, { net = 'GND', pitchMm = 3, near = [], nearRadiusMm = 1.2, dryRun = false, fills = null } = {}) {
  const dia = toMm(pcb.settings.viaDiameter), drill = toMm(pcb.settings.viaDrill), r = dia / 2;
  const clr = Math.max(rules.minClearanceMm ?? 0.127, 0.2);          // 配線・ビアの銅との間隔
  const padClr = Math.max(rules.minPadClearanceMm ?? 0.2, 0.25);     // パッドとの間隔（ビアをパッドに入れない）
  const hole = (rules.minHoleToHoleMm ?? 0.5) + drill;                 // 穴の中心どうし
  const edge = Math.max(rules.boardEdgeClearanceMm ?? 0.3, rules.innerEdgeClearanceMm ?? 0.3) + r + 0.2;
  const br = boardRect(pcb);
  const tracks = pcb.tracks.map((t) => ({ a: { x: toMm(t.a.x), y: toMm(t.a.y) }, b: { x: toMm(t.b.x), y: toMm(t.b.y) }, w: toMm(t.width), net: t.net }));
  const vias = pcb.vias.map((v) => ({ x: toMm(v.x), y: toMm(v.y), d: toMm(v.diameter), net: v.net }));
  const pads = allPads(pcb);
  const holes = [];
  for (const p of pads) if (p.pad.drill || p.pad.slot) holes.push(padHole(p.inst, p.pad));
  for (const h of pcb.holes || []) holes.push({ a: { x: toMm(h.x), y: toMm(h.y) }, b: { x: toMm(h.x), y: toMm(h.y) }, d: toMm(h.drill), npth: true });
  const F = fills || fillAllZones(pcb, rules);
  const outer = pcb.zones.filter((z) => z.net === net && (z.layer === 'F.Cu' || z.layer === 'B.Cu'));
  const outerLayers = [...new Set(outer.map((z) => z.layer))];
  const inFill = (p, layer) => outer.filter((z) => z.layer === layer).some((z) => (F.get(z.id)?.polygons || []).some((poly) => pointInPolyWithHoles(p, poly)));

  const ok = (p) => {
    if (p.x < br.x0 + edge || p.y < br.y0 + edge || p.x > br.x1 - edge || p.y > br.y1 - edge) return false;
    for (const t of tracks) if (t.net !== net && distSeg(p, t.a, t.b) < t.w / 2 + r + clr) return false;
    for (const v of vias) if (Math.hypot(p.x - v.x, p.y - v.y) < Math.max(v.d / 2 + r + clr, hole)) return false;
    for (const q of pads) {
      // パッドの外形から padClr＋ビアの半径 以上（同じネットでもパッドの中には打たない）
      if (Math.hypot(p.x - q.x, p.y - q.y) > Math.max(q.pad.w, q.pad.h) + 3) continue;
      if (pointInPad(q.inst, q.pad, p.x, p.y, r + padClr)) return false;
    }
    for (const h of holes) {
      // 穴の縁どうし（最小 minHoleToHole）と、取付穴（NPTH）の縁からビアの銅まで、の両方
      const need = Math.max(h.d / 2 + drill / 2 + (rules.minHoleToHoleMm ?? 0.5), h.npth ? h.d / 2 + r + Math.max(rules.minNpthToCopperMm ?? 0.254, 0.3) : 0);
      if (distSeg(p, h.a, h.b) < need + 0.01) return false;
    }
    // 表と裏の両方で、このネットのベタの塗られた所（ベタの無い面は問わない）
    for (const l of outerLayers) if (!inFill(p, l)) return false;
    return true;
  };
  const added = [];
  const place = (p) => { added.push(p); vias.push({ x: p.x, y: p.y, d: dia, net }); };

  // 1) 優先する点（電源層の分割をまたぐ配線の近く、発熱する部品の近くなど）
  let nearHit = 0, nearMiss = 0;
  for (const c of near) {
    let best = null;
    for (let rr = 0; rr <= nearRadiusMm + 1e-9 && !best; rr += 0.1) {
      const n = Math.max(1, Math.round((2 * Math.PI * rr) / 0.1));
      for (let k = 0; k < n; k++) {
        const p = { x: +(c.x + rr * Math.cos((2 * Math.PI * k) / n)).toFixed(3), y: +(c.y + rr * Math.sin((2 * Math.PI * k) / n)).toFixed(3) };
        if (added.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.8)) { best = 'dup'; break; }
        if (ok(p)) { best = p; break; }
      }
    }
    if (best && best !== 'dup') { place(best); nearHit++; } else if (!best) nearMiss++;
  }
  // 2) 格子: 各マスの中心に一番近い打てる点（マスの中に既に同じネットのビアがあれば打たない）
  const P = pitchMm;
  for (let y = br.y0 + P / 2; y < br.y1; y += P) {
    for (let x = br.x0 + P / 2; x < br.x1; x += P) {
      const inCell = (q) => Math.abs(q.x - x) <= P / 2 && Math.abs(q.y - y) <= P / 2;
      if (vias.some((v) => v.net === net && inCell(v))) continue;
      let best = null;
      for (let rr = 0; rr <= P / 2 && !best; rr += 0.15) {
        const n = Math.max(1, Math.round((2 * Math.PI * rr) / 0.15));
        for (let k = 0; k < n; k++) {
          const p = { x: +(x + rr * Math.cos((2 * Math.PI * k) / n)).toFixed(3), y: +(y + rr * Math.sin((2 * Math.PI * k) / n)).toFixed(3) };
          if (inCell(p) && ok(p)) { best = p; break; }
        }
      }
      if (best) place(best);
    }
  }
  if (!dryRun) for (const p of added) pcb.vias.push({ id: newId('v'), x: toNm(p.x), y: toNm(p.y), diameter: pcb.settings.viaDiameter, drill: pcb.settings.viaDrill, net, stitch: true });
  return { added, nearHit, nearMiss };
}

/**
 * 電源層（内層）の分割の境目を、外層の信号配線がまたぐ点
 * @returns [{ net, x, y, from, to }]
 */
export function planeSplitCrossings(pcb, rules, { fills = null, signalLayer = 'B.Cu', planeLayer = 'In2.Cu', stepMm = 0.1 } = {}) {
  const F = fills || fillAllZones(pcb, rules);
  const zones = pcb.zones.filter((z) => z.layer === planeLayer);
  const netAt = (p) => { for (const z of zones) if ((F.get(z.id)?.polygons || []).some((poly) => pointInPolyWithHoles(p, poly))) return z.net; return null; };
  const out = [];
  for (const t of pcb.tracks.filter((q) => q.layer === signalLayer)) {
    const a = { x: toMm(t.a.x), y: toMm(t.a.y) }, b = { x: toMm(t.b.x), y: toMm(t.b.y) };
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepMm));
    let last = null, lastAt = null, gapStart = null;
    for (let s = 0; s <= n; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n };
      const z = netAt(p);
      if (z == null) { if (gapStart == null) gapStart = p; continue; }
      // 切れ目を挟んで別のベタへ移った（ビアの穴の周りの抜けは同じベタに戻るので数えない）
      if (last != null && z !== last && gapStart && Math.hypot(p.x - gapStart.x, p.y - gapStart.y) < 1.5) out.push({ net: t.net, x: +((p.x + gapStart.x) / 2).toFixed(2), y: +((p.y + gapStart.y) / 2).toFixed(2), from: last, to: z });
      last = z; lastAt = p; gapStart = null;
    }
  }
  return out;
}
