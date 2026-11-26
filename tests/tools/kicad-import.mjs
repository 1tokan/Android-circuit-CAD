// KiCad 公式フットプリントライブラリから、内蔵フットプリントの寸法（js/library/fp-kicad.js）を作る
// 使い方:
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/KiCad/kicad-footprints.git /tmp/kfp
//   (cd /tmp/kfp && git sparse-checkout set $(node tests/tools/kicad-import.mjs --dirs))
//   KICAD_FP_DIR=/tmp/kfp node tests/tools/kicad-import.mjs
// 内蔵フットプリントの寸法はすべてここから作る（js/library/footprints.js は名前・説明だけを持つ）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// 内蔵 ID → KiCad のファイル（ライブラリ/名前）と変更
//   ep: 露出パッドの大きさを変える（KiCad の同じ外形で露出パッドだけ違う部品）
const MAP = {
  R_0402: 'Resistor_SMD.pretty/R_0402_1005Metric', R_0603: 'Resistor_SMD.pretty/R_0603_1608Metric', R_0805: 'Resistor_SMD.pretty/R_0805_2012Metric', R_1206: 'Resistor_SMD.pretty/R_1206_3216Metric',
  C_0402: 'Capacitor_SMD.pretty/C_0402_1005Metric', C_0603: 'Capacitor_SMD.pretty/C_0603_1608Metric', C_0805: 'Capacitor_SMD.pretty/C_0805_2012Metric', C_1206: 'Capacitor_SMD.pretty/C_1206_3216Metric',
  L_0603: 'Inductor_SMD.pretty/L_0603_1608Metric', L_0805: 'Inductor_SMD.pretty/L_0805_2012Metric',
  LED_0603: 'LED_SMD.pretty/LED_0603_1608Metric', LED_0805: 'LED_SMD.pretty/LED_0805_2012Metric',
  'D_SOD-123': 'Diode_SMD.pretty/D_SOD-123', 'D_SOD-323': 'Diode_SMD.pretty/D_SOD-323', 'D_SOD-523': 'Diode_SMD.pretty/D_SOD-523', D_SMA: 'Diode_SMD.pretty/D_SMA',
  'SOT-23': 'Package_TO_SOT_SMD.pretty/SOT-23', 'SOT-23-5': 'Package_TO_SOT_SMD.pretty/SOT-23-5', 'SOT-23-6': 'Package_TO_SOT_SMD.pretty/SOT-23-6', 'SOT-223-3_TabPin2': 'Package_TO_SOT_SMD.pretty/SOT-223-3_TabPin2',
  'SOIC-8': 'Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm', 'SOIC-14': 'Package_SO.pretty/SOIC-14_3.9x8.7mm_P1.27mm', 'SOIC-16': 'Package_SO.pretty/SOIC-16_3.9x9.9mm_P1.27mm',
  'TSSOP-8': 'Package_SO.pretty/TSSOP-8_4.4x3mm_P0.65mm', 'TSSOP-14': 'Package_SO.pretty/TSSOP-14_4.4x5mm_P0.65mm', 'TSSOP-20': 'Package_SO.pretty/TSSOP-20_4.4x6.5mm_P0.65mm',
  'DIP-8': 'Package_DIP.pretty/DIP-8_W7.62mm', 'DIP-14': 'Package_DIP.pretty/DIP-14_W7.62mm', 'DIP-16': 'Package_DIP.pretty/DIP-16_W7.62mm',
  'CP_Elec_5x5.4': 'Capacitor_SMD.pretty/CP_Elec_5x5.4', 'CP_Elec_6.3x5.4': 'Capacitor_SMD.pretty/CP_Elec_6.3x5.4', SW_PUSH_6mm: 'Button_Switch_THT.pretty/SW_PUSH_6mm',
  'QFN-56-1EP_7x7mm_P0.4mm_EP4.0x4.0mm': { file: 'Package_DFN_QFN.pretty/QFN-56-1EP_7x7mm_P0.4mm_EP5.6x5.6mm', ep: { num: '57', w: 4.0, h: 4.0 } },
  'WQFN-16-1EP_3x3mm_P0.5mm_EP1.75x1.75mm': 'Package_DFN_QFN.pretty/WQFN-16-1EP_3x3mm_P0.5mm_EP1.75x1.75mm',
  'TQFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm': 'Package_DFN_QFN.pretty/TQFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm',
  'Crystal_SMD_3225-4Pin_3.2x2.5mm': 'Crystal.pretty/Crystal_SMD_3225-4Pin_3.2x2.5mm',
  'TestPoint_Pad_1.0x1.0mm': 'TestPoint.pretty/TestPoint_Pad_1.0x1.0mm',
  'USB_C_HRO_TYPE-C-31-M-12': 'Connector_USB.pretty/USB_C_Receptacle_HRO_TYPE-C-31-M-12',
  'Jack_3.5mm_CUI_SJ-3524-SMT_Horizontal': 'Connector_Audio.pretty/Jack_3.5mm_CUI_SJ-3524-SMT_Horizontal',
  'JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal': 'Connector_JST.pretty/JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal',
};
for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) MAP[`PinHeader_1x${String(n).padStart(2, '0')}_P2.54mm`] = `Connector_PinHeader_2.54mm.pretty/PinHeader_1x${String(n).padStart(2, '0')}_P2.54mm_Vertical`;
for (const n of [2, 3, 4]) MAP[`JST_PH_B${n}B-PH-K_1x${String(n).padStart(2, '0')}_P2.00mm`] = `Connector_JST.pretty/JST_PH_B${n}B-PH-K_1x${String(n).padStart(2, '0')}_P2.00mm_Vertical`;
const entry = (v) => (typeof v === 'string' ? { file: v } : v);

