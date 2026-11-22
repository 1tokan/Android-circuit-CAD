import fs from 'node:fs';
const { listFootprints } = await import(new URL('../../js/library/footprints.js', import.meta.url).href);
// 使い方: git clone --depth 1 --filter=blob:none --sparse https://github.com/KiCad/kicad-footprints.git /tmp/kfp && (cd /tmp/kfp && git sparse-checkout set Resistor_SMD.pretty Capacitor_SMD.pretty Inductor_SMD.pretty LED_SMD.pretty Diode_SMD.pretty Package_TO_SOT_SMD.pretty Package_SO.pretty Package_DIP.pretty Connector_PinHeader_2.54mm.pretty Connector_JST.pretty Button_Switch_THT.pretty)
//   KICAD_FP_DIR=/tmp/kfp KCOMMIT=$(git -C /tmp/kfp log -1 --format=%H) node tests/tools/kicad-import.mjs
// 内蔵フットプリントと KiCad 公式データを比べて差を表示し、js/library/fp-kicad.js を作り直す
const K = (process.env.KICAD_FP_DIR || '/tmp/kfp') + '/';
const MAP = {
  R_0402: 'Resistor_SMD.pretty/R_0402_1005Metric', R_0603: 'Resistor_SMD.pretty/R_0603_1608Metric', R_0805: 'Resistor_SMD.pretty/R_0805_2012Metric', R_1206: 'Resistor_SMD.pretty/R_1206_3216Metric',
  C_0402: 'Capacitor_SMD.pretty/C_0402_1005Metric', C_0603: 'Capacitor_SMD.pretty/C_0603_1608Metric', C_0805: 'Capacitor_SMD.pretty/C_0805_2012Metric', C_1206: 'Capacitor_SMD.pretty/C_1206_3216Metric',
  L_0603: 'Inductor_SMD.pretty/L_0603_1608Metric', L_0805: 'Inductor_SMD.pretty/L_0805_2012Metric',
  LED_0603: 'LED_SMD.pretty/LED_0603_1608Metric', LED_0805: 'LED_SMD.pretty/LED_0805_2012Metric',
  'D_SOD-123': 'Diode_SMD.pretty/D_SOD-123', 'D_SOD-323': 'Diode_SMD.pretty/D_SOD-323', D_SMA: 'Diode_SMD.pretty/D_SMA',
  'SOT-23': 'Package_TO_SOT_SMD.pretty/SOT-23', 'SOT-23-5': 'Package_TO_SOT_SMD.pretty/SOT-23-5', 'SOT-223-3_TabPin2': 'Package_TO_SOT_SMD.pretty/SOT-223-3_TabPin2',
  'SOIC-8': 'Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm', 'SOIC-14': 'Package_SO.pretty/SOIC-14_3.9x8.7mm_P1.27mm', 'SOIC-16': 'Package_SO.pretty/SOIC-16_3.9x9.9mm_P1.27mm',
  'TSSOP-8': 'Package_SO.pretty/TSSOP-8_4.4x3mm_P0.65mm', 'TSSOP-14': 'Package_SO.pretty/TSSOP-14_4.4x5mm_P0.65mm', 'TSSOP-20': 'Package_SO.pretty/TSSOP-20_4.4x6.5mm_P0.65mm',
  'DIP-8': 'Package_DIP.pretty/DIP-8_W7.62mm', 'DIP-14': 'Package_DIP.pretty/DIP-14_W7.62mm', 'DIP-16': 'Package_DIP.pretty/DIP-16_W7.62mm',
  'CP_Elec_5x5.4': 'Capacitor_SMD.pretty/CP_Elec_5x5.4', 'CP_Elec_6.3x5.4': 'Capacitor_SMD.pretty/CP_Elec_6.3x5.4', SW_PUSH_6mm: 'Button_Switch_THT.pretty/SW_PUSH_6mm',
};
for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) MAP[`PinHeader_1x${String(n).padStart(2, '0')}_P2.54mm`] = `Connector_PinHeader_2.54mm.pretty/PinHeader_1x${String(n).padStart(2, '0')}_P2.54mm_Vertical`;
for (const n of [2, 3, 4]) MAP[`JST_PH_B${n}B-PH-K_1x${String(n).padStart(2, '0')}_P2.00mm`] = `Connector_JST.pretty/JST_PH_B${n}B-PH-K_1x${String(n).padStart(2, '0')}_P2.00mm_Vertical`;
export function parseKicad(path) {
  const s = fs.readFileSync(path, 'utf8');
  const pads = [];
  for (const m of s.matchAll(/\(pad\s+"?([^\s")]*)"?\s+(smd|thru_hole|np_thru_hole)\s+(\w+)\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)(?:\s+\(drill\s+([-\d.]+)\))?[^\n]*?(?:\(roundrect_rratio\s+([-\d.]+)\))?/g)) {
    pads.push({ num: m[1], type: m[2] === 'smd' ? 'smd' : 'tht', shape: m[3], x: +m[4], y: +m[5], rot: +(m[6] || 0), w: +m[7], h: +m[8], drill: m[9] ? +m[9] : undefined, rr: m[10] ? +m[10] : undefined });
  }
  return pads;
}
const out = {};
for (const fp of listFootprints()) {
  const k = MAP[fp.id];
  if (!k) { out[fp.id] = 'no-kicad'; continue; }
  const file = K + k + '.kicad_mod';
  if (!fs.existsSync(file)) { out[fp.id] = 'missing ' + k; continue; }
  const kp = parseKicad(file).filter((p) => p.num !== '');
  // KiCad の回転パッド（rot 90/270）は w/h を入れ替えて比べる
  for (const p of kp) if (Math.abs(p.rot) % 180 === 90) [p.w, p.h] = [p.h, p.w];
  const a1 = fp.pads.find((p) => p.num === '1'), b1 = kp.find((p) => p.num === '1');
  const dx = b1.x - a1.x, dy = b1.y - a1.y; // KiCad 座標 = ours + d
  const diffs = [];
  if (kp.length !== fp.pads.length) diffs.push(`pad count ${fp.pads.length} vs ${kp.length}`);
  const used = new Set();
  for (const p of fp.pads) {
    const q = kp.find((r, i) => !used.has(i) && r.num === p.num && Math.abs(r.x - (p.x + dx)) < 0.02 && Math.abs(r.y - (p.y + dy)) < 0.02);
    if (!q) { diffs.push(`pad ${p.num} pos (${p.x},${p.y}) not found`); continue; }
    used.add(kp.indexOf(q));
    if (Math.abs(q.w - p.w) > 0.005 || Math.abs(q.h - p.h) > 0.005) diffs.push(`pad ${p.num} size ${p.w}x${p.h} vs ${q.w}x${q.h}`);
    const ks = q.shape === 'roundrect' ? 'roundrect' : q.shape === 'oval' ? (Math.abs(q.w - q.h) < 1e-6 ? 'circle' : 'oval') : q.shape;
    if (ks !== p.shape && !(ks === 'circle' && p.shape === 'circle')) diffs.push(`pad ${p.num} shape ${p.shape} vs ${q.shape}${q.rr ? ' rr' + q.rr : ''}`);
    if (p.type === 'tht' && Math.abs((q.drill || 0) - p.drill) > 0.005) diffs.push(`pad ${p.num} drill ${p.drill} vs ${q.drill}`);
  }
  out[fp.id] = diffs.length ? diffs.slice(0, 4).join('; ') + (diffs.length > 4 ? ` (+${diffs.length - 4})` : '') : `OK (origin offset ${dx.toFixed(3)},${dy.toFixed(3)})`;
}
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(36), v);

