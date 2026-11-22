// DRC（基板設計ルール検査）。PCB の形状（mm）から検査する。
// 結果の各項目: { level:'error'|'warning', rule, message, refs, at:{x,y} 基板座標mm | null }
// 「検査した項目」と「検査していない項目」を結果に必ず含める（未実装の検査を検査済みと表示しないため）。
//
// 既定値は JLCPCB の 1〜2 層標準品の製造能力（2026年11月確認）に合わせる。プロジェクトの board.rules で上書きできる。

import { allPads, toMm, boardRect, fpBox, pointInPad, distToSeg, copperLayers, layerName } from '../pcb/model.js';
import { computePcbConnectivity } from '../pcb/connectivity.js';
import { padShape, trackShape, circleShape, silkSegments, silkTexts } from '../pcb/shapes.js';
import { SILK_LINE_MM, unsupportedChars } from '../pcb/text.js';
import { fpToBoard } from '../pcb/model.js';
import { shapeDist, shapeSegDist, shapeBox, boxesNear, shapeCenter, nearestPoint, pointInRing } from '../core/geom2d.js';
import { hash, sourceHash } from '../netlist/netlist.js';

export { DRC_DEFAULTS, drcRules } from './rules.js';
import { drcRules } from './rules.js';

export const DRC_RULES = [
  { id: 'layer_missing', label: '層数より外の層（減らした内層）に残った配線・ベタ' },
  { id: 'track_width', label: '配線幅の最小値' },
  { id: 'via_size', label: 'ビアの外径・穴径・ランド幅' },
  { id: 'pad_drill', label: 'スルーホールパッドの穴径・ランド幅' },
  { id: 'short', label: '異なるネットの銅の接触（短絡）' },
  { id: 'clearance', label: '異なるネットの銅の間隔（配線・パッド・ビア、同じ層）' },
  { id: 'edge_clearance', label: '銅と基板外形の間隔・基板外の銅' },
  { id: 'hole_to_hole', label: '異なるネットの穴どうしの間隔' },
  { id: 'npth_clearance', label: '取付穴（非メッキ）と銅の間隔' },
  { id: 'unrouted', label: '未配線の接続（ラッツネスト）' },
  { id: 'dangling_track', label: '端が何にも接続されていない配線' },
  { id: 'track_net', label: '配線のネットと、つながっているパッドのネットの食い違い' },
  { id: 'outside_board', label: '基板の外に置かれた部品・はみ出した部品' },
  { id: 'courtyard_overlap', label: '同じ面の部品どうしの重なり（外形枠）' },
  { id: 'silk_pad', label: 'シルク（部品番号・文字・他部品の外形線）とパッドの重なり（文字幅は推定）' },
  { id: 'silk_outside', label: '基板の外のシルク文字' },
  { id: 'silk_size', label: 'シルク文字の高さ・線幅、出力できない文字（ASCII以外）' },
  { id: 'mask_bridge', label: 'レジストのブリッジ幅（隣り合うパッドの開口の間に残るレジスト）' },
  { id: 'zone_fill', label: 'ベタの塗りつぶし: 別ネットの銅とのクリアランス（計算結果を独立に再検査）・取り除いた島・空のベタ' },
  { id: 'netlist_sync', label: '回路図（ネットリスト）との一致・未配置の部品' },
  { id: 'footprint_unverified', label: '未照合・自動生成のフットプリント' },
  { id: 'zone_overlap', label: '同じ層で重なる別ネットのベタ' },
];

export const DRC_UNCHECKED = [
  'ベタの細い部分（最小幅）の除去。細いくびれが残ることがあります',
  'メタルマスク（ペースト）',
  '銅の細片（スリバー）・鋭角部（アシッドトラップ）',
  '部品の高さ・3D干渉',
  '取付穴（非メッキ）の穴径の範囲',
  '差動ペア・等長配線・インピーダンス',
  '部品外形枠は回転を含む外接矩形で近似（斜め配置は大きめに判定）',
];

const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

/**
 * @returns {{ kind, ranAt, pcbHash, rules, issues, checked, unchecked, summary }}
 */
