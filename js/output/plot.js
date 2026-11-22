// 製造データの中間表現（層ごとの図形の一覧）。Gerber 出力と画面のプレビューは、どちらもこれから作る。
// 座標は基板座標 mm（y 下向き）。Gerber への書き出し時に y を反転する。
//
// 図形:
//  { t:'flash', ap:{...}, at:{x,y}, fn }      … パッド・ビアなど（アパーチャを置く）
//     ap: { kind:'C', d } 円 | { kind:'R', w, h } 長方形(軸平行) | { kind:'O', w, h } 長円(軸平行)
//         { kind:'RoundRect', r, corners:[{x,y}x4] } 角丸（角の円の中心4点、任意の回転）
//         { kind:'OutlineRect', corners:[{x,y}x4] } 回転した長方形
//         { kind:'Oval', a:{x,y}, b:{x,y}, d } 回転した長円（両端の円の中心と直径）
//     ※ RoundRect/OutlineRect/Oval の座標はフラッシュ位置からの相対
//  { t:'line', a, b, w, fn }                    … 配線・シルク線・外形（円形アパーチャで描く）
//  { t:'region', rings:[[x,y]...], dark, fn }    … ベタ（外周は dark、穴は clear で抜く）
// fn: X2 の .AperFunction（Conductor / SMDPad,CuDef / ComponentPad / ViaPad / Profile / NonConductor など）

import { allPads, toMm, boardRect, fpToBoard, copperLayers, layerName, padHole } from '../pcb/model.js';
import { silkSegments, pin1Mark, silkTexts, cornerRadius } from '../pcb/shapes.js';
import { SILK_LINE_MM } from '../pcb/text.js';
import { cachedFills, ringArea } from '../pcb/zonefill.js';
import { drcRules } from '../check/drc.js';

export const EDGE_LINE_MM = 0.05;

const NON_COPPER = [
  { id: 'F.Mask', name: '表 レジスト（開口）', ext: 'gts', func: 'Soldermask,Top', polarity: 'Negative' },
  { id: 'B.Mask', name: '裏 レジスト（開口）', ext: 'gbs', func: 'Soldermask,Bot', polarity: 'Negative' },
  { id: 'F.SilkS', name: '表 シルク', ext: 'gto', func: 'Legend,Top', polarity: 'Positive' },
  { id: 'B.SilkS', name: '裏 シルク', ext: 'gbo', func: 'Legend,Bot', polarity: 'Positive' },
  { id: 'F.Paste', name: '表 メタルマスク', ext: 'gtp', func: 'Paste,Top', polarity: 'Positive' },
  { id: 'B.Paste', name: '裏 メタルマスク', ext: 'gbp', func: 'Paste,Bot', polarity: 'Positive' },
  { id: 'Edge.Cuts', name: '基板外形', ext: 'gm1', func: 'Profile,NP', polarity: 'Positive' },
];

/**
 * 層数に応じた Gerber の層の一覧。内層は JLCPCB が認識する .g1 .g2 …（表側から順）
 */
export function layerDefs(layers = 2) {
  const cu = copperLayers(layers);
  const copper = cu.map((id, i) => ({
    id,
    name: `${layerName(id)} 銅箔（L${i + 1}）`,
    ext: id === 'F.Cu' ? 'gtl' : id === 'B.Cu' ? 'gbl' : `g${i}`,
    func: id === 'F.Cu' ? 'Copper,L1,Top' : id === 'B.Cu' ? `Copper,L${layers},Bot` : `Copper,L${i + 1},Inr`,
    polarity: 'Positive',
  }));
  return [...copper, ...NON_COPPER];
}
/** 2層の一覧（後方互換） */
export const LAYERS = layerDefs(2);

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const near90 = (deg) => { const m = ((deg % 90) + 90) % 90; return m < 1e-6 || 90 - m < 1e-6; };

/** パッドの総回転角（度）。裏面は左右反転してから回転 */
function padAngle(inst) { return ((inst.rot || 0) % 360 + 360) % 360; }

/**
 * パッド形状 → アパーチャ（grow: 片側の拡大量。レジスト開口用）
 */
