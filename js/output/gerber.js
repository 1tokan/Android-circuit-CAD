// Gerber（RS-274X / X2 属性付き）と Excellon の書き出し
// 仕様: The Gerber Layer Format Specification (Ucamco) Revision 2024.05 に沿う。
// 単位 mm、座標形式 4.6（%FSLAX46Y46*%）。Y は基板座標（下向き）を反転して上向きにする。

import { layerDefs } from './plot.js';

/** 小数（末尾の0を省く。-0 は 0） */
const dec = (v, n) => { const r = Math.round(v * 10 ** n) / 10 ** n; if (r === 0) return '0'; const s = r.toFixed(n); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const fmtN = (v) => dec(v, 6);
const coord = (v) => String(Math.round(v * 1e6));
const X = (p) => `X${coord(p.x)}Y${coord(-p.y)}`;

const MACROS = {
  RoundRect: [
    '%AMRoundRect*',
    '0 Rectangle with rounded corners*',
    '0 $1 Rounding radius*',
    '0 $2 $3 $4 $5 $6 $7 $8 $9 X,Y pos of 4 corner circle centers*',
    '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*',
    '1,1,$1+$1,$2,$3*',
    '1,1,$1+$1,$4,$5*',
    '1,1,$1+$1,$6,$7*',
    '1,1,$1+$1,$8,$9*',
    '20,1,$1+$1,$2,$3,$4,$5,0*',
    '20,1,$1+$1,$4,$5,$6,$7,0*',
    '20,1,$1+$1,$6,$7,$8,$9,0*',
    '20,1,$1+$1,$8,$9,$2,$3,0*%',
  ].join('\n'),
  OutlineRect: [
    '%AMOutlineRect*',
    '0 Rotated rectangle by its 4 corners*',
    '4,1,4,$1,$2,$3,$4,$5,$6,$7,$8,$1,$2,0*%',
  ].join('\n'),
  Oval: [
    '%AMOval*',
    '0 Rotated obround: end circle centers and diameter*',
    '1,1,$5,$1,$2*',
    '1,1,$5,$3,$4*',
    '20,1,$5,$1,$2,$3,$4,0*%',
  ].join('\n'),
};

/** アパーチャ定義の本体（%ADD の D番号の後ろ） */
function apTemplate(ap) {
  const pt = (q) => `${fmtN(q.x)}X${fmtN(-q.y)}`;
  switch (ap.kind) {
    case 'C': return `C,${fmtN(ap.d)}`;
    case 'R': return `R,${fmtN(ap.w)}X${fmtN(ap.h)}`;
    case 'O': return `O,${fmtN(ap.w)}X${fmtN(ap.h)}`;
    case 'RoundRect': return `RoundRect,${fmtN(ap.r)}X${ap.corners.map(pt).join('X')}`;
    case 'OutlineRect': return `OutlineRect,${ap.corners.map(pt).join('X')}`;
    case 'Oval': return `Oval,${pt(ap.a)}X${pt(ap.b)}X${fmtN(ap.d)}`;
    default: throw new Error(`未知のアパーチャ ${ap.kind}`);
  }
}

/**
 * 1層の Gerber
 * @param layer LAYERS の要素
 * @param prims plot.layers[layer.id]
 * @param meta { software, version, date(ISO), project }
 */
export function writeGerberLayer(layer, prims, meta) {
  const head = [
    `%TF.GenerationSoftware,PocketEDA,${meta.version}*%`,
    `%TF.CreationDate,${meta.date}*%`,
    '%TF.SameCoordinates,Original*%',
    `%TF.FileFunction,${layer.func}*%`,
    `%TF.FilePolarity,${layer.polarity}*%`,
    '%FSLAX46Y46*%',
    `G04 Pocket EDA ${meta.version} : ${String(meta.project).replace(/[^\x20-\x7e]/g, '_').replace(/\*/g, '_')} / ${layer.id}*`,
    '%MOMM*%',
    '%LPD*%',
  ];
  // アパーチャを集める
  const aps = new Map(); // key -> { code, tpl, fn, macro }
  let next = 10;
  const apKey = (ap, fn) => `${fn}|${apTemplate(ap)}`;
  for (const p of prims) {
    let ap = null;
    if (p.t === 'flash') ap = p.ap;
    else if (p.t === 'line') ap = { kind: 'C', d: p.w };
    if (!ap) continue;
    const k = apKey(ap, p.fn);
    if (!aps.has(k)) aps.set(k, { code: next++, tpl: apTemplate(ap), fn: p.fn, macro: MACROS[ap.kind] ? ap.kind : null });
    p._ap = aps.get(k).code;
  }
  const macrosUsed = [...new Set([...aps.values()].map((a) => a.macro).filter(Boolean))];
  const body = [];
  for (const m of macrosUsed) body.push(MACROS[m]);
  for (const a of [...aps.values()].sort((x, y) => x.code - y.code)) {
    body.push(`%TA.AperFunction,${a.fn}*%`);
    body.push(`%ADD${a.code}${a.tpl}*%`);
    body.push('%TD*%');
  }
  body.push('G01*');
  let cur = null, curAp = null, polarity = 'D';
  const setPolarity = (pl) => { if (pl !== polarity) { body.push(`%LP${pl}*%`); polarity = pl; } };
  for (const p of prims) {
    if (p.t === 'region') {
      setPolarity(p.dark ? 'D' : 'C');
      body.push(`%TA.AperFunction,${p.fn}*%`);
      body.push('G36*');
      const ring = p.rings;
      body.push(`${X({ x: ring[0][0], y: ring[0][1] })}D02*`);
      for (let i = 1; i < ring.length; i++) body.push(`${X({ x: ring[i][0], y: ring[i][1] })}D01*`);
      const last = ring.at(-1);
      if (last[0] !== ring[0][0] || last[1] !== ring[0][1]) body.push(`${X({ x: ring[0][0], y: ring[0][1] })}D01*`);
      body.push('G37*');
      body.push('%TD*%');
      cur = null;
      continue;
    }
    setPolarity('D');
    if (p._ap !== curAp) { body.push(`D${p._ap}*`); curAp = p._ap; }
    if (p.t === 'flash') { body.push(`${X(p.at)}D03*`); cur = null; continue; }
    if (p.t === 'line') {
      const ka = `${coord(p.a.x)},${coord(p.a.y)}`;
      if (cur !== ka) body.push(`${X(p.a)}D02*`);
      body.push(`${X(p.b)}D01*`);
      cur = `${coord(p.b.x)},${coord(p.b.y)}`;
    }
  }
  return [...head, ...body, 'M02*', ''].join('\n');
}

/**
 * Excellon ドリル（KiCad と同じ「METRIC・小数表記」）
 * @param holes [{x,y,d}]  @param plated true=メッキ穴(PTH) / false=非メッキ(NPTH)
 */
export function writeExcellon(holes, plated, meta, layers = 2) {
  const sizes = [...new Set(holes.map((h) => Math.round(h.d * 1000) / 1000))].sort((a, b) => a - b);
  const out = [
    'M48',
    `; DRILL file {Pocket EDA ${meta.version}} date ${meta.date}`,
    '; FORMAT={-:-/ absolute / metric / decimal}',
    `; #@! TF.FileFunction,${plated ? `Plated,1,${layers},PTH` : `NonPlated,1,${layers},NPTH`}`,
    'FMAT,2',
    'METRIC',
  ];
  sizes.forEach((d, i) => out.push(`T${i + 1}C${d.toFixed(3)}`));
  out.push('%', 'G90', 'G05');
  // 小数点を必ず付ける（小数点が無いと、読み手によっては整数形式＝ゼロ省略として解釈される）
  const f = (v) => { const r = Math.round(v * 1000) / 1000; return (r === 0 ? 0 : r).toFixed(3); };
  sizes.forEach((d, i) => {
    out.push(`T${i + 1}`);
    for (const h of holes) if (Math.round(h.d * 1000) / 1000 === d) out.push(`X${f(h.x)}Y${f(-h.y)}`);
  });
  out.push('M30', '');
  return out.join('\n');
}

/** 全ファイル（名前 → 内容） */
export function gerberFiles(plot, { project = 'board', version = '0', date = new Date().toISOString() } = {}) {
  const base = String(project).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'board';
  const meta = { version, date: isoLocal(date), project };
  const files = [];
  for (const l of plot.layerDefs || layerDefs(plot.layerCount || 2)) {
    const prims = plot.layers[l.id];
    // メタルマスクで何も無い面は出さない（裏に部品が無い場合など）
    if (/Paste/.test(l.id) && !prims.length) continue;
    files.push({ name: `${base}-${l.id.replace('.', '_')}.${l.ext}`, layer: l.id, content: writeGerberLayer(l, prims, meta) });
  }
  files.push({ name: `${base}-PTH.drl`, layer: 'PTH', content: writeExcellon(plot.drills.pth, true, meta, plot.layerCount || 2) });
  if (plot.drills.npth.length) files.push({ name: `${base}-NPTH.drl`, layer: 'NPTH', content: writeExcellon(plot.drills.npth, false, meta, plot.layerCount || 2) });
  return files;
}

function isoLocal(iso) {
  // X2 の CreationDate は ISO 8601（タイムゾーン付き）
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  const z = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}${sign}${z(Math.floor(Math.abs(off) / 60))}:${z(Math.abs(off) % 60)}`;
}