if (process.argv.includes('--dirs')) { console.log([...new Set(Object.values(MAP).map((v) => entry(v).file.split('/')[0]))].join(' ')); process.exit(0); }

const K = (process.env.KICAD_FP_DIR || '/tmp/kfp') + '/';
const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * .kicad_mod を読む
 * - 銅の無いパッド（メタルマスクの分割だけのもの）と番号の無いパッドは除く
 * - 非メッキの穴（np_thru_hole）は npth に分ける（フットプリントの一部。部品と一緒に動き、Gerber・Excellon・DRC では非メッキ穴として扱う）
 * - 同じ位置に重なったパッド（USB-C の A1 と B12 など）は 1 つにし、後の番号を alias に入れる
 * - 回転 90/270° のパッドは幅と高さを入れ替える。楕円の穴（drill oval）は長穴（slot）
 */
export function readKicadMod(path, { ep = null } = {}) {
  const s = fs.readFileSync(path, 'utf8');
  const pads = [], npth = [], alias = {};
  const seen = new Map();
  const re = /\(pad\s+"?([^\s")]*)"?\s+(smd|thru_hole|np_thru_hole)\s+(\w+)\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)(?:\s+\(drill\s+(oval\s+)?([-\d.]+)(?:\s+([-\d.]+))?\))?\s+\(layers\s+([^)]*)\)([^\n]*)/g;
  for (const m of s.matchAll(re)) {
    const [, num, type, shape, x, y, rot, w0, h0, oval, d1, d2, layers, rest] = m;
    if (type === 'np_thru_hole') { npth.push({ x: +x, y: +y, d: +d1 }); continue; }
    if (!num || !/F\.Cu|\*\.Cu/.test(layers)) continue;
    const key = `${x},${y}`;
    if (seen.has(key)) { alias[num] = seen.get(key); continue; }
    seen.set(key, num);
    const turned = Math.abs(+(rot || 0)) % 180 === 90;
    let w = +w0, h = +h0;
    if (turned) [w, h] = [h, w];
    const sh = shape === 'roundrect' ? 'roundrect' : shape === 'oval' ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : shape === 'circle' ? 'circle' : 'rect';
    const p = { num, x: +x, y: +y, w, h, shape: sh, type: type === 'smd' ? 'smd' : 'tht' };
    if (p.type === 'tht') {
      if (oval && d2 && Math.abs(+d1 - +d2) > 1e-6) {
        let sw = +d1, sh2 = +d2;
        if (turned) [sw, sh2] = [sh2, sw];
        p.slot = { w: sw, h: sh2 };
        p.drill = Math.min(sw, sh2);
      } else p.drill = +d1;
    }
    const rr = /\(roundrect_rratio\s+([-\d.]+)\)/.exec(rest);
    if (sh === 'roundrect' && rr && Math.abs(+rr[1] - 0.25) > 1e-6) p.rr = +rr[1];
    if (ep && p.num === ep.num) { p.w = ep.w; p.h = ep.h; }
    pads.push(p);
  }
  const bbox = (layer) => {
    const xs = [], ys = [];
    const L = layer.replace('.', '\\.');
    for (const m of s.matchAll(new RegExp(`\\(fp_(?:line|rect)\\s+\\(start\\s+([-\\d.]+)\\s+([-\\d.]+)\\)\\s+\\(end\\s+([-\\d.]+)\\s+([-\\d.]+)\\)[^\\n]*?\\(layer\\s+"?${L}"?\\)`, 'g'))) { xs.push(+m[1], +m[3]); ys.push(+m[2], +m[4]); }
    for (const m of s.matchAll(new RegExp(`\\(fp_circle\\s+\\(center\\s+([-\\d.]+)\\s+([-\\d.]+)\\)\\s+\\(end\\s+([-\\d.]+)\\s+([-\\d.]+)\\)[^\\n]*?\\(layer\\s+"?${L}"?\\)`, 'g'))) {
      const r = Math.hypot(+m[3] - +m[1], +m[4] - +m[2]); xs.push(+m[1] - r, +m[1] + r); ys.push(+m[2] - r, +m[2] + r);
    }
    return xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : null;
  };
  return { pads, npth, alias, courtyard: bbox('F.CrtYd'), fab: bbox('F.Fab') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gen = {};
  for (const [id, v] of Object.entries(MAP)) {
    const e = entry(v);
    const file = K + e.file + '.kicad_mod';
    if (!fs.existsSync(file)) { console.error('見つからない:', file); process.exitCode = 1; continue; }
    const k = readKicadMod(file, e);
    // 原点: SMD を含む部品は KiCad と同じ（部品の中心）。スルーホールだけの部品はパッド群の中心（KiCad は 1 番ピン）
    let ox = 0, oy = 0;
    if (k.pads.every((p) => p.type === 'tht')) { const xs = k.pads.map((p) => p.x), ys = k.pads.map((p) => p.y); ox = (Math.min(...xs) + Math.max(...xs)) / 2; oy = (Math.min(...ys) + Math.max(...ys)) / 2; }
    const pads = k.pads.map((p) => ({ ...p, x: r4(p.x - ox), y: r4(p.y - oy), w: r4(p.w), h: r4(p.h) }));
    const out = { kicad: e.file.split('/')[1], pads };
    if (e.ep) out.note = `露出パッドを ${e.ep.w}×${e.ep.h}mm に変更`;
    const cy = k.courtyard, fab = k.fab;
    if (cy) out.courtyard = { x0: r4(cy.x0 - ox), y0: r4(cy.y0 - oy), x1: r4(cy.x1 - ox), y1: r4(cy.y1 - oy) };
    if (fab) out.body = { w: r4(fab.x1 - fab.x0), h: r4(fab.y1 - fab.y0), cx: r4((fab.x0 + fab.x1) / 2 - ox), cy: r4((fab.y0 + fab.y1) / 2 - oy) };
    if (k.npth.length) out.npth = k.npth.map((h) => ({ x: r4(h.x - ox), y: r4(h.y - oy), d: h.d }));
    if (Object.keys(k.alias).length) out.alias = k.alias;
    gen[id] = out;
  }
  let commit = process.env.KCOMMIT || '';
  try { commit ||= execFileSync('git', ['-C', K, 'log', '-1', '--format=%H'], { encoding: 'utf8' }).trim(); } catch { /* git でない */ }
  fs.writeFileSync(new URL('../../js/library/fp-kicad.js', import.meta.url),
`// KiCad 公式フットプリントライブラリから取り出したパッド・外形枠・本体・取付穴の寸法（このファイルは tests/tools/kicad-import.mjs で生成。手で直さない）
// 出典: KiCad Libraries（https://github.com/KiCad/kicad-footprints の GitHub ミラー、commit ${commit}）
// ライセンス: CC-BY-SA 4.0（KiCad ライブラリの例外条項つき）。このデータを使って作った設計・製造データには適用されません。
// 原点: SMD を含む部品は KiCad と同じ（部品の中心）、スルーホールだけの部品はパッド群の中心（KiCad は 1 番ピン）。
// npth: 非メッキの穴（位置決めピンなど。フットプリントの一部として部品と一緒に動く）。alias: 同じ位置に重なっていたパッドの番号 → 残したパッドの番号
export const KICAD_FP = ${JSON.stringify(gen)};
`);
  console.log('generated', Object.keys(gen).length);
}
