// 同じネットで近すぎるビアを 1 つにまとめる
// JLCPCB は同じネットのビアどうしも穴の縁を 0.254mm 以上離す必要がある（近すぎるとドリルが折れる・穴がつながる）。
// 自動配線は同じネットのビアを近くに置くことがあるので、配線のあとにまとめる。
// まとめ方: 残すビア A と消すビア B。B につながっていた配線は、その層で B→A の短い配線を足してつなぎ直す。
// 足す配線が他のネットの配線・ビア・パッドに近すぎるときは、逆（A を消して B を残す）を試し、だめならそのまま残す（DRC に出る）。

import { toMm, allPads, pointInPad } from './model.js';
import { pointSegDist, segSegDist } from '../core/geom2d.js';
import { newId } from '../core/project.js';

const key = (x, y) => `${x},${y}`;

/** 同じネットで穴の縁どうしが近すぎるビアの組 */
export function closeViaPairs(pcb, rules = {}) {
  const need = rules.minSameNetHoleMm ?? 0.254;
  const out = [];
  const v = pcb.vias;
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) {
    const a = v[i], b = v[j];
    if (!a.net || a.net !== b.net) continue;
    const gap = Math.hypot(toMm(a.x - b.x), toMm(a.y - b.y)) - toMm(a.drill) / 2 - toMm(b.drill) / 2;
    if (gap < need - 1e-6) out.push({ a, b, gap });
  }
  return out;
}

/**
 * まとめる
 * @returns { merged: 数, kept: まとめられなかった組 [{net,x,y}] }
 */
export function mergeCloseVias(pcb, rules = {}) {
  const clr = rules.minClearanceMm ?? 0.127;
  const padClr = rules.minPadClearanceMm ?? 0.2;
  let merged = 0;
  const kept = [];
  const tried = new Set();
  for (let guard = 0; guard < 1000; guard++) {
    const pairs = closeViaPairs(pcb, rules).filter((p) => !tried.has(`${p.a.id}|${p.b.id}`));
    if (!pairs.length) break;
    const { a, b } = pairs[0];
    tried.add(`${a.id}|${b.id}`);
    const ends = (v) => pcb.tracks.filter((t) => key(t.a.x, t.a.y) === key(v.x, v.y) || key(t.b.x, t.b.y) === key(v.x, v.y));
    // 配線の少ない方（つなぎビアなど）を消す
    const order = ends(a).length >= ends(b).length ? [[a, b], [b, a]] : [[b, a], [a, b]];
    let done = false;
    for (const [keep, drop] of order) {
      const jumpers = jumpersFor(pcb, keep, drop, ends(drop));
      if (!jumpers.every((j) => jumperOk(pcb, j, keep, drop, clr, padClr))) continue;
      pcb.vias = pcb.vias.filter((v) => v !== drop);
      for (const j of jumpers) if (j.a.x !== j.b.x || j.a.y !== j.b.y) pcb.tracks.push({ id: newId('t'), layer: j.layer, width: j.width, a: j.a, b: j.b, net: keep.net });
      merged++;
      done = true;
      break;
    }
    if (!done) kept.push({ net: a.net, x: toMm(a.x), y: toMm(a.y) });
  }
  return { merged, kept };
}

/** 消すビアにつながっていた層ごとに、消すビア→残すビアの配線 */
function jumpersFor(pcb, keep, drop, tracks) {
  const byLayer = new Map();
  for (const t of tracks) byLayer.set(t.layer, Math.min(byLayer.get(t.layer) ?? Infinity, t.width));
  return [...byLayer].map(([layer, width]) => ({ layer, width, a: { x: drop.x, y: drop.y }, b: { x: keep.x, y: keep.y } }));
}

/** 足す配線が他のネットに近すぎないか */
function jumperOk(pcb, j, keep, drop, clr, padClr) {
  const A = { x: toMm(j.a.x), y: toMm(j.a.y) }, B = { x: toMm(j.b.x), y: toMm(j.b.y) }, w = toMm(j.width) / 2;
  for (const t of pcb.tracks) {
    if (t.layer !== j.layer || t.net === keep.net) continue;
    if (segSegDist(A, B, { x: toMm(t.a.x), y: toMm(t.a.y) }, { x: toMm(t.b.x), y: toMm(t.b.y) }) < w + toMm(t.width) / 2 + clr) return false;
  }
  for (const v of pcb.vias) {
    if (v === drop || v.net === keep.net) continue;
    if (pointSegDist({ x: toMm(v.x), y: toMm(v.y) }, A, B) < w + toMm(v.diameter) / 2 + clr) return false;
  }
  const len = Math.hypot(B.x - A.x, B.y - A.y), n = Math.max(1, Math.ceil(len / 0.05));
  for (const p of allPads(pcb)) {
    if (p.net === keep.net || !p.layers.includes(j.layer)) continue;
    if (Math.hypot(p.x - A.x, p.y - A.y) > Math.max(p.pad.w, p.pad.h) + len + 2) continue;
    for (let k = 0; k <= n; k++) {
      const q = { x: A.x + ((B.x - A.x) * k) / n, y: A.y + ((B.y - A.y) * k) / n };
      if (pointInPad(p.inst, p.pad, q.x, q.y, w + padClr)) return false;
    }
  }
  return true;
}

