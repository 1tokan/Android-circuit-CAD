// 2D 形状の距離計算（DRC 用、単位 mm）
// 形状: { type:'cap', a:{x,y}, b:{x,y}, r }  … 線分＋半径（配線・円形パッド・ビア・穴。円は a=b）
//       { type:'poly', pts:[{x,y}...] }       … 凸多角形（角形パッド）

export function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function segIntersect(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

export function segSegDist(a, b, c, d) {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
}

export function pointInConvex(p, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = cross(pts[i], pts[(i + 1) % pts.length], p);
    if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
  }
  return true;
}

function edges(pts) { return pts.map((p, i) => [p, pts[(i + 1) % pts.length]]); }

function polySegDist(pts, a, b) {
  if (pointInConvex(a, pts) || pointInConvex(b, pts)) return 0;
  let m = Infinity;
  for (const [p, q] of edges(pts)) m = Math.min(m, segSegDist(p, q, a, b));
  return m;
}

function polyPolyDist(A, B) {
  if (A.some((p) => pointInConvex(p, B)) || B.some((p) => pointInConvex(p, A))) return 0;
  let m = Infinity;
  for (const [p, q] of edges(A)) for (const [r, s] of edges(B)) m = Math.min(m, segSegDist(p, q, r, s));
  return m;
}

/** 2形状の隙間（重なっていれば 0 以下） */
export function shapeDist(s, t) {
  if (s.type === 'cap' && t.type === 'cap') return segSegDist(s.a, s.b, t.a, t.b) - s.r - t.r;
  if (s.type === 'poly' && t.type === 'cap') return polySegDist(s.pts, t.a, t.b) - t.r;
  if (s.type === 'cap' && t.type === 'poly') return polySegDist(t.pts, s.a, s.b) - s.r;
  return polyPolyDist(s.pts, t.pts);
}

/** 形状と線分（太さ0）の距離 */
export function shapeSegDist(s, a, b) {
  if (s.type === 'cap') return segSegDist(s.a, s.b, a, b) - s.r;
  return polySegDist(s.pts, a, b);
}

export function shapeBox(s) {
  if (s.type === 'cap') return { x0: Math.min(s.a.x, s.b.x) - s.r, y0: Math.min(s.a.y, s.b.y) - s.r, x1: Math.max(s.a.x, s.b.x) + s.r, y1: Math.max(s.a.y, s.b.y) + s.r };
  const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
export function boxesNear(a, b, gap) {
  return a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
}
export function shapeCenter(s) {
  const b = shapeBox(s);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

// ---- 最も近い位置（DRC の指摘位置に使う） ----
function projOnSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}
/** 2線分の最近点対の中点（交差していれば交点） */
function segSegNear(a, b, c, d) {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (den !== 0) {
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { p: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, d: 0 };
  }
  let best = null;
  for (const [p, s, e] of [[a, c, d], [b, c, d], [c, a, b], [d, a, b]]) {
    const q = projOnSeg(p, s, e);
    const dd = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || dd < best.d) best = { p: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, d: dd };
  }
  return best;
}
const segsOf = (s) => (s.type === 'cap' ? [[s.a, s.b]] : s.pts.map((p, i) => [p, s.pts[(i + 1) % s.pts.length]]));
/** 2形状がいちばん近づく位置（重なっていればその付近） */
export function nearestPoint(s, t) {
  let best = null;
  for (const [a, b] of segsOf(s)) for (const [c, d] of segsOf(t)) {
    const r = segSegNear(a, b, c, d);
    if (!best || r.d < best.d) best = r;
  }
  return best.p;
}
