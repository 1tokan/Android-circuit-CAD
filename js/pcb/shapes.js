// PCB 要素 → 2D 形状（DRC・シルク生成で使う。単位 mm、基板座標）
import { toMm, fpToBoard, padLayers, fpBox } from './model.js';
import { textStrokes, strokeWidthFor } from './text.js';

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
  // 回転後の外形枠（外接矩形）の上に置く
  const b = fpBox(inst);
  return { x: (b.x0 + b.x1) / 2, y: b.y0 - 0.3, size: 1.0 };
}

/**
 * シルクの文字すべて（部品番号とユーザー文字）。描画・DRC・Gerber で共通。
 * @returns [{ kind:'refdes'|'text', id, layer:'F.SilkS'|'B.SilkS', text, strokes:[[{x,y}...]...], width, at:{x,y}, size }]
 */
export function silkTexts(pcb) {
  const out = [];
  for (const f of pcb.footprints) {
    if (f.hideRef) continue;
    const rp = refdesPos(f);
    const bottom = f.side === 'bottom';
    out.push({ kind: 'refdes', id: f.id, inst: f, layer: bottom ? 'B.SilkS' : 'F.SilkS', text: f.ref, size: rp.size, width: strokeWidthFor(rp.size), at: { x: rp.x, y: rp.y },
      strokes: textStrokes(f.ref, { x: rp.x, y: rp.y, size: rp.size, mirror: bottom, align: 'center', valign: 'baseline' }) });
  }
  for (const t of pcb.texts) {
    const size = toMm(t.size), x = toMm(t.x), y = toMm(t.y);
    const bottom = t.layer === 'B.SilkS';
    out.push({ kind: 'text', id: t.id, layer: bottom ? 'B.SilkS' : 'F.SilkS', text: t.text, size, width: t.width ? toMm(t.width) : strokeWidthFor(size), at: { x, y },
      strokes: textStrokes(t.text, { x, y, size, rot: t.rot || 0, mirror: bottom, align: 'center', valign: 'center' }) });
  }
  return out;
}
