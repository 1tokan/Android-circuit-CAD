// 部品実装（PCBA）用の BOM と CPL（JLCPCB 形式）
//
// BOM: Comment, Designator, Footprint, LCSC Part #   … 同じ値・パッケージ・LCSC品番の部品を1行にまとめる
// CPL: Designator, Mid X, Mid Y, Layer, Rotation      … mm、Y は上向き（Gerber と同じ座標）、回転は反時計回りが正
//
// 回転の考え方（KiCad 用の JLCPCB Fabrication Toolkit と同じ規則にそろえる）:
//   この CAD の rot は「画面（Y下向き）で時計回り」が正。KiCad の向き θ = -rot（反時計回りが正）。
//   表: θ + 補正   裏: 180 - θ + 補正（JLCPCB は「部品の上から見た向き」を求めるため）
//   補正 = パッケージの基準向きの違い（下の表）＋ 部品ごとの手動補正（cplRotOffset）
// 内蔵フットプリントは KiCad 標準と同じ向き（1番ピン左上など）で作ってあるので、KiCad 用の補正表がそのまま使える。

import { toMm, copperLayers } from '../pcb/model.js';
import { cmpRef } from '../schematic/connectivity.js';
import { unitPrice } from '../library/parts.js';

// パッケージ名 → 回転補正（度）。
// 出典: JLCPCB Fabrication Toolkit（bennymeg/Fabrication-Toolkit, Apache-2.0）の transformations.csv を、
// この CAD のフットプリント名に当てはまるものだけ抜き出したもの。
export const JLC_ROTATION_DB = [
  [/^CP_EIA-/, 180], [/^CP_Elec_/, 180], [/^C_Elec_/, 180],
  [/^DFN-/, 270], [/^D_SOT-23/, 180], [/^HTSSOP-/, 270], [/^JST_GH_SM/, 180], [/^JST_PH_S/, 180],
  [/^LQFP-/, 270], [/^MSOP-/, 270], [/^QFN-/, 90], [/^R_Array_Conc/, 90], [/^R_Array_Conv/, 90],
  [/^SC-74-6/, 180], [/^SOIC-/, 270], [/^SOP-18_/, 0], [/^SOP-4_/, 0], [/^SOP-(?!18_)/, 270],
  [/^SOT-143/, 180], [/^SOT-223/, 180], [/^SOT-23/, 180], [/^SOT-353/, 180], [/^SOT-363/, 180], [/^SOT-89/, 180],
  [/^SSOP-/, 270], [/^SW_SPST_B3/, 90], [/^TDSON-8-1/, 270], [/^TO-277/, 90], [/^TQFP-/, 270], [/^TSOT-23/, 180],
  [/^TSSOP-/, 270], [/^UDFN-10/, 270], [/^USON-10/, 270], [/^VSON-8_/, 270], [/^VSSOP-10_/, 270], [/^VSSOP-8_/, 270],
];

/** フットプリント名（自動生成は "PKG:種別:" を除いたパッケージ名）で補正を探す */
export function packageRotation(fpDef) {
  const names = [fpDef.id, fpDef.name, fpDef.package].filter(Boolean).map((s) => String(s).replace(/^PKG:[^:]*:/, ''));
  for (const [re, deg] of JLC_ROTATION_DB) if (names.some((n) => re.test(n))) return { deg, matched: re.source };
  return { deg: 0, matched: null };
}

/** BOM の Footprint 欄（JLCPCB の照合に使う短い名前: 0805 / SOIC-8 / SOT-23 など） */
export function bomPackageName(fpDef) {
  const n = String(fpDef.package || fpDef.name || fpDef.id).replace(/^PKG:[^:]*:/, '');
  const chip = /^(?:R|C|L|LED)_(\d{4})$/.exec(fpDef.id || '');
  return chip ? chip[1] : n;
}

// JLCPCB の PCBA の種類（2026年10月時点の JLCPCB の案内。料金は目安）
// エコノミー: 片面実装だけ・2/4/6 層・板厚 0.8〜1.6mm・1枚 10×10mm 以上。標準: 両面も可、1枚 70×70mm 未満は JLCPCB が捨て基板（エッジレール）を付ける
export const JLC_PCBA = {
  economic: { label: 'エコノミー PCBA', setupUsd: 8.18, stencilUsd: 1.53, layers: [2, 4, 6], thicknessMm: [0.8, 1.6], minMm: 10 },
  standard: { label: '標準 PCBA', setupUsd: { single: 25.56, double: 51.12 }, stencilUsd: { single: 8.21, double: 16.42 }, minMm: 70, railMm: 5 },
};