export function padAperture(inst, pad, grow = 0) {
  const w = pad.w + 2 * grow, h = pad.h + 2 * grow;
  const ang = padAngle(inst);
  const c = fpToBoard(inst, pad.x, pad.y);
  // 部品内の向き → 基板上の相対座標
  const rel = (dx, dy) => { const p = fpToBoard(inst, pad.x + dx, pad.y + dy); return { x: r4(p.x - c.x), y: r4(p.y - c.y) }; };
  const swap = near90(ang) && Math.round(ang / 90) % 2 === 1;
  if (pad.shape === 'circle') return { kind: 'C', d: r4(Math.max(w, h)) };
  if (pad.shape === 'oval') {
    if (near90(ang)) return { kind: 'O', w: r4(swap ? h : w), h: r4(swap ? w : h) };
    const d = Math.min(w, h), hx = w / 2 - d / 2, hy = h / 2 - d / 2;
    return { kind: 'Oval', a: rel(-hx, -hy), b: rel(hx, hy), d: r4(d) };
  }
  if (pad.shape === 'roundrect') {
    const r = cornerRadius(pad) + grow;
    const ix = w / 2 - r, iy = h / 2 - r;
    return { kind: 'RoundRect', r: r4(r), corners: [rel(-ix, -iy), rel(ix, -iy), rel(ix, iy), rel(-ix, iy)] };
  }
  if (near90(ang)) return { kind: 'R', w: r4(swap ? h : w), h: r4(swap ? w : h) };
  return { kind: 'OutlineRect', corners: [rel(-w / 2, -h / 2), rel(w / 2, -h / 2), rel(w / 2, h / 2), rel(-w / 2, h / 2)] };
}

/**
 * 製造データの図形一覧を作る
 * @returns {{ layers: Object<string, prim[]>, drills: { pth:[{x,y,d,fn}], npth:[{x,y,d}] }, board, notes:[string], options }}
 */