// ---- 生成: KiCad のパッド・外形枠・本体を、この CAD の形式（原点 = パッドの外接矩形の中心は使わず、SMD は KiCad の原点、THT はパッド群の中心）へ
function bbox(s, layer) {
  const xs = [], ys = [];
  const re = new RegExp(`\\(fp_(?:line|rect)\\s+\\(start\\s+([-\\d.]+)\\s+([-\\d.]+)\\)\\s+\\(end\\s+([-\\d.]+)\\s+([-\\d.]+)\\)[^\\n]*\\(layer\\s+${layer.replace('.', '\\.')}\\)`, 'g');
  for (const m of s.matchAll(re)) { xs.push(+m[1], +m[3]); ys.push(+m[2], +m[4]); }
  for (const m of s.matchAll(new RegExp(`\\(fp_circle\\s+\\(center\\s+([-\\d.]+)\\s+([-\\d.]+)\\)\\s+\\(end\\s+([-\\d.]+)\\s+([-\\d.]+)\\)[^\\n]*\\(layer\\s+${layer.replace('.', '\\.')}\\)`, 'g'))) {
    const r = Math.hypot(+m[3] - +m[1], +m[4] - +m[2]); xs.push(+m[1] - r, +m[1] + r); ys.push(+m[2] - r, +m[2] + r);
  }
  return xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : null;
}
const r4 = (v) => Math.round(v * 10000) / 10000;
const gen = {};
for (const [id, k] of Object.entries(MAP)) {
  const file = K + k + '.kicad_mod';
  if (!fs.existsSync(file)) continue;
  const s = fs.readFileSync(file, 'utf8');
  const kp = parseKicad(file).filter((p) => p.num !== '');
  const tht = kp.some((p) => p.type === 'tht');
  let ox = 0, oy = 0;
  if (tht) { const xs = kp.map((p) => p.x), ys = kp.map((p) => p.y); ox = (Math.min(...xs) + Math.max(...xs)) / 2; oy = (Math.min(...ys) + Math.max(...ys)) / 2; }
  const pads = kp.map((p) => {
    let w = p.w, h = p.h;
    if (Math.abs(p.rot) % 180 === 90) [w, h] = [h, w];
    const shape = p.shape === 'oval' && Math.abs(w - h) < 1e-9 ? 'circle' : p.shape === 'roundrect' ? 'roundrect' : p.shape === 'oval' ? 'oval' : p.shape === 'circle' ? 'circle' : 'rect';
    const o = { num: p.num, x: r4(p.x - ox), y: r4(p.y - oy), w: r4(w), h: r4(h), shape, type: p.type };
    if (p.type === 'tht') o.drill = p.drill;
    if (shape === 'roundrect' && p.rr && Math.abs(p.rr - 0.25) > 1e-6) o.rr = p.rr;
    return o;
  });
  const cy = bbox(s, 'F.CrtYd'), fab = bbox(s, 'F.Fab');
  gen[id] = {
    kicad: k.split('/')[1],
    pads,
    courtyard: cy && { x0: r4(cy.x0 - ox), y0: r4(cy.y0 - oy), x1: r4(cy.x1 - ox), y1: r4(cy.y1 - oy) },
    body: fab && { w: r4(fab.x1 - fab.x0), h: r4(fab.y1 - fab.y0), cx: r4((fab.x0 + fab.x1) / 2 - ox), cy: r4((fab.y0 + fab.y1) / 2 - oy) },
  };
}
const commit = process.env.KCOMMIT;
fs.writeFileSync(new URL('../../js/library/fp-kicad.js', import.meta.url),
`// KiCad 公式フットプリントライブラリから取り出したパッド・外形枠・本体の寸法（このファイルは tests/tools/kicad-import.mjs で生成）
// 出典: KiCad Libraries（https://github.com/KiCad/kicad-footprints の GitHub ミラー、commit ${commit}）
// ライセンス: CC-BY-SA 4.0（KiCad ライブラリの例外条項つき）。このデータを使って作った設計・製造データには適用されません。
// 原点: SMD は KiCad と同じ（部品の中心）、スルーホール部品はパッド群の中心（KiCad は1番ピン）。
export const KICAD_FP = ${JSON.stringify(gen)};
`);
console.log('generated', Object.keys(gen).length);
