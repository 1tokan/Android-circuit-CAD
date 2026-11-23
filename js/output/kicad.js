// KiCad 形式の書き出し（PCB）。KiCad 7 の S式ファイル形式（version 20221018）で書く。KiCad 8・9 でもそのまま開ける。
// 出力: <名前>.kicad_pcb（基板）、<名前>.kicad_pro（設計ルール・ネットクラス）、<名前>.kicad_dru（KiCad の基本ルールで表せない分）
// 座標: Pocket EDA も KiCad も mm・Y 下向きなので、そのまま書く。
// 回転: Pocket EDA は Y 下向きで時計回りが正、KiCad は反時計回りが正 → KiCad の角度 = -rot。
// 裏面の部品: Pocket EDA は「部品内の x を左右反転してから回転」。KiCad のファイルは反転後の部品内座標を持つので、反転済みの座標を書く。
// パッドの (at x y 角度) の角度は KiCad では部品の向きを含んだ絶対角度。
// ベタはアウトラインだけを書く（塗りの形は KiCad で「すべてのゾーンを塗りつぶす（B キー）」で作り直す）。

import { toMm, copperLayers, boardToFp, padLayers } from '../pcb/model.js';
import { silkSegments, refdesPos, pin1Mark } from '../pcb/shapes.js';

import { strokeWidthFor, SILK_LINE_MM } from '../pcb/text.js';
import { ZONE_DEFAULTS } from '../pcb/zonefill.js';
import { drcRules } from '../check/rules.js';

export const KICAD_PCB_VERSION = 20221018;

/** 数値（mm。小数6桁まで・末尾の0は省く） */
const n = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) || r === 0 ? '0' : String(r); };
/** 文字列（S式の引用符） */
const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
/** 角度（0〜360 未満） */
const ang = (a) => { const r = ((Math.round(a * 1e6) / 1e6) % 360 + 360) % 360; return r === 0 ? '' : ` ${n(r)}`; };

