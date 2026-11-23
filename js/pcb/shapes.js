// PCB 要素 → 2D 形状（DRC・シルク生成で使う。単位 mm、基板座標）
import { toMm, fpToBoard, padLayers, fpBox } from './model.js';
import { textStrokes, strokeWidthFor, textWidth } from './text.js';
import { boardRect } from './model.js';

/** 角丸パッドの角の半径 = 短辺 × この値（画面・Gerber・3D で共通） */
export const ROUNDRECT_RATIO = 0.25;
/** パッドの角の半径（KiCad データはパッドごとの比率 rr を持つことがある） */
export const cornerRadius = (pad) => Math.min(pad.w, pad.h) * (pad.rr ?? ROUNDRECT_RATIO);

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
  const ox = b.cx || 0, oy = b.cy || 0; // 本体の中心（KiCad データでは原点からずれることがある）
  const rects = fpDef.pads.map((p) => ({ x0: p.x - p.w / 2 - clearance, x1: p.x + p.w / 2 + clearance, y0: p.y - p.h / 2 - clearance, y1: p.y + p.h / 2 + clearance }));
  const out = [];
  // 水平辺: y 固定で x 区間からパッドを除く
  const cutH = (y) => {
    let iv = [[ox - hw, ox + hw]];
    for (const r of rects) if (y >= r.y0 && y <= r.y1) iv = subtract(iv, r.x0, r.x1);
    for (const [a, c] of iv) if (c - a > 0.05) out.push({ a: { x: a, y }, b: { x: c, y } });
  };
  const cutV = (x) => {
    let iv = [[oy - hh, oy + hh]];
    for (const r of rects) if (x >= r.x0 && x <= r.x1) iv = subtract(iv, r.y0, r.y1);
    for (const [a, c] of iv) if (c - a > 0.05) out.push({ a: { x, y: a }, b: { x, y: c } });
  };
  cutH(oy - hh); cutH(oy + hh); cutV(ox - hw); cutV(ox + hw);
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
  // 位置を決めてあれば部品の原点からのずれ（mm、基板の向き）。無ければ外形枠（外接矩形）の上
  if (inst.refOffset) return { x: toMm(inst.x) + inst.refOffset.dx, y: toMm(inst.y) + inst.refOffset.dy, size: 1.0 };
  const b = fpBox(inst);
  return { x: (b.x0 + b.x1) / 2, y: b.y0 - 0.3, size: 1.0 };
}

/** 部品番号の文字の外接矩形（基板座標 mm。y はベースラインから上へ size） */
function refBox(inst, x, y) {
  const w = textWidth(inst.ref, 1.0), sw = strokeWidthFor(1.0) / 2;
  return { x0: x - w / 2 - sw, y0: y - 1.0 - sw, x1: x + w / 2 + sw, y1: y + sw };
}
const boxGap = (a, b) => Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);

/** パッドにかかる・基板からはみ出す部品番号のうち、placeRefdes で動かせる数（置き場所のない番号は数えない。チップを押しても直らないため） */
export function refdesConflicts(pcb, { gap = 0.15 } = {}) {
  return placeRefdes(pcb, { gap, dryRun: true }).moved.length;
}

/**
 * 部品番号をパッド・ほかの部品番号に重ならず、基板の内側に収まる位置へ動かす。
 * 候補: 外形枠の上 → 下 → 左 → 右（少しずつずらす）。どこにも置けない部品は元のまま（conflicts に入る）
 * @returns { moved:[ref], conflicts:[ref] }
 */
export function placeRefdes(pcb, { gap = 0.15, dryRun = false, refs = null } = {}) {
  const br = boardRect(pcb);
  const padBoxes = { top: [], bottom: [] };
  for (const f of pcb.footprints) for (const p of f.fpDef.pads) {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => fpToBoard(f, p.x + sx * p.w / 2, p.y + sy * p.h / 2));
    const b = { x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) };
    if (p.type === 'tht') { padBoxes.top.push(b); padBoxes.bottom.push(b); } else padBoxes[f.side === 'bottom' ? 'bottom' : 'top'].push(b);
  }
  const texts = { top: [], bottom: [] };
  const okAt = (side, b) => b.x0 >= br.x0 + 0.2 && b.x1 <= br.x1 - 0.2 && b.y0 >= br.y0 + 0.2 && b.y1 <= br.y1 - 0.2
    && padBoxes[side].every((q) => boxGap(b, q) >= gap) && texts[side].every((q) => boxGap(b, q) >= 0.1);
  const moved = [], conflicts = [];
  const list = pcb.footprints.filter((f) => !f.hideRef);
  // 既に問題のない番号は先に確定（その場所を他の番号が避ける）
  const todo = [];
  for (const f of list) {
    const side = f.side === 'bottom' ? 'bottom' : 'top';
    const rp = refdesPos(f), b = refBox(f, rp.x, rp.y);
    if ((!refs || !refs.includes(f.ref)) && okAt(side, b)) texts[side].push(b);
    else todo.push(f);
  }
  for (const f of todo) {
    const side = f.side === 'bottom' ? 'bottom' : 'top';
    const fb = fpBox(f), cx = (fb.x0 + fb.x1) / 2, cy = (fb.y0 + fb.y1) / 2, w = textWidth(f.ref, 1.0);
    const cands = [];
    for (const d of [0.3, 0.6, 1.0, 1.5]) {
      for (const sx of [0, -1, 1, -2, 2]) {
        cands.push([cx + sx * 0.5, fb.y0 - d]);           // 上
        cands.push([cx + sx * 0.5, fb.y1 + 1.0 + d]);     // 下
      }
      for (const sy of [0, -1, 1]) {
        cands.push([fb.x0 - d - w / 2, cy + 0.5 + sy * 0.5]); // 左
        cands.push([fb.x1 + d + w / 2, cy + 0.5 + sy * 0.5]); // 右
      }
    }
    let done = false;
    for (const [x, y] of cands) {
      const b = refBox(f, x, y);
      if (!okAt(side, b)) continue;
      texts[side].push(b);
      if (!dryRun) f.refOffset = { dx: Math.round((x - toMm(f.x)) * 1000) / 1000, dy: Math.round((y - toMm(f.y)) * 1000) / 1000 };
      moved.push(f.ref); done = true; break;
    }
    if (!done) conflicts.push(f.ref);
  }
  return { moved, conflicts };
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