export function runDrc(project, pcb, { now = new Date().toISOString(), limit = 300 } = {}) {
  const R = drcRules(project);
  const issues = [];
  let dropped = 0;
  const add = (level, rule, message, refs = [], at = null) => {
    if (issues.length >= limit) { dropped++; return; }
    issues.push({ level, rule, message, refs, at });
  };
  const br = boardRect(pcb);
  const edges = [[{ x: br.x0, y: br.y0 }, { x: br.x1, y: br.y0 }], [{ x: br.x1, y: br.y0 }, { x: br.x1, y: br.y1 }], [{ x: br.x1, y: br.y1 }, { x: br.x0, y: br.y1 }], [{ x: br.x0, y: br.y1 }, { x: br.x0, y: br.y0 }]];
  const inside = (p) => p.x >= br.x0 && p.x <= br.x1 && p.y >= br.y0 && p.y <= br.y1;

  const conn = computePcbConnectivity(pcb, { rules: R });
  const pads = allPads(pcb);

  // ---- 銅の要素と実効ネット ----
  // パッドのネットはネットリスト由来。配線・ビアは自身のネット、無ければつながったパッドのネット。
  const groupNets = new Map();
  for (const p of pads) {
    if (!p.net) continue;
    const g = conn.groupOf(p.key);
    if (!groupNets.has(g)) groupNets.set(g, new Set());
    groupNets.get(g).add(p.net);
  }
  const groupNet = (key) => { const s = groupNets.get(conn.groupOf(key)); return s && s.size === 1 ? [...s][0] : null; };
  const items = [];
  for (const p of pads) {
    const shape = padShape(p.inst, p.pad);
    items.push({ kind: 'pad', key: p.key, layers: p.layers, net: p.net || `~${p.inst.id}:${p.pad.num}`, shape, box: shapeBox(shape), ref: p.ref, label: `${p.ref}-${p.pad.num}`, inst: p.inst, pad: p.pad });
  }
  for (const t of pcb.tracks) {
    const shape = trackShape(t);
    items.push({ kind: 'track', key: `t:${t.id}`, layers: [t.layer], net: t.net || groupNet(`t:${t.id}`) || `~t:${t.id}`, shape, box: shapeBox(shape), label: '配線', t });
  }
  for (const v of pcb.vias) {
    const shape = circleShape(v.x, v.y, v.diameter);
    items.push({ kind: 'via', key: `v:${v.id}`, layers: copperLayers(pcb), net: v.net || groupNet(`v:${v.id}`) || `~v:${v.id}`, shape, box: shapeBox(shape), label: 'ビア', v });
  }
  const netName = (n) => (n.startsWith('~') ? 'ネットなし' : n);

  // ---- 層 ----
  const cuSet = new Set(copperLayers(pcb));
  for (const t of pcb.tracks) if (!cuSet.has(t.layer)) add('error', 'layer_missing', `配線が無い層 ${t.layer} にあります（層数 ${cuSet.size}）。層を変えるか削除してください`, [], mid(t));
  for (const z of pcb.zones) if (!cuSet.has(z.layer)) add('error', 'layer_missing', `ベタが無い層 ${z.layer} にあります（層数 ${cuSet.size}）`, [], null);

  // ---- 寸法 ----
  for (const t of pcb.tracks) {
    const w = toMm(t.width);
    if (w + 1e-9 < R.minTrackWidthMm) add('error', 'track_width', `配線幅 ${fmt(w)}mm が最小 ${R.minTrackWidthMm}mm 未満です（${t.net || 'ネットなし'}）`, [], mid(t));
  }
  for (const v of pcb.vias) {
    const d = toMm(v.diameter), dr = toMm(v.drill), at = { x: toMm(v.x), y: toMm(v.y) };
    if (dr + 1e-9 < R.minViaDrillMm) add('error', 'via_size', `ビアの穴径 ${fmt(dr)}mm が最小 ${R.minViaDrillMm}mm 未満です`, [], at);
    if (d + 1e-9 < R.minViaDiameterMm) add('error', 'via_size', `ビアの外径 ${fmt(d)}mm が最小 ${R.minViaDiameterMm}mm 未満です`, [], at);
    if ((d - dr) / 2 + 1e-9 < R.minViaAnnularMm) add('error', 'via_size', `ビアのランド幅 ${fmt((d - dr) / 2)}mm が最小 ${R.minViaAnnularMm}mm 未満です（外径${fmt(d)}/穴${fmt(dr)}）`, [], at);
    if (dr > R.maxDrillMm) add('error', 'via_size', `ビアの穴径 ${fmt(dr)}mm が最大 ${R.maxDrillMm}mm を超えています`, [], at);
  }
  for (const p of pads) {
    if (p.pad.type !== 'tht') continue;
    const dr = p.pad.drill, ring = (Math.min(p.pad.w, p.pad.h) - dr) / 2, at = { x: p.x, y: p.y };
    if (dr + 1e-9 < R.minPthDrillMm || dr > R.maxDrillMm) add('error', 'pad_drill', `${p.ref}-${p.pad.num}: 穴径 ${fmt(dr)}mm が範囲 ${R.minPthDrillMm}〜${R.maxDrillMm}mm の外です`, [p.ref], at);
    if (ring + 1e-9 < R.minAnnularRingMm) add('error', 'pad_drill', `${p.ref}-${p.pad.num}: ランド幅 ${fmt(ring)}mm が最小 ${R.minAnnularRingMm}mm 未満です`, [p.ref], at);
  }

  // ---- 銅どうしの間隔・短絡（同じ層、異なるネット） ----
  const maxClr = Math.max(R.minClearanceMm, R.minPadClearanceMm);
  const sorted = [...items].sort((a, b) => a.box.x0 - b.box.x0);
  const shortPairs = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const A = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const B = sorted[j];
      if (B.box.x0 > A.box.x1 + maxClr) break;
      if (A.net === B.net) continue;
      if (!A.layers.some((l) => B.layers.includes(l))) continue;
      if (!boxesNear(A.box, B.box, maxClr)) continue;
      const need = (A.kind === 'pad') !== (B.kind === 'pad') ? R.minPadClearanceMm : R.minClearanceMm;
      const gap = shapeDist(A.shape, B.shape);
      if (gap >= need - 1e-6) continue;
      const at = nearestPoint(A.shape, B.shape);
      const refs = [A.ref, B.ref].filter(Boolean);
      if (gap <= 1e-6) {
        const k = [netName(A.net), netName(B.net)].sort().join('|');
        add('error', 'short', `短絡: ${A.label}（${netName(A.net)}）と ${B.label}（${netName(B.net)}）が接触しています`, refs, at);
        shortPairs.add(k);
      } else {
        add('error', 'clearance', `間隔不足: ${A.label}（${netName(A.net)}）と ${B.label}（${netName(B.net)}）の間隔 ${fmt(gap)}mm（最小 ${need}mm）`, refs, at);
      }
    }
  }

  // ---- 基板外形 ----
  // 内層の銅は外形からさらに離す（4・6層）
  const isInner = (l) => /^In\d\.Cu$/.test(l);
  const edgeNeed = (it) => (it.layers.some(isInner) ? Math.max(R.boardEdgeClearanceMm, R.innerEdgeClearanceMm) : R.boardEdgeClearanceMm);
  for (const it of items) {
    const c = shapeCenter(it.shape);
    let d = Infinity, near = null;
    for (const [a, b] of edges) { const e = shapeSegDist(it.shape, a, b); if (e < d) { d = e; near = [a, b]; } }
    if (!inside(c)) {
      if (it.kind === 'pad') continue; // 部品ごと基板外 → outside_board で報告
      add('error', 'edge_clearance', `${it.label} が基板の外にあります`, it.ref ? [it.ref] : [], c);
    } else if (d < edgeNeed(it) - 1e-6) {
      add('error', 'edge_clearance', `${it.label} と基板外形の間隔 ${fmt(Math.max(0, d))}mm（最小 ${edgeNeed(it)}mm${it.layers.some(isInner) ? '・内層を含む' : ''}）`, it.ref ? [it.ref] : [], nearestPoint(it.shape, { type: 'cap', a: near[0], b: near[1], r: 0 }));
    }
  }

  // ---- 穴 ----
  const drills = [];
  for (const p of pads) if (p.pad.type === 'tht') drills.push({ c: { x: p.x, y: p.y }, r: p.pad.drill / 2, net: p.net || `~${p.inst.id}:${p.pad.num}`, label: `${p.ref}-${p.pad.num}`, ref: p.ref });
  for (const v of pcb.vias) drills.push({ c: { x: toMm(v.x), y: toMm(v.y) }, r: toMm(v.drill) / 2, net: v.net || `~v:${v.id}`, label: 'ビア' });
  for (const h of pcb.holes) drills.push({ c: { x: toMm(h.x), y: toMm(h.y) }, r: toMm(h.drill) / 2, net: `~h:${h.id}`, label: `取付穴 φ${fmt(toMm(h.drill))}`, npth: true });
  for (let i = 0; i < drills.length; i++) for (let j = i + 1; j < drills.length; j++) {
    const a = drills[i], b = drills[j];
    if (a.net === b.net) continue;
    const gap = Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) - a.r - b.r;
    if (gap < R.minHoleToHoleMm - 1e-6) add('error', 'hole_to_hole', `穴の間隔不足: ${a.label} と ${b.label}（縁どうし ${fmt(Math.max(0, gap))}mm、最小 ${R.minHoleToHoleMm}mm）`, [a.ref, b.ref].filter(Boolean), midPt(a.c, b.c));
  }
  for (const h of pcb.holes) {
    const hs = circleShape(h.x, h.y, h.drill);
    for (const it of items) {
      const gap = shapeDist(hs, it.shape);
      if (gap < R.minNpthToCopperMm - 1e-6) add('error', 'npth_clearance', `取付穴と ${it.label} の間隔 ${fmt(Math.max(0, gap))}mm（最小 ${R.minNpthToCopperMm}mm）`, it.ref ? [it.ref] : [], { x: toMm(h.x), y: toMm(h.y) });
    }
    const c = { x: toMm(h.x), y: toMm(h.y) };
    if (!inside(c)) add('error', 'edge_clearance', '取付穴が基板の外にあります', [], c);
  }

  // ---- 未配線 ----
  const byNet = new Map();
  for (const l of conn.ratsnest) { if (!byNet.has(l.net)) byNet.set(l.net, []); byNet.get(l.net).push(l); }
  for (const [net, list] of byNet) {
    add('error', 'unrouted', `ネット ${net}: 未配線の接続が ${list.length} 本あります`, [], midPt(list[0].a, list[0].b));
  }

  // ---- 配線の端・ネットの食い違い ----
  const trackPts = pcb.tracks.map((t) => ({ t, a: { x: toMm(t.a.x), y: toMm(t.a.y) }, b: { x: toMm(t.b.x), y: toMm(t.b.y) }, hw: toMm(t.width) / 2 }));
  let dangling = 0;
  for (const tr of trackPts) {
    for (const e of [tr.a, tr.b]) {
      const onPad = pads.some((p) => p.layers.includes(tr.t.layer) && pointInPad(p.inst, p.pad, e.x, e.y));
      const onVia = pcb.vias.some((v) => Math.hypot(e.x - toMm(v.x), e.y - toMm(v.y)) <= toMm(v.diameter) / 2 + 1e-4);
      const onTrack = trackPts.some((o) => o !== tr && o.t.layer === tr.t.layer && distToSeg(e, o.a, o.b) <= Math.max(1e-4, o.hw));
      if (!onPad && !onVia && !onTrack) { dangling++; add('warning', 'dangling_track', `配線の端 (${fmt(e.x)}, ${fmt(e.y)}) が何にも接続されていません（${tr.t.net || 'ネットなし'}）`, [], e); }
    }
    if (tr.t.net) {
      const s = groupNets.get(conn.groupOf(`t:${tr.t.id}`));
      if (s && s.size === 1 && !s.has(tr.t.net)) add('warning', 'track_net', `配線のネット ${tr.t.net} と、つながっているパッドのネット ${[...s][0]} が異なります`, [], mid(tr.t));
    }
  }

  // ---- 部品の配置 ----
  const boxes = pcb.footprints.map((f) => ({ f, b: fpBox(f) }));
  for (const { f, b } of boxes) {
    const at = { x: toMm(f.x), y: toMm(f.y) };
    const fully = b.x1 < br.x0 || b.x0 > br.x1 || b.y1 < br.y0 || b.y0 > br.y1;
    const contained = b.x0 >= br.x0 - 1e-6 && b.x1 <= br.x1 + 1e-6 && b.y0 >= br.y0 - 1e-6 && b.y1 <= br.y1 + 1e-6;
    if (fully) add('error', 'outside_board', `${f.ref} が基板の外に置かれています（未配置）`, [f.ref], at);
    else if (!contained) add('warning', 'outside_board', `${f.ref} の外形枠が基板の端からはみ出しています（基板端のコネクタ以外は内側へ）`, [f.ref], at);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], B = boxes[j];
    if ((A.f.side || 'top') !== (B.f.side || 'top')) continue;
    const ox = Math.min(A.b.x1, B.b.x1) - Math.max(A.b.x0, B.b.x0), oy = Math.min(A.b.y1, B.b.y1) - Math.max(A.b.y0, B.b.y0);
    if (ox > 0.01 && oy > 0.01) add('warning', 'courtyard_overlap', `${A.f.ref} と ${B.f.ref} の外形枠が重なっています`, [A.f.ref, B.f.ref], { x: (Math.max(A.b.x0, B.b.x0) + Math.min(A.b.x1, B.b.x1)) / 2, y: (Math.max(A.b.y0, B.b.y0) + Math.min(A.b.y1, B.b.y1)) / 2 });
  }

  // ---- シルク ----
  // 文字は実際に出力するストローク（太さ込み）で判定する
  const padsOnSide = (side) => items.filter((it) => it.kind === 'pad' && it.layers.includes(side === 'bottom' ? 'B.Cu' : 'F.Cu'));
  const unplaced = new Set(issues.filter((i) => i.rule === 'outside_board' && i.level === 'error').map((i) => i.refs[0]));
  for (const t of silkTexts(pcb)) {
    if (t.kind === 'refdes' && unplaced.has(t.text)) continue;
    const name = t.kind === 'refdes' ? `部品番号 ${t.text}` : `文字「${t.text}」`;
    const refs = t.kind === 'refdes' ? [t.text] : [];
    const side = t.layer === 'B.SilkS' ? 'bottom' : 'top';
    const pads2 = padsOnSide(side);
    const hits = new Set();
    for (const st of t.strokes) for (let k = 1; k < st.length; k++) {
      const seg = { type: 'cap', a: st[k - 1], b: st[k], r: t.width / 2 };
      const sb = shapeBox(seg);
      for (const it of pads2) if (boxesNear(sb, it.box, R.minSilkToPadMm) && shapeDist(seg, it.shape) < R.minSilkToPadMm - 1e-6) hits.add(it);
    }
    if (hits.size) add('warning', 'silk_pad', `${name} のシルクがパッド ${[...hits].slice(0, 3).map((h) => h.label).join(', ')} にかかっています（製造時に削られます）`, refs, t.at);
    if (!inside(t.at)) add('warning', 'silk_outside', `${name} が基板の外です`, refs, t.at);
    if (t.size + 1e-9 < R.minSilkTextHeightMm) add('warning', 'silk_size', `${name} の高さ ${fmt(t.size)}mm が最小 ${R.minSilkTextHeightMm}mm 未満です（読めなくなります）`, refs, t.at);
    if (t.width + 1e-9 < R.minSilkWidthMm) add('warning', 'silk_size', `${name} の線幅 ${fmt(t.width)}mm が最小 ${R.minSilkWidthMm}mm 未満です`, refs, t.at);
    const bad = unsupportedChars(t.text);
    if (bad.length) add('error', 'silk_size', `${name} に出力できない文字があります: ${bad.join(' ')}（英数字・記号のみ。「?」で出力されます）`, refs, t.at);
  }
  if (SILK_LINE_MM < R.minSilkWidthMm) add('warning', 'silk_size', `部品外形のシルク線幅 ${SILK_LINE_MM}mm が最小 ${R.minSilkWidthMm}mm 未満です`, [], null);
  for (const f of pcb.footprints) {
    if (unplaced.has(f.ref)) continue;
    // 外形線は自分のパッドの周りで切ってあるので、他の部品のパッドとだけ比べる
    const segs = silkSegments(f.fpDef);
    const others = padsOnSide(f.side).filter((it) => it.inst !== f);
    let hit = null;
    for (const s2 of segs) {
      const a = fpToBoard(f, s2.a.x, s2.a.y), b = fpToBoard(f, s2.b.x, s2.b.y);
      hit = others.find((it) => shapeSegDist(it.shape, a, b) - SILK_LINE_MM / 2 < R.minSilkToPadMm - 1e-6);
      if (hit) break;
    }
    if (hit) add('warning', 'silk_pad', `${f.ref} の外形線のシルクが ${hit.label} のパッドにかかっています`, [f.ref, hit.ref], shapeCenter(hit.shape));
  }

  // ---- レジストのブリッジ（パッドの開口どうしの間に残るレジストの幅） ----
  // 幅が minMaskBridgeMm 未満だと製造時に取り除かれ、パッドどうしが一つの開口になる（はんだブリッジしやすい）
  {
    const e = R.maskExpansionMm;
    const byRef = new Map();
    for (const side of ['F.Cu', 'B.Cu']) {
      const ps = items.filter((it) => it.kind === 'pad' && it.layers.includes(side)).sort((a, b) => a.box.x0 - b.box.x0);
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const A = ps[i], B = ps[j];
        if (B.box.x0 > A.box.x1 + 2 * e + R.minMaskBridgeMm) break;
        if (A.net === B.net || !boxesNear(A.box, B.box, 2 * e + R.minMaskBridgeMm)) continue;
        const bridge = shapeDist(A.shape, B.shape) - 2 * e;
        if (bridge >= R.minMaskBridgeMm - 1e-6) continue;
        const key = A.ref === B.ref ? A.ref : `${A.ref}/${B.ref}`;
        const cur = byRef.get(key) || { n: 0, min: Infinity, at: null, refs: [...new Set([A.ref, B.ref])] };
        cur.n++; if (bridge < cur.min) { cur.min = bridge; cur.at = nearestPoint(A.shape, B.shape); }
        byRef.set(key, cur);
      }
    }
    for (const [key, v] of byRef) {
      add('warning', 'mask_bridge', `${key}: パッドの間にレジストが残りません（${v.n} か所、残る幅 ${fmt(Math.max(0, v.min))}mm・最小 ${R.minMaskBridgeMm}mm）。はんだブリッジに注意（細かいピッチの IC では普通にあります）`, v.refs, v.at);
    }
  }

  // ---- 回路図との一致 ----
  const nl = project.netlist;
  if (!nl) add('warning', 'netlist_sync', 'ネットリストが未生成です。回路図からネットリストを作って取り込んでください', [], null);
  else {
    if (nl.sourceHash !== sourceHash(project)) add('warning', 'netlist_sync', '回路図がネットリスト生成後に変更されています。ネットリストを作り直して取り込んでください', [], null);
    else if (pcb.netlistHash !== nl.sourceHash) add('warning', 'netlist_sync', '最新のネットリストが PCB に取り込まれていません（PCB の「回路図から取込」）', [], null);
    const placed = new Set(pcb.footprints.map((f) => f.ref));
    const missing = nl.components.filter((c) => !placed.has(c.ref)).map((c) => c.ref);
    if (missing.length) add('error', 'netlist_sync', `PCB に無い部品があります: ${missing.join(', ')}`, missing, null);
  }
  const gen = pcb.footprints.filter((f) => f.fpDef.generated).map((f) => f.ref);
  const unver = pcb.footprints.filter((f) => !f.fpDef.generated && !f.fpDef.verified).map((f) => f.ref);
  if (gen.length) add('warning', 'footprint_unverified', `パッケージ名から自動生成したフットプリント（データシートの推奨ランドと要照合）: ${gen.join(', ')}`, gen, null);
  if (unver.length) add('warning', 'footprint_unverified', `寸法が KiCad 公式データと未照合のフットプリント（データシートで確認）: ${unver.join(', ')}`, unver, null);

  // ---- ベタ ----
  // 塗りつぶし結果の外周・穴の辺を、別ネットの銅と比べ直す（塗りつぶし計算の独立した検算）
  const fills = conn.fills || new Map();
  for (const z of pcb.zones) {
    const f = fills.get(z.id);
    const zc = f?.params?.clearance ?? 0.3;
    if (!z.net) add('warning', 'zone_fill', `${z.layer} のベタにネットが設定されていません（どこにもつながりません）`, [], null);
    if (!f) continue;
    if (!f.polygons.length) add('warning', 'zone_fill', `${z.layer} のベタ（${z.net || 'ネットなし'}）は塗れる場所がありません`, [], null);
    if (f.islandsRemoved) add('warning', 'zone_fill', `${z.layer} のベタ（${z.net}）: どこにもつながらない島を ${f.islandsRemoved} か所取り除きました`, [], null);
    const need = Math.min(zc, R.minClearanceMm) - 0.002; // 円の近似誤差を見込む
    const others = items.filter((it) => it.layers.includes(z.layer) && it.net !== z.net);
    let found = 0;
    for (const poly of f.polygons) for (const ring of poly) for (let k = 1; k < ring.length && found < 5; k++) {
      const a = { x: ring[k - 1][0], y: ring[k - 1][1] }, b = { x: ring[k][0], y: ring[k][1] };
      const sb = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
      for (const it of others) {
        if (!boxesNear(sb, it.box, zc)) continue;
        if (shapeSegDist(it.shape, a, b) < need) { found++; add('error', 'zone_fill', `${z.layer} のベタ（${z.net}）と ${it.label}（${netName(it.net)}）の間隔が不足しています`, it.ref ? [it.ref] : [], a); break; }
      }
    }
    for (const poly of f.polygons) {
      // 別ネットの銅がベタの中に埋まっていないか（中心点で確認）
      for (const it of others) {
        const c = shapeCenter(it.shape);
        if (it.kind !== 'track' && pointInRing(c, poly[0]) && !poly.slice(1).some((h) => pointInRing(c, h))) { add('error', 'zone_fill', `${it.label}（${netName(it.net)}）が ${z.net} のベタに埋まっています（短絡）`, it.ref ? [it.ref] : [], c); }
      }
    }
  }
  for (let i = 0; i < pcb.zones.length; i++) for (let j = i + 1; j < pcb.zones.length; j++) {
    const a = pcb.zones[i], b = pcb.zones[j];
    if (a.layer !== b.layer || a.net === b.net) continue;
    const ba = polyBox(a.polygon), bb = polyBox(b.polygon);
    if (ba.x0 < bb.x1 && bb.x0 < ba.x1 && ba.y0 < bb.y1 && bb.y0 < ba.y1) add('error', 'zone_overlap', `${a.layer} で ${a.net || 'ネットなし'} と ${b.net || 'ネットなし'} のベタの範囲が重なっています（重なるベタの塗り分けは未対応のため、範囲を分けてください）`, [], null);
  }

  if (dropped) issues.push({ level: 'warning', rule: 'limit', message: `ほかに ${dropped} 件あります（先頭 ${limit} 件のみ表示）`, refs: [], at: null });
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return {
    kind: 'drc',
    ranAt: now,
    pcbHash: drcHash(project, pcb),
    rules: R,
    issues,
    checked: DRC_RULES.map((r) => ({ ...r, count: issues.filter((i) => i.rule === r.id).length })),
    unchecked: DRC_UNCHECKED,
    summary: { errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warning').length, unrouted: conn.unrouted, dangling, items: items.length },
  };
}

export function drcHash(project, pcb) {
  return hash(JSON.stringify([pcb, project.board?.rules || {}, project.netlist?.sourceHash || null]));
}

export function drcStatus(project, pcb) {
  const r = project.checks?.drc;
  if (!r) return 'none';
  return r.pcbHash === drcHash(project, pcb) ? 'current' : 'stale';
}

function mid(t) { return { x: toMm(t.a.x + t.b.x) / 2, y: toMm(t.a.y + t.b.y) / 2 }; }
function midPt(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function polyBox(poly) {
  const xs = poly.map((q) => toMm(q.x)), ys = poly.map((q) => toMm(q.y));
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
