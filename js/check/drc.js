// DRC（基板設計ルール検査）。PCB の形状（mm）から検査する。
// 結果の各項目: { level:'error'|'warning', rule, message, refs, at:{x,y} 基板座標mm | null }
// 「検査した項目」と「検査していない項目」を結果に必ず含める（未実装の検査を検査済みと表示しないため）。
//
// 既定値は JLCPCB の 1〜2 層標準品の製造能力（2026年11月確認）に合わせる。プロジェクトの board.rules で上書きできる。

import { allPads, toMm, boardRect, fpBox, pointInPad, distToSeg } from '../pcb/model.js';
import { computePcbConnectivity } from '../pcb/connectivity.js';
import { padShape, trackShape, circleShape, silkSegments, refdesPos, textPoly } from '../pcb/shapes.js';
import { fpToBoard } from '../pcb/model.js';
import { shapeDist, shapeSegDist, shapeBox, boxesNear, shapeCenter, nearestPoint } from './geom2d.js';
import { hash, sourceHash } from '../netlist/netlist.js';

export const DRC_DEFAULTS = {
  minTrackWidthMm: 0.127,      // 配線幅（1〜2層）
  minClearanceMm: 0.127,       // 銅どうしの間隔（配線-配線・パッド-パッド・ビア）
  minPadClearanceMm: 0.2,      // パッド-配線、パッド-ビア
  boardEdgeClearanceMm: 0.3,   // 銅と基板外形
  minViaDrillMm: 0.3,
  minViaDiameterMm: 0.5,
  minViaAnnularMm: 0.1,        // (外径-穴径)/2
  minAnnularRingMm: 0.13,      // スルーホールパッドのランド幅
  minPthDrillMm: 0.2,
  maxDrillMm: 6.35,
  minHoleToHoleMm: 0.5,        // 異なるネットの穴どうし（穴の縁から縁）
  minNpthToCopperMm: 0.254,    // 取付穴（非メッキ）と銅
  minSilkToPadMm: 0.15,        // シルクとパッド
};

export function drcRules(project) {
  return { ...DRC_DEFAULTS, ...(project.board?.rules || {}) };
}

export const DRC_RULES = [
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
  { id: 'netlist_sync', label: '回路図（ネットリスト）との一致・未配置の部品' },
  { id: 'footprint_unverified', label: '未照合・自動生成のフットプリント' },
  { id: 'zone_estimated', label: 'ベタによる接続（推定であることの注意）' },
];

export const DRC_UNCHECKED = [
  'ベタ（塗りつぶし）とほかの銅の間隔・ベタの島切れ・サーマル（塗りつぶし形状の計算は第6段階）。ベタ経由の接続は「推定」として扱います',
  'ソルダーマスク（レジスト）の開口・ブリッジ幅',
  'メタルマスク（ペースト）',
  'シルクの線幅・文字高さの最小値（文字の太さはGerber生成時に決まるため第6段階）',
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

  const conn = computePcbConnectivity(pcb);
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
    items.push({ kind: 'via', key: `v:${v.id}`, layers: ['F.Cu', 'B.Cu'], net: v.net || groupNet(`v:${v.id}`) || `~v:${v.id}`, shape, box: shapeBox(shape), label: 'ビア', v });
  }
  const netName = (n) => (n.startsWith('~') ? 'ネットなし' : n);

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
  for (const it of items) {
    const c = shapeCenter(it.shape);
    let d = Infinity, near = null;
    for (const [a, b] of edges) { const e = shapeSegDist(it.shape, a, b); if (e < d) { d = e; near = [a, b]; } }
    if (!inside(c)) {
      if (it.kind === 'pad') continue; // 部品ごと基板外 → outside_board で報告
      add('error', 'edge_clearance', `${it.label} が基板の外にあります`, it.ref ? [it.ref] : [], c);
    } else if (d < R.boardEdgeClearanceMm - 1e-6) {
      add('error', 'edge_clearance', `${it.label} と基板外形の間隔 ${fmt(Math.max(0, d))}mm（最小 ${R.boardEdgeClearanceMm}mm）`, it.ref ? [it.ref] : [], nearestPoint(it.shape, { type: 'cap', a: near[0], b: near[1], r: 0 }));
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
  const padsOnSide = (side) => items.filter((it) => it.kind === 'pad' && it.layers.includes(side === 'bottom' ? 'B.Cu' : 'F.Cu'));
  const silkHits = (poly, side, exceptInst = null) => padsOnSide(side).filter((it) => it.inst !== exceptInst && shapeDist(poly, it.shape) < R.minSilkToPadMm - 1e-6);
  const unplaced = new Set(issues.filter((i) => i.rule === 'outside_board' && i.level === 'error').map((i) => i.refs[0]));
  for (const f of pcb.footprints) {
    if (unplaced.has(f.ref)) continue;
    const rp = refdesPos(f);
    const poly = textPoly(rp.x, rp.y, rp.size, f.ref, 0, 'alphabetic');
    const hits = silkHits(poly, f.side);
    if (hits.length) add('warning', 'silk_pad', `部品番号 ${f.ref} のシルクがパッド ${hits.slice(0, 3).map((h) => h.label).join(', ')} にかかっています（推定）`, [f.ref], rp);
    if (!inside(rp)) add('warning', 'silk_outside', `部品番号 ${f.ref} のシルクが基板の外です`, [f.ref], rp);
    // 外形線は自分のパッドの周りで切ってあるので、他の部品のパッドとだけ比べる
    const segs = silkSegments(f.fpDef);
    const others = padsOnSide(f.side).filter((it) => it.inst !== f);
    let hit = null;
    for (const s of segs) {
      const a = fpToBoard(f, s.a.x, s.a.y), b = fpToBoard(f, s.b.x, s.b.y);
      hit = others.find((it) => shapeSegDist(it.shape, a, b) < R.minSilkToPadMm - 1e-6);
      if (hit) break;
    }
    if (hit) add('warning', 'silk_pad', `${f.ref} の外形線のシルクが ${hit.label} のパッドにかかっています`, [f.ref, hit.ref], shapeCenter(hit.shape));
  }
  for (const t of pcb.texts) {
    const x = toMm(t.x), y = toMm(t.y);
    const poly = textPoly(x, y, toMm(t.size), t.text, t.rot || 0, 'central');
    const hits = silkHits(poly, t.layer === 'B.SilkS' ? 'bottom' : 'top');
    if (hits.length) add('warning', 'silk_pad', `文字「${t.text}」のシルクがパッド ${hits.slice(0, 3).map((h) => h.label).join(', ')} にかかっています（推定）`, [], { x, y });
    if (!inside({ x, y })) add('warning', 'silk_outside', `文字「${t.text}」が基板の外です`, [], { x, y });
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
  if (unver.length) add('warning', 'footprint_unverified', `寸法が未照合のフットプリント（第6段階で KiCad 公式データと照合）: ${unver.join(', ')}`, unver, null);

  // ---- ベタ ----
  for (const z of pcb.zones) {
    if (!z.net) add('warning', 'zone_estimated', `${z.layer} のベタにネットが設定されていません`, [], null);
  }
  const zoneNets = [...new Set(pcb.zones.filter((z) => z.net).map((z) => z.net))];
  if (zoneNets.length) add('warning', 'zone_estimated', `ネット ${zoneNets.join(', ')} はベタの範囲内のパッドを「接続済み」とみなしています（推定）。島切れ・クリアランスは第6段階の塗りつぶし計算まで未検査です`, [], null);

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
