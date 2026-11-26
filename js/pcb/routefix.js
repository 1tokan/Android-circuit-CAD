// 自動配線で引けなかった接続を、邪魔をしている配線をはがして引き直す
//
// 引けなかった接続のパッドどうしを囲む範囲（少し広げた長方形）を通る別ネットの配線・ビアを探し、
// それらのネットをはがす → 引けなかったネットを先に引く → はがしたネットを引き直す。
// 引けない接続が減ったときは採用し（全部引ければ終わり）、増えたか同じなら元に戻して、順番（seed）を変えてもう一度。
import { toMm, allPads } from './model.js';
import { autoroute } from './autoroute.js';

const segBoxHit = (a, b, r) => {
  // 線分 a-b が長方形 r に触れるか（端点か、辺との交差。長方形は十分小さいので端点と中点の判定で足りる場合が多いが、交差も見る）
  const inR = (p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  if (inR(a) || inR(b) || inR({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) return true;
  const cross = (p, q, s, t) => {
    const d = (q.x - p.x) * (t.y - s.y) - (q.y - p.y) * (t.x - s.x);
    if (!d) return false;
    const u = ((s.x - p.x) * (t.y - s.y) - (s.y - p.y) * (t.x - s.x)) / d, v = ((s.x - p.x) * (q.y - p.y) - (s.y - p.y) * (q.x - p.x)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  };
  const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  return c.some((p, i) => cross(a, b, p, c[(i + 1) % 4]));
};

/**
 * @param failed autoroute の結果の failed（[{ net, a: '部品-ピン', b }]）
 * @param opt { route: autoroute の設定, tries: 試す回数（既定 6）, marginMm: 範囲の広げ幅（既定 1.5）, onLog }
 * @returns {{ fixed: boolean, failed, tries }}
 */
export async function repairUnrouted(pcb, rules, failed, opt = {}) {
  const tries = opt.tries ?? 6;
  let cur = failed;
  let t = 0;
  for (; t < tries && cur.length; t++) {
    const margin = (opt.marginMm ?? 1.5) + t * 0.5; // 回ごとに少し広く
    const pads = allPads(pcb);
    const padAt = (s) => { const i = s.lastIndexOf('-'); const ref = s.slice(0, i), num = s.slice(i + 1); return pads.find((p) => p.ref === ref && p.pad.num === num); };
    const want = new Set(cur.map((f) => f.net));
    const keep = opt.keepNets || ((n) => /^(GND|AGND|DGND|PGND)$/.test(n)); // GND（ベタ・面へのビアが多い）ははがさない
    const block = new Set();
    for (const f of cur) {
      const pa = padAt(f.a), pb = f.b && padAt(f.b);
      const pts = [pa, pb].filter(Boolean);
      if (!pts.length) continue;
      const r = { x0: Math.min(...pts.map((p) => p.x)) - margin, y0: Math.min(...pts.map((p) => p.y)) - margin, x1: Math.max(...pts.map((p) => p.x)) + margin, y1: Math.max(...pts.map((p) => p.y)) + margin };
      for (const tr of pcb.tracks) if (tr.net && !want.has(tr.net) && !keep(tr.net) && segBoxHit({ x: toMm(tr.a.x), y: toMm(tr.a.y) }, { x: toMm(tr.b.x), y: toMm(tr.b.y) }, r)) block.add(tr.net);
      for (const v of pcb.vias) if (v.net && !want.has(v.net) && !keep(v.net)) { const x = toMm(v.x), y = toMm(v.y); if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) block.add(v.net); }
    }
    const snap = { tracks: pcb.tracks.slice(), vias: pcb.vias.slice() };
    pcb.tracks = pcb.tracks.filter((x) => !block.has(x.net));
    pcb.vias = pcb.vias.filter((x) => !block.has(x.net));
    const seed = (opt.route?.seed || 0) + 101 + t;
    const r1 = await autoroute(pcb, rules, { ...(opt.route || {}), seed, nets: [...want] });
    const r2 = await autoroute(pcb, rules, { ...(opt.route || {}), seed, nets: [...block] });
    const left = [...r1.failed, ...r2.failed];
    opt.onLog?.(`route fix ${t + 1}: ${[...want].join(',')} ripped ${[...block].join(',')} -> failed ${left.map((f) => f.net).join(',') || 'none'}`);
    if (left.length < cur.length) cur = left; // 減ったら採用（0 になれば終わり）
    else { pcb.tracks = snap.tracks; pcb.vias = snap.vias; }
  }
  return { fixed: !cur.length, failed: cur, tries: t };
}
