// PCB 要素 → 2D 形状（DRC・シルク生成で使う。単位 mm、基板座標）
import { toMm, fpToBoard, padLayers } from './model.js';

/** パッドの形状（角形・角丸は四角形として保守的に扱う） */
export function padShape(inst, pad) {
  if (pad.shape === 'circle') {
    const c = fpToBoard(inst, pad.x, pad.y);
    return { type: 'cap', a: c, b: c, r: Math.max(pad.w, pad.h) / 2 };
  }
  if (pad.shape === 'oval') {
    const r = Math.min(pad.w, pad.h) / 2;
    const hx = pad.w / 2 - r, hy = pad.h / 2 - r;
    return { type: 'cap', a: fpToBoard(inst, pad.x - hx, pad.y - hy), b: fpToBoard(inst, pad.x + hx, pad.y + hy), r };
  }
  const hw = pad.w / 2, hh = pad.h / 2;
  return { type: 'poly', pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => fpToBoard(inst, pad.x + dx, pad.y + dy)) };
}

export function trackShape(t) {
  return { type: 'cap', a: { x: toMm(t.a.x), y: toMm(t.a.y) }, b: { x: toMm(t.b.x), y: toMm(t.b.y) }, r: toMm(t.width) / 2 };
}
export function circleShape(xNm, yNm, dNm) {
  const c = { x: toMm(xNm), y: toMm(yNm) };
  return { type: 'cap', a: c, b: c, r: toMm(dNm) / 2 };
}

/**
 * フットプリントのシルク線（フットプリント内座標 mm の線分）。
 * 本体の外形線から、パッドとその周囲（clearance）にかかる部分を切り取る（パッド上にシルクを載せない）。
 */
export function silkSegments(fpDef, clearance = 0.15) {
  const b = fpDef.body;
  if (!b) return [];
  const hw = b.w / 2, hh = b.h / 2;
  const rects = fpDef.pads.map((p) => ({ x0: p.x - p.w / 2 - clearance, x1: p.x + p.w / 2 + clearance, y0: p.y - p.h / 2 - clearance, y1: p.y + p.h / 2 + clearance }));
  const out = [];
  // 水平辺: y 固定で x 区間からパッドを除く
  const cutH = (y) => {
    let iv = [[-hw, hw]];
    for (const r of rects) if (y >= r.y0 && y <= r.y1) iv = subtract(iv, r.x0, r.x1);
    for (const [a, c] of iv) if (c - a > 0.05) out.push({ a: { x: a, y }, b: { x: c, y } });
  };
  const cutV = (x) => {
    let iv = [[-hh, hh]];
    for (const r of rects) if (x >= r.x0 && x <= r.x1) iv = subtract(iv, r.y0, r.y1);
    for (const [a, c] of iv) if (c - a > 0.05) out.push({ a: { x, y: a }, b: { x, y: c } });
  };
  cutH(-hh); cutH(hh); cutV(-hw); cutV(hw);
  return out;
}

function subtract(intervals, a, b) {
  const out = [];
  for (const [s, e] of intervals) {
    if (b <= s || a >= e) { out.push([s, e]); continue; }
    if (a > s) out.push([s, a]);
    if (b < e) out.push([b, e]);
  }
  return out;
}

/** 1 番ピンの印の位置（フットプリント内座標）。パッドの外側、本体の外 */
export function pin1Mark(fpDef) {
  const p1 = fpDef.pads.find((p) => p.num === '1');
  if (!p1 || fpDef.pads.length <= 2 && !fpDef.polarity) return null;
  const sx = p1.x === 0 ? -1 : Math.sign(p1.x);
  return { x: p1.x + sx * (p1.w / 2 + 0.45), y: p1.y };
}

export { padLayers };

/** 部品番号（シルク文字）の位置。描画と DRC で同じ式を使う */
export function refdesPos(inst) {
  const c = inst.fpDef.courtyard;
  const top = fpToBoard({ ...inst, rot: 0 }, 0, c.y0 - 0.3);
  return { x: toMm(inst.x), y: Math.min(top.y, toMm(inst.y) - 0.3), size: 0.9 };
}

/**
 * シルク文字の占める範囲の推定（四角形 poly）。字幅はフォント依存なので 0.62×文字高 で近似。
 * baseline: 'alphabetic'（y が文字の下端付近）| 'central'（y が文字の中心）。中央揃え。
 */
export function textPoly(x, y, size, text, rot = 0, baseline = 'alphabetic') {
  const n = [...String(text)].reduce((s, ch) => s + (/[\u0000-ÿ]/.test(ch) ? 1 : 1.6), 0);
  const w = Math.max(size * 0.4, n * size * 0.62);
  const y0 = baseline === 'central' ? -size / 2 : -size * 0.78, y1 = baseline === 'central' ? size / 2 : size * 0.12;
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { type: 'poly', pts: [[-w / 2, y0], [w / 2, y0], [w / 2, y1], [-w / 2, y1]].map(([dx, dy]) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c })) };
}