/** 注文できる PCBA の種類と、その理由 */
export function pcbaService(project, pcb, cpl) {
  const both = cpl.some((c) => c.layer === 'Bottom') && cpl.some((c) => c.layer === 'Top');
  const nL = copperLayers(pcb).length;
  const t = Number(project.board?.fab?.thicknessMm) || 1.6;
  const w = toMm(pcb.outline.w), h = toMm(pcb.outline.h);
  const E = JLC_PCBA.economic, S = JLC_PCBA.standard;
  const why = [];
  if (both) why.push('両面に部品がある（エコノミーは片面だけ）');
  if (!E.layers.includes(nL)) why.push(`${nL} 層（エコノミーは ${E.layers.join('/')} 層）`);
  if (t < E.thicknessMm[0] || t > E.thicknessMm[1]) why.push(`板厚 ${t}mm（エコノミーは ${E.thicknessMm[0]}〜${E.thicknessMm[1]}mm）`);
  if (w < E.minMm || h < E.minMm) why.push(`基板が ${E.minMm}×${E.minMm}mm より小さい（面付けが必要）`);
  const type = why.length ? 'standard' : 'economic';
  const sides = both ? 'double' : 'single';
  const rails = type === 'standard' && (w < S.minMm || h < S.minMm);
  const bottomOnly = !both && cpl.length > 0 && cpl.every((c) => c.layer === 'Bottom');
  return {
    type, sides, why, rails, w, h, bottomOnly,
    setupUsd: type === 'economic' ? E.setupUsd : S.setupUsd[sides],
    stencilUsd: type === 'economic' ? E.stencilUsd : S.stencilUsd[sides],
  };
}

const norm360 = (d) => { const r = ((d % 360) + 360) % 360; return Math.abs(r - 360) < 1e-9 ? 0 : r; };
const num = (v, n = 4) => { const r = Math.round(v * 10 ** n) / 10 ** n; return (r === 0 ? 0 : r).toFixed(n).replace(/\.?0+$/, '') || '0'; };

/**
 * 実装データ（BOM・CPL・確認事項）を作る
 * @returns {{ bom:[{comment, designators:[], footprint, lcsc, qty, jlcType, unitUsd}], cpl:[{designator, x, y, layer, rotation, base, pkgOffset, manualOffset, matched}], problems:[{level,message,refs}], summary }}
 */