/** 決まった UUID（同じ設計からは同じファイルになる。KiCad は tstamp を区別にだけ使う） */
function uuidFrom(str) {
  // FNV-1a を 4 回（種を変えて）→ 128bit
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let x = seed >>> 0;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  }).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** KiCad の層の一覧（銅箔は 0=F.Cu、1..=内層、31=B.Cu） */
function layerTable(nCu) {
  const cu = copperLayers(nCu).map((l) => `    (${l === 'F.Cu' ? 0 : l === 'B.Cu' ? 31 : Number(l[2])} ${q(l)} signal)`);
  const tech = [
    [32, 'B.Adhes', 'user', 'B.Adhesive'], [33, 'F.Adhes', 'user', 'F.Adhesive'], [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'], [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
    [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'], [42, 'Eco1.User', 'user', 'User.Eco1'], [43, 'Eco2.User', 'user', 'User.Eco2'],
    [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'], [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'],
    [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
  ].map(([i, name, type, user]) => `    (${i} ${q(name)} ${type}${user ? ` ${q(user)}` : ''})`);
  return ['  (layers', ...cu, ...tech, '  )'].join('\n');
}

/** プロジェクトのネット名 → KiCad のネット番号（0 は「ネットなし」） */
function netTable(pcb) {
  const names = new Set();
  for (const f of pcb.footprints) for (const v of Object.values(f.padNets || {})) if (v) names.add(v);
  for (const t of pcb.tracks) if (t.net) names.add(t.net);
  for (const v of pcb.vias) if (v.net) names.add(v.net);
  for (const z of pcb.zones) if (z.net) names.add(z.net);
  const list = [...names].sort((a, b) => a.localeCompare(b, 'en'));
  const map = new Map(list.map((name, i) => [name, i + 1]));
  return { list, map, ref: (name) => (name && map.has(name) ? `(net ${map.get(name)} ${q(name)})` : '') };
}

/** 基板座標(mm) → KiCad の部品内座標（反転済み・回転前） */
function toKicadLocal(inst, bx, by) {
  const l = boardToFp(inst, bx, by); // Pocket EDA の部品内座標（反転前）
  return { x: inst.side === 'bottom' ? -l.x : l.x, y: l.y };
}
/** Pocket EDA の部品内座標 → KiCad の部品内座標 */
const localK = (inst, x, y) => ({ x: inst.side === 'bottom' ? -x : x, y });

const PAD_SHAPE = { rect: 'rect', roundrect: 'roundrect', oval: 'oval', circle: 'circle' };

function footprintSexpr(inst, nets, cu) {
  const def = inst.fpDef;
  const bottom = inst.side === 'bottom';
  const F = bottom ? 'B' : 'F';
  const a = -(inst.rot || 0);
  const id = (s) => uuidFrom(`${inst.id}:${s}`);
  const out = [];
  const lib = def.kicad ? `PocketEDA:${def.kicad}` : `PocketEDA:${def.name || def.id || 'Footprint'}`;
  out.push(`  (footprint ${q(lib)} (layer ${q(`${F}.Cu`)})`);
  out.push(`    (tstamp ${uuidFrom(inst.id)})`);
  out.push(`    (at ${n(toMm(inst.x))} ${n(toMm(inst.y))}${ang(a)})`);
  if (inst.lcsc) out.push(`    (property "LCSC" ${q(inst.lcsc)})`);
  out.push(`    (property "PocketEDA_ID" ${q(inst.id)})`);
  const tht = def.pads.some((p) => p.type === 'tht');
  out.push(`    (attr ${tht ? 'through_hole' : 'smd'}${inst.dnp ? ' exclude_from_pos_files exclude_from_bom' : ''})`);
  // 部品番号（シルク）と値（Fab 層）。文字は基板に対して水平（角度 0）
  const rp = refdesPos(inst);
  const rl = toKicadLocal(inst, rp.x, rp.y - rp.size / 2); // refdesPos はベースライン → KiCad は文字の中心
  const sw = strokeWidthFor(rp.size);
  const eff = (size, w) => `(effects (font (size ${n(size)} ${n(size)}) (thickness ${n(w)}))${bottom ? ' (justify mirror)' : ''})`;
  out.push(`    (fp_text reference ${q(inst.ref)} (at ${n(rl.x)} ${n(rl.y)}${ang(0)}) (layer ${q(`${F}.SilkS`)})${inst.hideRef ? ' hide' : ''}`);
  out.push(`      ${eff(rp.size, sw)}`);
  out.push(`      (tstamp ${id('ref')})`);
  out.push('    )');
  out.push(`    (fp_text value ${q(inst.value || def.name || '')} (at 0 0${ang(0)}) (layer ${q(`${F}.Fab`)})`);
  out.push(`      ${eff(0.8, 0.12)}`);
  out.push(`      (tstamp ${id('val')})`);
  out.push('    )');
  // シルクの外形線（パッドにかかる部分は切り取り済み）
  silkSegments(def).forEach((s, i) => {
    const p = localK(inst, s.a.x, s.a.y), r = localK(inst, s.b.x, s.b.y);
    out.push(`    (fp_line (start ${n(p.x)} ${n(p.y)}) (end ${n(r.x)} ${n(r.y)}) (stroke (width ${n(SILK_LINE_MM)}) (type solid)) (layer ${q(`${F}.SilkS`)}) (tstamp ${id(`silk${i}`)}))`);
  });
  const m = pin1Mark(def);
  if (m) { const c = localK(inst, m.x, m.y); out.push(`    (fp_circle (center ${n(c.x)} ${n(c.y)}) (end ${n(c.x + 0.1)} ${n(c.y)}) (stroke (width 0.2) (type solid)) (fill solid) (layer ${q(`${F}.SilkS`)}) (tstamp ${id('pin1')}))`); }
  // 外形枠（コートヤード）・本体（Fab）
  const rect = (x0, y0, x1, y1, layer, w, key) => {
    const p = localK(inst, x0, y0), r = localK(inst, x1, y1);
    out.push(`    (fp_rect (start ${n(p.x)} ${n(p.y)}) (end ${n(r.x)} ${n(r.y)}) (stroke (width ${n(w)}) (type solid)) (fill none) (layer ${q(layer)}) (tstamp ${id(key)}))`);
  };
  if (def.courtyard) rect(def.courtyard.x0, def.courtyard.y0, def.courtyard.x1, def.courtyard.y1, `${F}.CrtYd`, 0.05, 'crtyd');
  if (def.body) {
    const b = def.body, cx = b.cx || 0, cy = b.cy || 0;
    rect(cx - b.w / 2, cy - b.h / 2, cx + b.w / 2, cy + b.h / 2, `${F}.Fab`, 0.1, 'fab');
  }
  // パッド
  def.pads.forEach((pad, k) => {
    const p = localK(inst, pad.x, pad.y);
    const shape = PAD_SHAPE[pad.shape] || 'rect';
    const net = nets.ref(inst.padNets?.[pad.num]);
    let s;
    if (pad.type === 'tht') {
      const drill = pad.slot ? `(drill oval ${n(pad.slot.w)} ${n(pad.slot.h)})` : `(drill ${n(pad.drill)})`;
      s = `    (pad ${q(pad.num)} thru_hole ${shape} (at ${n(p.x)} ${n(p.y)}${ang(a)}) (size ${n(pad.w)} ${n(pad.h)}) ${drill} (layers "*.Cu" "*.Mask")`;
    } else {
      const layers = padLayers(inst, pad, cu);
      const side = layers[0] === 'B.Cu' ? 'B' : 'F';
      s = `    (pad ${q(pad.num)} smd ${shape} (at ${n(p.x)} ${n(p.y)}${ang(a)}) (size ${n(pad.w)} ${n(pad.h)}) (layers ${q(`${side}.Cu`)} ${q(`${side}.Paste`)} ${q(`${side}.Mask`)})`;
    }
    if (shape === 'roundrect') s += ` (roundrect_rratio ${n(pad.rr ?? 0.25)})`;
    if (net) s += ` ${net}`;
    s += ` (tstamp ${id(`pad${k}`)}))`;
    out.push(s);
  });
  out.push('  )');
  return out.join('\n');
}

/** 取付穴（非メッキ）は KiCad では穴だけの部品として置く */
function holeSexpr(h, i) {
  const d = toMm(h.drill);
  return [
    `  (footprint "PocketEDA:MountingHole_NPTH" (layer "F.Cu")`,
    `    (tstamp ${uuidFrom(h.id || `hole${i}`)})`,
    `    (at ${n(toMm(h.x))} ${n(toMm(h.y))})`,
    '    (attr exclude_from_pos_files exclude_from_bom)',
    `    (fp_text reference ${q(`H${i + 1}`)} (at 0 ${n(-d / 2 - 1)}) (layer "F.SilkS") hide (effects (font (size 1 1) (thickness 0.15))) (tstamp ${uuidFrom(`${h.id}:ref`)}))`,
    `    (fp_text value ${q(`MountingHole_${n(d)}mm`)} (at 0 ${n(d / 2 + 1)}) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))) (tstamp ${uuidFrom(`${h.id}:val`)}))`,
    `    (pad "" np_thru_hole circle (at 0 0) (size ${n(d)} ${n(d)}) (drill ${n(d)}) (layers "*.Cu" "*.Mask") (tstamp ${uuidFrom(`${h.id}:pad`)}))`,
    '  )',
  ].join('\n');
}

/**
 * .kicad_pcb の本文
 * @param project プロジェクト（pcb と board を持つ）
 * @param opt { version: アプリの版 }
 */
export function kicadPcb(project, { version = '' } = {}) {
  const pcb = project.pcb;
  const nCu = pcb.settings?.layers || 2;
  const cu = copperLayers(nCu);
  const R = drcRules(project);
  const fab = project.board?.fab || {};
  const nets = netTable(pcb);
  const L = [];
  L.push(`(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator pocket_eda)`);
  L.push('');
  L.push(`  (general (thickness ${n(fab.thicknessMm || 1.6)}))`);
  L.push('');
  L.push('  (paper "A4")');
  L.push(`  (title_block (title ${q(project.name)}) (comment 1 ${q(`Pocket EDA ${version} から書き出し`)}))`);
  L.push('');
  L.push(layerTable(nCu));
  L.push('');
  L.push('  (setup');
  L.push(`    (pad_to_mask_clearance ${n(R.maskExpansionMm ?? 0.05)})`);
  L.push(`    (solder_mask_min_width ${n(R.minMaskBridgeMm ?? 0.1)})`);
  L.push('    (pcbplotparams (layerselection 0x00010fc_ffffffff) (plot_on_all_layers_selection 0x0000000_00000000) (outputformat 1) (outputdirectory ""))');
  L.push('  )');
  L.push('');
  L.push('  (net 0 "")');
  nets.list.forEach((name, i) => L.push(`  (net ${i + 1} ${q(name)})`));
  L.push('');
  for (const f of pcb.footprints) L.push(footprintSexpr(f, nets, cu));
  pcb.holes.forEach((h, i) => L.push(holeSexpr(h, i)));
  L.push('');
  // 基板外形
  const o = pcb.outline;
  if (o.type === 'rect' || !Array.isArray(o.points)) {
    L.push(`  (gr_rect (start ${n(toMm(o.x))} ${n(toMm(o.y))}) (end ${n(toMm(o.x + o.w))} ${n(toMm(o.y + o.h))}) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (tstamp ${uuidFrom('outline')}))`);
  } else {
    L.push(`  (gr_poly (pts ${o.points.map((p) => `(xy ${n(toMm(p.x))} ${n(toMm(p.y))})`).join(' ')}) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (tstamp ${uuidFrom('outline')}))`);
  }
  // 文字
  for (const t of pcb.texts) {
    const size = toMm(t.size), w = t.width ? toMm(t.width) : strokeWidthFor(size);
    const bottom = t.layer === 'B.SilkS';
    L.push(`  (gr_text ${q(t.text)} (at ${n(toMm(t.x))} ${n(toMm(t.y))}${ang(-(t.rot || 0))}) (layer ${q(t.layer || 'F.SilkS')}) (tstamp ${uuidFrom(t.id)})`);
    L.push(`    (effects (font (size ${n(size)} ${n(size)}) (thickness ${n(w)}))${bottom ? ' (justify mirror)' : ''})`);
    L.push('  )');
  }
  L.push('');
  // 配線・ビア
  for (const t of pcb.tracks) {
    if (!cu.includes(t.layer)) continue;
    L.push(`  (segment (start ${n(toMm(t.a.x))} ${n(toMm(t.a.y))}) (end ${n(toMm(t.b.x))} ${n(toMm(t.b.y))}) (width ${n(toMm(t.width))}) (layer ${q(t.layer)}) (net ${nets.map.get(t.net) || 0}) (tstamp ${uuidFrom(t.id)}))`);
  }
  for (const v of pcb.vias) {
    L.push(`  (via (at ${n(toMm(v.x))} ${n(toMm(v.y))}) (size ${n(toMm(v.diameter))}) (drill ${n(toMm(v.drill))}) (layers "F.Cu" "B.Cu") (net ${nets.map.get(v.net) || 0}) (tstamp ${uuidFrom(v.id)}))`);
  }
  L.push('');
  // ベタ（アウトラインのみ。塗りは KiCad で作り直す）。Pocket EDA のベタ塗りと同じ間隔・サーマル
  pcb.zones.forEach((z, i) => {
    if (!cu.includes(z.layer) || !Array.isArray(z.polygon) || z.polygon.length < 3) return;
    const clr = Math.max(z.clearance ? toMm(z.clearance) : ZONE_DEFAULTS.clearanceMm, R.minClearanceMm ?? 0, R.minPadClearanceMm ?? 0);
    const gap = z.thermalGap ? toMm(z.thermalGap) : ZONE_DEFAULTS.thermalGapMm;
    const spoke = z.spokeWidth ? toMm(z.spokeWidth) : ZONE_DEFAULTS.spokeWidthMm;
    const minW = z.minWidth ? toMm(z.minWidth) : 0.25;
    const solid = z.padConnection === 'solid';
    L.push(`  (zone (net ${nets.map.get(z.net) || 0}) (net_name ${q(z.net || '')}) (layer ${q(z.layer)}) (tstamp ${uuidFrom(z.id || `zone${i}`)}) (hatch edge 0.5)`);
    L.push(`    (connect_pads${solid ? ' yes' : ''} (clearance ${n(clr)}))`);
    L.push(`    (min_thickness ${n(minW)}) (filled_areas_thickness no)`);
    L.push(`    (fill yes (thermal_gap ${n(gap)}) (thermal_bridge_width ${n(spoke)}))`);
    L.push(`    (polygon (pts ${z.polygon.map((p) => `(xy ${n(toMm(p.x))} ${n(toMm(p.y))})`).join(' ')}))`);
    L.push('  )');
  });
  L.push(')');
  return L.join('\n') + '\n';
}

/** .kicad_pro（設計ルールとネットクラス。KiCad は足りない項目を既定値で補う） */
export function kicadPro(project, baseName) {
  const pcb = project.pcb;
  const R = drcRules(project);
  const s = pcb.settings || {};
  const rules = {
    min_clearance: R.minClearanceMm,
    min_track_width: R.minTrackWidthMm,
    min_via_diameter: R.minViaDiameterMm,
    min_via_annular_width: R.minViaAnnularMm,
    min_through_hole_diameter: Math.min(R.minViaDrillMm, R.minPthDrillMm),
    // 穴どうし（縁から縁）: 同じネットの値。異なるネットの 0.5mm は .kicad_dru のルールで調べる
    min_hole_to_hole: R.minSameNetHoleMm ?? 0.254,
    // 穴と別ネットの銅: Pocket EDA は「ビアの外径＋銅どうしの間隔」で守る（穴の縁からは 間隔＋ランド幅）
    min_hole_clearance: +(R.minClearanceMm + R.minViaAnnularMm).toFixed(3),
    min_copper_edge_clearance: R.boardEdgeClearanceMm,
    min_silk_clearance: 0,
    min_text_height: R.minSilkTextHeightMm,
    min_text_thickness: Math.min(R.minSilkWidthMm, 0.15),
    solder_mask_to_copper_clearance: 0,
    min_microvia_diameter: 0.2,
    min_microvia_drill: 0.1,
    allow_blind_buried_vias: false,
    allow_microvias: false,
    use_height_for_length_calcs: true,
  };
  const pro = {
    board: {
      design_settings: {
        defaults: { board_outline_line_width: 0.1, copper_line_width: 0.2, silk_line_width: 0.12, silk_text_size_h: 1, silk_text_size_v: 1, silk_text_thickness: 0.15, pads: { drill: 0.8, height: 1.6, width: 1.6 } },
        rules,
        // 部品の形はファイルに全部入っている（Pocket EDA のライブラリは KiCad には無い）ので、ライブラリとの照合は行わない
        rule_severities: { lib_footprint_issues: 'ignore', lib_footprint_mismatch: 'ignore' },
        track_widths: [0, toMm(s.trackWidth || 250000)],
        via_dimensions: [{ diameter: 0, drill: 0 }, { diameter: toMm(s.viaDiameter || 600000), drill: toMm(s.viaDrill || 300000) }],
        diff_pair_dimensions: [{ gap: 0, via_gap: 0, width: 0 }],
        meta: { version: 2 },
      },
      layer_presets: [],
      viewports: [],
    },
    meta: { filename: `${baseName}.kicad_pro`, version: 1 },
    net_settings: {
      classes: [{
        name: 'Default', clearance: R.minClearanceMm, track_width: toMm(s.trackWidth || 250000),
        via_diameter: toMm(s.viaDiameter || 600000), via_drill: toMm(s.viaDrill || 300000),
        diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2,
        microvia_diameter: 0.3, microvia_drill: 0.1, wire_width: 6, bus_width: 12, line_style: 0,
        pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)',
      }],
      meta: { version: 3 },
      net_colors: null,
    },
    pcbnew: { last_paths: {}, page_layout_descr_file: '' },
  };
  return JSON.stringify(pro, null, 2) + '\n';
}

/** .kicad_dru（KiCad の基本ルールで表せない Pocket EDA のルール） */
export function kicadDru(project) {
  const R = drcRules(project);
  const mm = (v) => `${n(v)}mm`;
  return [
    '(version 1)',
    '',
    '# Pocket EDA の設計ルールのうち、KiCad の「制約」画面の値だけでは表せないもの',
    '',
    '# パッドと配線・ビアの間隔（パッドどうし・配線どうしは基本の最小間隔）',
    `(rule "PocketEDA パッド-配線" (constraint clearance (min ${mm(R.minPadClearanceMm)}))`,
    `  (condition "(A.Type == 'Pad' && (B.Type == 'Track' || B.Type == 'Via')) || (B.Type == 'Pad' && (A.Type == 'Track' || A.Type == 'Via'))"))`,
    '',
    '# 異なるネットの穴どうし（縁から縁）',
    `(rule "PocketEDA 穴どうし" (constraint hole_to_hole (min ${mm(R.minHoleToHoleMm)}))`,
    `  (condition "A.NetName != B.NetName"))`,
    '',
    '# 内層の銅と基板外形',
    `(rule "PocketEDA 内層と外形" (layer inner) (constraint edge_clearance (min ${mm(Math.max(R.boardEdgeClearanceMm, R.innerEdgeClearanceMm))})))`,
    '',
    '# 取付穴（非メッキ）と銅',
    `(rule "PocketEDA 取付穴と銅" (constraint hole_clearance (min ${mm(R.minNpthToCopperMm)}))`,
    `  (condition "A.Pad_Type == 'NPTH, mechanical' || B.Pad_Type == 'NPTH, mechanical'"))`,
    '',
  ].join('\n');
}

/** KiCad 一式（ZIP に入れるファイル） */
export function kicadFiles(project, { version = '' } = {}) {
  const base = String(project.name).replace(/[\\/:*?"<>|\s]+/g, '_') || 'board';
  return [
    { name: `${base}/${base}.kicad_pcb`, content: kicadPcb(project, { version }) },
    { name: `${base}/${base}.kicad_pro`, content: kicadPro(project, base) },
    { name: `${base}/${base}.kicad_dru`, content: kicadDru(project) },
  ];
}
