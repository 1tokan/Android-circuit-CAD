// サーマルのスポーク不足を、配線の引き直しで直す
//
// ベタ（表・裏）を塗ったあと、スポークが 2 本未満のパッド（KiCad の「starved thermal」）について、
// スポークの通り道をふさいでいる別ネットの配線・ビアを探し、そのネットだけをはがして、
// 通り道を空けたまま（自動配線の spokeReserve）引き直す。引き直せなかったとき・良くならなかったときは元に戻す。
import { toMm, allPads, fpToBoard } from './model.js';
import { fillAllZones, spokeGeom } from './zonefill.js';
import { autoroute } from './autoroute.js';
import { repairUnrouted } from './routefix.js';

const distSeg = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
};

/** スポークが足りないパッド [{ ref, pad, x, y, layer, net, spokes, zone }] */
export function starvedPads(pcb, rules, fills = null) {
  const F = fills || fillAllZones(pcb, rules);
  const min = rules.minThermalSpokes ?? 2;
  const out = [];
  for (const z of pcb.zones) for (const s of F.get(z.id)?.spokeCount || []) if (s.spokes > 0 && s.spokes < min) out.push({ ...s, layer: z.layer, net: z.net, zone: z });
  return out;
}

/**
 * @param opt { rounds: 何回まで繰り返すか（既定 3）, route: autoroute に渡す設定（netWidth・seed など）, onLog }
 * @returns {{ before, after, rerouted: [ネット], rounds }}
 */
export async function fixStarvedThermals(pcb, rules, opt = {}) {
  const rounds = opt.rounds ?? 3;
  let fills = fillAllZones(pcb, rules);
  const before = starvedPads(pcb, rules, fills).length;
  let cur = before;
  const rerouted = new Set();
  let n = 0, fails = 0, onlyStarved = !!opt.onlyStarved;
  for (; n < rounds && cur > 0; n++) {
    const starved = starvedPads(pcb, rules, fills);
    // スポークの通り道（縦横と斜めの 8 方向）にかかる別ネットの配線・ビア
    const block = new Set();
    for (const s of starved) {
      const p = allPads(pcb).find((q) => q.ref === s.ref && q.pad.num === s.pad);
      if (!p) continue;
      const P = fills.get(s.zone.id).params;
      const reach = P.clearance + Math.max(P.spoke, P.minWidth) / 2 + 0.1;
      const tips = [...spokeGeom(p, P, 0).tips, ...spokeGeom(p, P, 45).tips];
      const c = fpToBoard(p.inst, p.pad.x, p.pad.y);
      for (const t of pcb.tracks) {
        if (t.layer !== s.layer || !t.net || t.net === s.net) continue;
        const a = { x: toMm(t.a.x), y: toMm(t.a.y) }, b = { x: toMm(t.b.x), y: toMm(t.b.y) };
        if (tips.some((q) => distSeg(q, a, b) - toMm(t.width) / 2 < reach || distSeg({ x: (q.x + c.x) / 2, y: (q.y + c.y) / 2 }, a, b) - toMm(t.width) / 2 < reach)) block.add(t.net);
      }
      for (const v of pcb.vias) {
        if (!v.net || v.net === s.net) continue;
        const q0 = { x: toMm(v.x), y: toMm(v.y) };
        if (tips.some((q) => Math.hypot(q.x - q0.x, q.y - q0.y) - toMm(v.diameter) / 2 < reach)) block.add(v.net);
      }
    }
    if (!block.size) break;
    // はがして引き直す（スポークの足りないパッドだけ通り道を空ける）
    const snap = { tracks: pcb.tracks.slice(), vias: pcb.vias.slice() };
    pcb.tracks = pcb.tracks.filter((t) => !block.has(t.net));
    pcb.vias = pcb.vias.filter((v) => !block.has(v.net));
    const keys = new Set(starved.map((s) => `${s.ref}:${s.pad}`));
    const layers = [...new Set(starved.map((s) => s.layer))];
    const nets = [...new Set(starved.map((s) => s.net))];
    const zp = fills.get(starved[0].zone.id).params;
    const r = await autoroute(pcb, rules, {
      ...(opt.route || {}),
      seed: (opt.route?.seed || 0) + n, // 回ごとに順番を変える
      nets: [...block],
      // 足りないパッドだけでなく、同じベタのほかのパッドの通り道も空けておく（引き直した配線が別のパッドをふさがない）
      spokeReserve: { nets, layers, pads: onlyStarved ? keys : null, gapMm: zp.thermalGap, spokeMm: zp.spoke, clearanceMm: zp.clearance, minWidthMm: zp.minWidth, count: rules.minThermalSpokes ?? 2 },
    });
    // 引き直しで引けなくなった接続は、邪魔な配線をはがして引き直す（スポークの通り道は空けたまま）
    if (r.failed.length) {
      const rr = await repairUnrouted(pcb, rules, r.failed, { route: { ...(opt.route || {}), spokeReserve: { nets, layers, pads: keys, gapMm: zp.thermalGap, spokeMm: zp.spoke, clearanceMm: zp.clearance, minWidthMm: zp.minWidth, count: rules.minThermalSpokes ?? 2 } }, tries: 4 });
      r.failed = rr.failed;
    }
    const F2 = fillAllZones(pcb, rules);
    const after = starvedPads(pcb, rules, F2).length;
    opt.onLog?.(`thermal fix round ${n + 1}${onlyStarved ? ' (starved only)' : ''}: nets ${[...block].join(',')} failed ${r.failed.length} starved ${cur} -> ${after}`);
    // だめなら元に戻し、次は通り道を空けるパッドを変えて（足りないパッドだけ／全部）試す
    if (r.failed.length || after >= cur) { pcb.tracks = snap.tracks; pcb.vias = snap.vias; fails++; onlyStarved = !onlyStarved; if (fails >= 3) break; continue; }
    for (const x of block) rerouted.add(x);
    fills = F2; cur = after;
  }
  return { before, after: cur, rerouted: [...rerouted], rounds: n };
}