export function buildAssembly(project, pcb, { boards = 5 } = {}) {
  const problems = [];
  const warn = (message, refs = []) => problems.push({ level: 'warning', message, refs });
  const err = (message, refs = []) => problems.push({ level: 'error', message, refs });
  // 注文の妨げにはならないが、知っておくこと
  const info = (message, refs = []) => problems.push({ level: 'info', message, refs });
  const nlComps = new Map((project.netlist?.components || []).map((c) => [c.ref, c]));
  const partsById = new Map((project.library?.parts || []).map((p) => [p.id, p]));

  const placed = [...pcb.footprints].sort((a, b) => cmpRef(a.ref, b.ref));
  const seen = new Set();
  for (const f of placed) { if (seen.has(f.ref)) err(`部品番号 ${f.ref} が重複しています（実装データでは区別できません）`, [f.ref]); seen.add(f.ref); }

  const mounted = placed.filter((f) => !f.dnp);
  // テストパッド（銅のパッドだけで部品が無い）は実装しないのが当然なので、お知らせにとどめる
  const isPadOnly = (f) => /^TestPoint/i.test(f.fpDef?.id || f.fpDef?.name || '') && !f.lcsc;
  const pads = placed.filter((f) => f.dnp && isPadOnly(f)).map((f) => f.ref);
  const dnp = placed.filter((f) => f.dnp && !isPadOnly(f)).map((f) => f.ref);
  if (dnp.length) warn(`未実装（DNP）の部品は BOM・CPL に入れていません: ${dnp.join(', ')}`, dnp);
  if (pads.length) info(`テストパッド（部品なし）: ${pads.join(', ')}。BOM・CPL には入りません`, pads);

  // ---- BOM ----
  const rows = new Map();
  for (const f of mounted) {
    const nc = nlComps.get(f.ref);
    const part = nc?.partId ? partsById.get(nc.partId) : null;
    const lcsc = (f.lcsc || nc?.lcsc || '').trim();
    const comment = String(f.value || nc?.value || '').trim();
    const footprint = bomPackageName(f.fpDef);
    const key = `${comment}|${footprint}|${lcsc}`;
    if (!rows.has(key)) rows.set(key, { comment, footprint, lcsc, designators: [], jlcType: part?.jlc?.type || 'unknown', part, mpn: part?.mpn || nc?.mpn || '' });
    rows.get(key).designators.push(f.ref);
  }
  const bom = [...rows.values()].map((r) => {
    r.designators.sort(cmpRef);
    r.qty = r.designators.length;
    r.unitUsd = r.part && r.part.price?.length ? unitPrice(r.part, r.qty * boards) : null;
    delete r.part;
    return r;
  }).sort((a, b) => cmpRef(a.designators[0], b.designators[0]));
  const noLcsc = bom.filter((r) => !r.lcsc).flatMap((r) => r.designators);
  if (noLcsc.length) err(`LCSC品番が無い部品があります（JLCPCB で実装されません）: ${noLcsc.join(', ')}`, noLcsc);
  const ext = bom.filter((r) => r.lcsc && r.jlcType === 'extended');
  if (ext.length) info(`Extended 部品が ${ext.length} 種類あります（種類ごとに部品の段取り費がかかります）: ${ext.map((r) => r.lcsc).join(', ')}`, ext.flatMap((r) => r.designators));
  const unk = bom.filter((r) => r.lcsc && r.jlcType === 'unknown');
  if (unk.length) warn(`Basic/Extended の区分が不明な部品: ${unk.flatMap((r) => r.designators).join(', ')}（部品画面のオンライン検索で取得できます）`);

  // ---- CPL ----
  const cpl = [];
  const br = { x0: toMm(pcb.outline.x), y0: toMm(pcb.outline.y), x1: toMm(pcb.outline.x + pcb.outline.w), y1: toMm(pcb.outline.y + pcb.outline.h) };
  for (const f of mounted) {
    const x = toMm(f.x), y = toMm(f.y);
    if (x < br.x0 || x > br.x1 || y < br.y0 || y > br.y1) err(`${f.ref} の中心が基板の外です（未配置）`, [f.ref]);
    const bottom = f.side === 'bottom';
    const theta = -(f.rot || 0); // KiCad と同じ「反時計回りが正」
    const base = bottom ? 180 - theta : theta;
    const pk = packageRotation(f.fpDef);
    const manual = Number(f.cplRotOffset) || 0;
    cpl.push({ designator: f.ref, x, y: -y, layer: bottom ? 'Bottom' : 'Top', rotation: norm360(base + pk.deg + manual), base: norm360(base), pkgOffset: pk.deg, manualOffset: manual, matched: pk.matched, footprint: bomPackageName(f.fpDef) });
  }
  const bottoms = cpl.filter((c) => c.layer === 'Bottom').map((c) => c.designator);
  const service = pcbaService(project, pcb, cpl);
  if (service.type === 'standard') {
    info(`注文は「${JLC_PCBA.standard.label}・${service.sides === 'double' ? '両面' : '片面'}」で: ${service.why.join('、')}。` +
      (service.rails ? `基板が ${JLC_PCBA.standard.minMm}×${JLC_PCBA.standard.minMm}mm より小さいので、JLCPCB が ${JLC_PCBA.standard.railMm}mm の捨て基板（エッジレール）を自動で付けます（「Panel by JLCPCB」で面付けを頼んでもよく、そのときも BOM・CPL は 1 枚分のままで JLCPCB が繰り返します）。` : '') +
      `段取り費の目安 $${service.setupUsd}・メタルマスク $${service.stencilUsd}（エコノミーなら $${JLC_PCBA.economic.setupUsd}・$${JLC_PCBA.economic.stencilUsd}）`, bottoms);
  } else {
    info(`注文は「${JLC_PCBA.economic.label}」でできます（片面実装・${copperLayers(pcb).length} 層）。段取り費の目安 $${service.setupUsd}・メタルマスク $${service.stencilUsd}`);
  }
  const noRule = cpl.filter((c) => !c.matched && !c.manualOffset && (mounted.find((f) => f.ref === c.designator)?.fpDef.pads.length || 0) > 3).map((c) => c.designator);
  if (noRule.length) info(`回転補正の表に無いパッケージ（補正 0 で出力）: ${noRule.join(', ')}。JLCPCB の注文画面のプレビューで向きを確かめ、ずれていたら CPL 表の ±90 で直してください`, noRule);
  const gen = mounted.filter((f) => f.fpDef.generated).map((f) => f.ref);
  if (gen.length) warn(`自動生成フットプリントの部品は、JLCPCB のプレビューで位置・向きを確認してください: ${gen.join(', ')}`, gen);

  const nl = project.netlist;
  if (nl && pcb.netlistHash !== nl.sourceHash) warn('PCB が最新のネットリストを取り込んでいません。部品の値・LCSC品番が古いかもしれません');

  const priced = bom.filter((r) => r.unitUsd != null);
  const partsUsd = priced.reduce((s, r) => s + r.unitUsd * r.qty * boards, 0);
  return {
    bom, cpl, problems,
    summary: {
      lines: bom.length, parts: mounted.length, boards,
      partsUsd: priced.length ? Math.round(partsUsd * 100) / 100 : null,
      pricedLines: priced.length,
      service,
      errors: problems.filter((p) => p.level === 'error').length,
      warnings: problems.filter((p) => p.level === 'warning').length,
    },
  };
}

// ---------------- CSV ----------------
const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'; // BOM付きUTF-8（Excelで文字化けしない）

export function bomCsv(asm) {
  return csv([['Comment', 'Designator', 'Footprint', 'LCSC Part #'], ...asm.bom.map((r) => [r.comment, r.designators.join(','), r.footprint, r.lcsc])]);
}
export function cplCsv(asm) {
  return csv([['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], ...asm.cpl.map((c) => [c.designator, num(c.x), num(c.y), c.layer, num(c.rotation, 2)])]);
}
