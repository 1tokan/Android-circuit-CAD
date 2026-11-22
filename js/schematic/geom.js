// 回路図の幾何計算（純粋関数）
// 座標系: 1単位 = 0.05inch(1.27mm)。y軸は下向き。部品・配線の点は整数グリッド。

/** シンボル内ローカル座標 → シート座標。mirror は左右反転（回転前に適用）。rot は 0/90/180/270（時計回り） */
export function xform(p, comp) {
  let x = comp.mirror ? -p.x : p.x;
  let y = p.y;
  switch (((comp.rot % 360) + 360) % 360) {
    case 90: [x, y] = [-y, x]; break;
    case 180: [x, y] = [-x, -y]; break;
    case 270: [x, y] = [y, -x]; break;
    default: break;
  }
  return { x: x + comp.x, y: y + comp.y };
}

/** SVG の transform 属性（xform と同じ変換） */
export function svgTransform(comp) {
  return `translate(${comp.x} ${comp.y}) rotate(${comp.rot || 0})${comp.mirror ? ' scale(-1 1)' : ''}`;
}

export const key = (x, y) => `${x},${y}`;
export const samePt = (a, b) => a.x === b.x && a.y === b.y;

/** 点 p が線分 a-b 上にあるか（端点を含む）。整数座標前提で厳密判定 */
export function onSegment(p, a, b) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (cross !== 0) return false;
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) &&
         p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** 点 p が線分の端点を除く内部にあるか */
export function onSegmentInterior(p, a, b) {
  return onSegment(p, a, b) && !samePt(p, a) && !samePt(p, b);
}

/** 点と線分の距離（ヒットテスト用、実数） */
export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export const snap = (v, g = 1) => Math.round(v / g) * g;
export const snapPt = (p, g = 1) => ({ x: snap(p.x, g), y: snap(p.y, g) });

/** 矩形 {x0,y0,x1,y1} を変換（回転・反転後の外接矩形） */
export function xformRect(r, comp) {
  const pts = [
    xform({ x: r.x0, y: r.y0 }, comp), xform({ x: r.x1, y: r.y0 }, comp),
    xform({ x: r.x0, y: r.y1 }, comp), xform({ x: r.x1, y: r.y1 }, comp),
  ];
  return {
    x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)),
  };
}

export const rectContains = (r, p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
export const rectInside = (inner, outer) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
export function normRect(a, b) {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** 点 p を中心 c で時計回りに90°回転 */
export function rot90About(p, c) {
  return { x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) };
}
/** 点 p を中心 c の縦軸で左右反転 */
export function mirrorAbout(p, c) {
  return { x: 2 * c.x - p.x, y: p.y };
}