export function buildPlot(project, pcb, opt = {}) {
  const R = drcRules(project);
  const fab = project.board?.fab || {};
  // ビアの処理: 覆う（テンティング）・穴埋め・充填はレジストを開けない。開口のときだけ開ける
  const tentVias = opt.tentVias ?? (fab.viaProcess || 'tented') !== 'untented';
  const nLayers = pcb.settings?.layers || 2;
  const defs = layerDefs(nLayers);
  const mask = R.maskExpansionMm ?? 0.05;
  const L = Object.fromEntries(defs.map((l) => [l.id, []]));
  const notes = [];

  // ---- ベタ（銅箔の一番下に置く。あとから描く配線・パッドが上に重なる） ----
  const { fills } = cachedFills(pcb, R);
  for (const z of pcb.zones) {
    const f = fills.get(z.id);
    if (!f || !L[z.layer]) continue; // 層数を減らして無くなった層（DRC でエラー）
    // 外周の面積が大きい順（穴の中の島は、穴を抜いた後に描かれる）
    const polys = [...f.polygons].sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])));
    for (const poly of polys) {
      L[z.layer].push({ t: 'region', rings: poly[0], dark: true, fn: 'Conductor' });
      for (const hole of poly.slice(1)) L[z.layer].push({ t: 'region', rings: hole, dark: false, fn: 'Conductor' });
    }
  }
  // ---- 配線 ----
  for (const t of pcb.tracks) {
    if (!L[t.layer]) continue; // 層数を減らして無くなった層（DRC でエラー）
    L[t.layer].push({ t: 'line', a: { x: toMm(t.a.x), y: toMm(t.a.y) }, b: { x: toMm(t.b.x), y: toMm(t.b.y) }, w: toMm(t.width), fn: 'Conductor' });
  }
  // ---- パッド ----
  const pthDrills = [];
  for (const p of allPads(pcb)) {
    const smd = p.pad.type !== 'tht';
    const at = { x: p.x, y: p.y };
    for (const cu of p.layers) {
      L[cu].push({ t: 'flash', ap: padAperture(p.inst, p.pad), at, fn: smd ? 'SMDPad,CuDef' : 'ComponentPad' });
      if (cu !== 'F.Cu' && cu !== 'B.Cu') continue; // 内層にはレジスト・メタルマスクが無い
      const side = cu === 'F.Cu' ? 'F' : 'B';
      L[`${side}.Mask`].push({ t: 'flash', ap: padAperture(p.inst, p.pad, mask), at, fn: smd ? 'SMDPad,CuDef' : 'ComponentPad' });
      if (smd && !p.inst.dnp) L[`${side}.Paste`].push({ t: 'flash', ap: padAperture(p.inst, p.pad), at, fn: 'SMDPad,CuDef' });
    }
    if (!smd) {
      const h = padHole(p.inst, p.pad);
      pthDrills.push(h.slot ? { x: p.x, y: p.y, d: h.d, fn: 'ComponentDrill', slot: { a: h.a, b: h.b } } : { x: p.x, y: p.y, d: p.pad.drill, fn: 'ComponentDrill' });
    }
  }
  // ---- ビア ----
  for (const v of pcb.vias) {
    const at = { x: toMm(v.x), y: toMm(v.y) };
    for (const cu of copperLayers(pcb)) L[cu].push({ t: 'flash', ap: { kind: 'C', d: toMm(v.diameter) }, at, fn: 'ViaPad' });
    if (!tentVias) for (const m of ['F.Mask', 'B.Mask']) L[m].push({ t: 'flash', ap: { kind: 'C', d: toMm(v.diameter) + 2 * mask }, at, fn: 'ViaPad' });
    pthDrills.push({ x: at.x, y: at.y, d: toMm(v.drill), fn: 'ViaDrill' });
  }
  // ---- 取付穴（非メッキ）: レジストを開ける ----
  const npth = pcb.holes.map((h) => ({ x: toMm(h.x), y: toMm(h.y), d: toMm(h.drill) }));
  for (const h of npth) for (const m of ['F.Mask', 'B.Mask']) L[m].push({ t: 'flash', ap: { kind: 'C', d: r4(h.d + 2 * mask) }, at: { x: h.x, y: h.y }, fn: 'NonConductor' });

  // ---- シルク ----
  for (const f of pcb.footprints) {
    const layer = f.side === 'bottom' ? 'B.SilkS' : 'F.SilkS';
    for (const s of silkSegments(f.fpDef)) {
      L[layer].push({ t: 'line', a: fpToBoard(f, s.a.x, s.a.y), b: fpToBoard(f, s.b.x, s.b.y), w: SILK_LINE_MM, fn: 'NonConductor' });
    }
    const m = pin1Mark(f.fpDef);
    if (m) L[layer].push({ t: 'flash', ap: { kind: 'C', d: 0.4 }, at: fpToBoard(f, m.x, m.y), fn: 'NonConductor' });
  }
  for (const t of silkTexts(pcb)) {
    for (const st of t.strokes) {
      if (st.length === 1) { L[t.layer].push({ t: 'flash', ap: { kind: 'C', d: t.width }, at: st[0], fn: 'NonConductor' }); continue; }
      for (let k = 1; k < st.length; k++) L[t.layer].push({ t: 'line', a: st[k - 1], b: st[k], w: t.width, fn: 'NonConductor' });
    }
  }

  // ---- 外形 ----
  const br = boardRect(pcb);
  const corners = [{ x: br.x0, y: br.y0 }, { x: br.x1, y: br.y0 }, { x: br.x1, y: br.y1 }, { x: br.x0, y: br.y1 }];
  for (let i = 0; i < 4; i++) L['Edge.Cuts'].push({ t: 'line', a: corners[i], b: corners[(i + 1) % 4], w: EDGE_LINE_MM, fn: 'Profile' });

  if (pcb.footprints.some((f) => f.dnp)) notes.push('未実装（DNP）の部品はメタルマスクを開けていません');
  if (tentVias) notes.push('ビアはレジストの開口なし（製造仕様のビア処理に従う）');
  return {
    layers: L,
    layerDefs: defs,
    layerCount: nLayers,
    drills: { pth: pthDrills, npth },
    board: { ...br, w: br.x1 - br.x0, h: br.y1 - br.y0 },
    notes,
    options: { tentVias, maskExpansionMm: mask },
  };
}

/** 図形の一覧の外接範囲（プレビュー用） */
export function plotBounds(plot) {
  const b = plot.board;
  return { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 };
}
