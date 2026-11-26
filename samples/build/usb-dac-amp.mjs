// サンプル「USB DAC アンプ」を作る（samples/usb-dac-amp.json）。アプリと同じ処理（回路仕様 → 回路図 → ネットリスト → PCB → 自動配線 → ベタ → 検査）を通す。
// 使い方:
//   node samples/build/usb-dac-amp.mjs          作り直して samples/usb-dac-amp.json に書く（検査の結果を表示）
//   node samples/build/usb-dac-amp.mjs --check  作り直した結果が samples/usb-dac-amp.json と同じかを確かめる（tests/sample-build.test.mjs）
// ID と日時は決まった値にするので、同じプログラムからは毎回同じファイルになる。
//
// 設計の要点（詳しくは README の「サンプル」）
//  - 60×26mm・4層（In1 = GND、In2 = 電源の分割）・片面実装（JLCPCB のエコノミー PCBA は片面だけ）
//  - USB-C → P-ch MOSFET でゆっくり入れる（突入電流の制限）→ LDO ×2（デジタル／アナログの 3.3V）・ロードスイッチ（スピーカー用 5V）
//  - ESP32-S3 → I2S を GPIO マトリクスで 3 組に出す → PCM5102A＋TPA6132A2（ヘッドホン）／MAX98357A ×2（スピーカー）
//  - 部品のフットプリントはすべてアプリ内蔵（KiCad 公式の寸法）
import fs from 'node:fs';
import { loadModules } from '../../tests/scenarios.js';

const ROOT = new URL('../../', import.meta.url);
const M = await loadModules(ROOT.href);
const { autoroute } = await import(new URL('js/pcb/autoroute.js', ROOT).href);
const { netWidthFor } = await import(new URL('js/check/current.js', ROOT).href);
const { placeRefdes } = await import(new URL('js/pcb/shapes.js', ROOT).href);
const { addStitchVias, planeSplitCrossings } = await import(new URL('js/pcb/stitch.js', ROOT).href);
const OUT = new URL('samples/usb-dac-amp.json', ROOT);
const CHECK = process.argv.includes('--check');
const log = (...a) => { if (!CHECK) console.error(...a); };

// 決まった ID・日時（同じ入力から同じファイル）
const FIXED_TIME = Date.UTC(2026, 10, 23, 0, 0, 0);
let idCount = 0;
M.project.setIdSource(() => `s${(++idCount).toString(36).padStart(5, '0')}`);

// ---------------- 部品 ----------------
const part = (o) => M.parts.normalizePart({ source: 'user', jlc: { type: o.jlcType || 'unknown' }, lcscVerified: !!o.verified, ...o });
const names = (arr) => arr.join(',');
const USBC_ALIAS = M.fps.getFootprint('USB_C_HRO_TYPE-C-31-M-12').alias; // 同じ位置に重なっていたパッド（B12 → A1 など）
const ESP_PINS = ['LNA_IN', 'VDD3P3', 'VDD3P3', 'CHIP_PU', 'GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7', 'GPIO8', 'GPIO9', 'GPIO10', 'GPIO11', 'GPIO12', 'GPIO13', 'GPIO14', 'VDD3P3_RTC',
  'XTAL_32K_P', 'XTAL_32K_N', 'GPIO17', 'GPIO18', 'GPIO19/USB_D-', 'GPIO20/USB_D+', 'GPIO21', 'SPICS1', 'VDD_SPI', 'SPIHD', 'SPIWP', 'SPICS0', 'SPICLK', 'SPIQ', 'SPID', 'SPICLK_N', 'SPICLK_P', 'GPIO33', 'GPIO34', 'GPIO35',
  'GPIO36', 'GPIO37', 'GPIO38', 'MTCK', 'MTDO', 'VDD3P3_CPU', 'MTDI', 'MTMS', 'U0TXD', 'U0RXD', 'GPIO45', 'GPIO46', 'XTAL_N', 'XTAL_P', 'VDDA', 'VDDA', 'GND(EP)'];
// ESP32-S3 の使うピン（ほかは未使用ピン）。ヘッドホンアンプの EN は +3V3A に直結（常に有効。内蔵のポップ音抑制と DAC のミュート XSMT で足りる。待機電流 約 4mA）
const ESP_USED = [2, 3, 4, 5, 6, 7, 20, 22, 23, 24, 25, 26, 27, 29, 39, 40, 41, 42, 43, 44, 45, 47, 46, 48, 53, 54, 55, 56, 57];
const nc = (n, used) => Object.fromEntries(Array.from({ length: n }, (_, i) => String(i + 1)).filter((k) => !used.includes(Number(k))).map((k) => [k, []]));

const P = {
  usbc: part({ name: 'USB Type-C 16P（HRO TYPE-C-31-M-12）', kind: 'connector', value: 'USB-C', manufacturer: 'Korean Hroparts Elec', mpn: 'TYPE-C-31-M-12', lcsc: 'C165948', verified: true, jlcType: 'extended', package: 'SMD', footprint: 'USB_C_HRO_TYPE-C-31-M-12',
    symbol: { kind: 'connector', pinCount: 9, pinNames: names(['GND', 'VBUS', 'CC1', 'D+', 'D-', 'CC2', 'SBU1', 'SBU2', 'SHIELD']) },
    pinMap: Object.fromEntries(Object.entries({ 1: ['A1', 'A12'], 2: ['A4', 'A9'], 3: ['A5'], 4: ['A6', 'B6'], 5: ['A7', 'B7'], 6: ['B5'], 7: [], 8: [], 9: ['S1'] }).map(([k, v]) => [k, [...new Set(v.map((n) => USBC_ALIAS[n] || n))]])) }),
  esd: part({ name: 'USB ESD 保護 USBLC6-2SC6', kind: 'ic', value: 'USBLC6-2SC6', manufacturer: 'STMicroelectronics', mpn: 'USBLC6-2SC6', lcsc: 'C7519', verified: true, jlcType: 'extended', package: 'SOT-23-6', footprint: 'SOT-23-6',
    symbol: { kind: 'ic', pinCount: 6, pinNames: names(['IO1', 'GND', 'IO2', 'IO2', 'VBUS', 'IO1']) } }),
  ldo: part({ name: 'LDO 3.3V 500mA ME6211C33M5G-N', kind: 'ic', value: 'ME6211C33', manufacturer: 'MICRONE', mpn: 'ME6211C33M5G-N', lcsc: 'C82942', verified: true, jlcType: 'extended', package: 'SOT-23-5', footprint: 'SOT-23-5',
    symbol: { kind: 'ic', pinCount: 5, pinNames: names(['VIN', 'VSS', 'CE', 'NC', 'VOUT']) }, pinMap: { 4: [] } }),
  esp: part({ name: 'ESP32-S3FN8（8MB フラッシュ内蔵）', kind: 'ic', value: 'ESP32-S3FN8', manufacturer: 'Espressif', mpn: 'ESP32-S3FN8', lcsc: 'C2913196', verified: true, jlcType: 'extended', package: 'QFN-56-EP(7x7)', footprint: 'QFN-56-1EP_7x7mm_P0.4mm_EP4.0x4.0mm',
    symbol: { kind: 'ic', pinCount: 57, pinNames: names(ESP_PINS) }, pinMap: nc(57, ESP_USED) }),
  xtal: part({ name: '水晶 40MHz 15pF 3225', kind: 'ic', value: '40MHz', manufacturer: 'YXC', mpn: 'X322540MPB4SI', lcsc: 'C9010', verified: true, jlcType: 'extended', package: 'SMD3225-4P', footprint: 'Crystal_SMD_3225-4Pin_3.2x2.5mm',
    symbol: { kind: 'ic', pinCount: 4, pinNames: names(['XIN', 'GND', 'XOUT', 'GND']) } }),
  dac: part({ name: 'DAC PCM5102APWR（32bit/384kHz）', kind: 'ic', value: 'PCM5102A', manufacturer: 'Texas Instruments', mpn: 'PCM5102APWR', lcsc: 'C107671', verified: true, jlcType: 'extended', package: 'TSSOP-20', footprint: 'TSSOP-20',
    symbol: { kind: 'ic', pinCount: 20, pinNames: names(['CPVDD', 'CAPP', 'CPGND', 'CAPM', 'VNEG', 'OUTL', 'OUTR', 'AVDD', 'AGND', 'DEMP', 'FLT', 'SCK', 'BCK', 'DIN', 'LRCK', 'FMT', 'XSMT', 'LDOO', 'DGND', 'DVDD']) } }),
  hp: part({ name: 'ヘッドホンアンプ TPA6132A2RTER', kind: 'ic', value: 'TPA6132A2', manufacturer: 'Texas Instruments', mpn: 'TPA6132A2RTER', lcsc: 'C69901', verified: true, jlcType: 'extended', package: 'WQFN-16-EP(3x3)', footprint: 'WQFN-16-1EP_3x3mm_P0.5mm_EP1.75x1.75mm',
    symbol: { kind: 'ic', pinCount: 17, pinNames: names(['INL-', 'INL+', 'INR+', 'INR-', 'OUTR', 'G0', 'G1', 'HPVSS', 'CPN', 'PGND', 'CPP', 'HPVDD', 'EN', 'VDD', 'SGND', 'OUTL', 'EP']) } }),
  amp: part({ name: 'D 級アンプ MAX98357AETE+T（I2S 入力）', kind: 'ic', value: 'MAX98357A', manufacturer: 'Analog Devices / Maxim', mpn: 'MAX98357AETE+T', lcsc: 'C910544', verified: true, jlcType: 'extended', package: 'TQFN-16-EP(3x3)', footprint: 'TQFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm',
    symbol: { kind: 'ic', pinCount: 17, pinNames: names(['DIN', 'GAIN_SLOT', 'GND', 'SD_MODE', 'NC', 'NC', 'VDD', 'VDD', 'OUTP', 'OUTN', 'GND', 'NC', 'NC', 'LRCLK', 'GND', 'BCLK', 'EP']) },
    pinMap: { 5: [], 6: [], 12: [], 13: [] } }),
  // 電源の入口: P チャネル MOSFET（耐圧 30V。挿した瞬間の電圧の跳ね上がりに耐える。動作中の切り替え・待機電流なし）
  pfet: part({ name: 'P-ch MOSFET AO3401A（電源の入口・ゆっくり入れる）', kind: 'pmos', value: 'AO3401A', manufacturer: 'Alpha & Omega Semicon', mpn: 'AO3401A', lcsc: 'C15127', verified: true, jlcType: 'basic', package: 'SOT-23', footprint: 'SOT-23' }),
  sw: part({ name: 'ロードスイッチ TPS22918DBVR（立ち上がり時間を調整・突入電流を抑える）', kind: 'ic', value: 'TPS22918', manufacturer: 'Texas Instruments', mpn: 'TPS22918DBVR', lcsc: 'C131941', verified: true, jlcType: 'extended', package: 'SOT-23-6', footprint: 'SOT-23-6',
    symbol: { kind: 'ic', pinCount: 6, pinNames: names(['VIN', 'GND', 'ON', 'CT', 'QOD', 'VOUT']) } }),
  // ESD: ヘッドホン出力は 0V を中心に ± に振れるので双方向。KiCad 公式のフットプリントがある SOD-523 を選ぶ
  tvs: part({ name: 'ESD 保護（双方向）PESD5V0S1BB SOD-523', kind: 'diode', value: 'PESD5V0S1BB', manufacturer: 'TECH PUBLIC', mpn: 'PESD5V0S1BB', lcsc: 'C2936981', verified: true, jlcType: 'extended', package: 'SOD-523', footprint: 'D_SOD-523' }),
  jack: part({ name: '3.5mm ステレオジャック（挿入検出つき）SJ-3524-SMT', kind: 'connector', value: 'SJ-3524-SMT', manufacturer: 'CUI', mpn: 'SJ-3524-SMT-TR', lcsc: 'C20182907', verified: true, jlcType: 'extended', package: 'SMD', footprint: 'Jack_3.5mm_CUI_SJ-3524-SMT_Horizontal',
    symbol: { kind: 'connector', pinCount: 4, pinNames: names(['T(L)', 'R(R)', 'S(GND)', 'TN(検出)']) }, pinMap: { 1: ['T'], 2: ['R'], 3: ['S'], 4: ['TN'] } }),
  spk: part({ name: 'スピーカー端子 JST PH 2P 横向き', kind: 'connector', value: 'S2B-PH-K-S', manufacturer: 'JST', mpn: 'S2B-PH-K-S(LF)(SN)', lcsc: 'C173752', verified: true, jlcType: 'extended', package: 'THT,P=2mm', footprint: 'JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal', symbol: { kind: 'connector', pinCount: 2, pinNames: '+,-' } }),
  // 書き込みモード用のテストパッド（銅のパッドだけ。部品は載せないので BOM・CPL から外す＝DNP）
  tp: part({ name: 'テストパッド 1.0mm 角', kind: 'connector', value: 'TP', package: 'pad', footprint: 'TestPoint_Pad_1.0x1.0mm', symbol: { kind: 'connector', pinCount: 1, pinNames: 'TP' } }),
};
// 受動部品（0402。LCSC 品番は確認できたものだけ入れる）
const R = (v, lcsc = '', mpn = '', jlcType = 'basic') => part({ name: `抵抗 ${v} 0402`, kind: 'resistor', value: v, package: '0402', footprint: 'R_0402', lcsc, mpn, verified: !!lcsc, jlcType: lcsc ? jlcType : 'unknown' });
const C = (v, lcsc = '', mpn = '', pkg = '0402') => part({ name: `セラコン ${v} ${pkg}`, kind: 'capacitor', value: v, package: pkg, footprint: `C_${pkg}`, lcsc, mpn, verified: !!lcsc, jlcType: ['C1525', 'C52923', 'C12530', 'C1523', 'C1531', 'C1554', 'C19702', 'C19666'].includes(lcsc) ? 'basic' : 'unknown' });
const PV = {
  c100n: C('100n', 'C1525', 'CL05B104KO5NNNC'), c1u: C('1u', 'C52923', 'CL05A105KA5NQNC'), c10u: C('10u', 'C19702', 'CL10A106KP8NNNC', '0603'),
  c2u2: C('2.2u', 'C12530', 'CL05A225MQ5NSNC'), c1n: C('1n', 'C1523', '0402B102K500NT'), c2n2: C('2.2n', 'C1531', '0402B222K500NT'), c20p: C('20p', 'C1554', '0402CG200J500NT'), c4u7: C('4.7u', 'C19666', 'CL10A475KO8NNNC', '0603'),
  r5k1: R('5.1k', 'C25905', '0402WGF5101TCE'), r10k: R('10k', 'C25744', '0402WGF1002TCE'), r100k: R('100k', 'C25741', '0402WGF1003TCE'), r470: R('470', 'C25117', '0402WGF4700TCE'), r33: R('33', 'C25105', '0402WGF330JTCE'), r1k: R('1k', 'C11702', '0402WGF1001TCE'), r390k: R('390k', 'C25782', '0402WGF3903TCE', 'extended'),
  // 3.3V の GPIO から 1kΩ で点ける。緑（Vf 約 3.1V）では電流がほとんど流れないので赤（Vf 約 2V、約 1.3mA）
  led: part({ name: 'LED 赤 0603 KT-0603R', kind: 'led', value: 'Red', manufacturer: 'Hubei KENTO Elec', mpn: 'KT-0603R', lcsc: 'C2286', verified: true, jlcType: 'basic', package: '0603', footprint: 'LED_0603' }),
};

// ---------------- 回路（部品と接続） ----------------
const parts = [];
const add = (ref, p, value) => parts.push({ ref, kind: p.kind, value: value || p.value, package: p.package, lcsc: p.lcsc || '', mpn: p.mpn || '', description: '', pins: [], _part: p });
add('J1', P.usbc); add('U1', P.esd); add('U2', P.ldo); add('U3', P.ldo); add('U4', P.esp); add('Y1', P.xtal);
add('U5', P.dac); add('U6', P.hp); add('U7', P.amp); add('U8', P.amp); add('J2', P.jack); add('J3', P.spk); add('J4', P.spk); add('TP1', P.tp); add('TP2', P.tp);
const caps = {
  C1: PV.c1u, C2: PV.c10u, C3: PV.c1u, C4: PV.c10u, C5: PV.c1u, C6: PV.c10u, // 電源
  C7: PV.c100n, C8: PV.c100n, C9: PV.c100n, C10: PV.c100n, C11: PV.c1u, C12: PV.c10u, C13: PV.c1u, C14: PV.c20p, C15: PV.c20p, // ESP32
  C16: PV.c100n, C17: PV.c10u, C18: PV.c100n, C19: PV.c10u, C20: PV.c100n, C21: PV.c2u2, C22: PV.c2u2, C23: PV.c100n, C24: PV.c2n2, C25: PV.c2n2, // DAC
  C26: PV.c1u, C27: PV.c1u, C28: PV.c1u, C29: PV.c1u, C30: PV.c2u2, C31: PV.c2u2, C32: PV.c100n, // HP アンプ
  C33: PV.c10u, C34: PV.c100n, C35: PV.c10u, C36: PV.c100n, // スピーカーアンプ
};
caps.C37 = PV.c1n; caps.C38 = PV.c1u; caps.C39 = PV.c100n; caps.C40 = PV.c4u7;
for (const [k, v] of Object.entries(caps)) add(k, v);
const res = {
  R1: PV.r5k1, R2: PV.r5k1, R3: PV.r10k, R4: PV.r10k, R5: PV.r470, R6: PV.r470, R7: PV.r100k, R8: PV.r100k, R9: PV.r10k,
  R10: PV.r390k, R11: PV.r1k,
};
res.R12 = PV.r100k; res.R13 = PV.r100k; res.R14 = PV.r100k; res.R15 = PV.r100k;
for (const [k, v] of Object.entries(res)) add(k, v);
add('D1', PV.led);
add('U9', P.sw); add('Q1', P.pfet); add('D2', P.tvs); add('D3', P.tvs);

const nets = {
  // 電源の入口（突入電流の制限と、挿した瞬間の過電圧への耐性）: P チャネル MOSFET Q1（AO3401A、耐圧 30V）を VBUS と +5V_SYS の間に
  //   C40 4.7µF（ゲート–ソース）: 挿した瞬間はゲートがソース（VBUS）に追従し、Q1 は切れたまま（Vgs ≈ −5V×0.1/4.8 = −0.1V）
  //   R15 100kΩ（ゲート–GND）: ゲートをゆっくり下げる（約 0.15 秒で閾値）
  //   C39 100nF（ゲート–ドレイン）: ミラー容量で出力の上がる速さを決める ≈ (5V−1.8V)/100kΩ/100nF ≈ 0.32V/ms（約 16ms で 5V）
  //   後ろの容量 約 57µF に流れる電流 ≈ 57µF×0.32V/ms ≈ 18mA。オンした後のゲートは 0V（Vgs = −5V、60mΩ 以下）で、待機電流なし
  // VBUS に直接つなぐ容量は C1・C38 の 1µF×2（C40 は 100kΩ を通して充電されるので突入電流にならない）
  // ON は VBUS から 100kΩ・1µF で約 22ms 遅らせる（VIN より先に ON が上がると立ち上がりが制御されないため）
  VBUS: ['J1.2', 'U1.5', 'C1.1', 'C38.1', 'Q1.2', 'C40.1'],
  SYS_G: ['Q1.1', 'C40.2', 'R15.1', 'C39.1'],
  '+5V_SYS': ['Q1.3', 'C39.2', 'U2.1', 'U2.3', 'C3.1', 'U3.1', 'U3.3', 'C5.1', 'U9.1'],
  '+5V_SPK': ['U9.6', 'U9.5', 'U7.4', 'R10.1', 'C2.1', 'U7.7', 'U7.8', 'U8.7', 'U8.8', 'C33.1', 'C34.1', 'C35.1', 'C36.1', 'R12.1', 'R13.1'],
  SPK_PWR: ['U4.48', 'U9.3', 'R14.1'], SW_CT: ['U9.4', 'C37.1'],
  // ゲイン 3dB（GAIN_SLOT を 100kΩ で VDD へ）。最大音量でも 8Ω で約 0.4W/ch に抑え、USB の 500mA に収める
  GAIN_L: ['U7.2', 'R12.2'], GAIN_R: ['U8.2', 'R13.2'],
  GND: ['J1.1', 'J1.9', 'U1.2', 'R1.2', 'R2.2', 'C1.2', 'C2.2', 'U2.2', 'C3.2', 'C4.2', 'U3.2', 'C5.2', 'C6.2',
    'U4.57', 'C7.2', 'C8.2', 'C9.2', 'C10.2', 'C11.2', 'C12.2', 'C13.2', 'C14.2', 'C15.2', 'Y1.2', 'Y1.4', 'TP2.1',
    'U5.3', 'U5.9', 'U5.19', 'U5.10', 'U5.11', 'U5.12', 'U5.16', 'C16.2', 'C17.2', 'C18.2', 'C19.2', 'C20.2', 'C22.2', 'C23.2', 'C24.2', 'C25.2', 'R7.2',
    'U6.2', 'U6.3', 'U6.6', 'U6.7', 'U6.10', 'U6.15', 'U6.17', 'C29.2', 'C30.2', 'C31.2', 'C32.2', 'J2.3',
    'U7.3', 'U7.11', 'U7.15', 'U7.17', 'U8.3', 'U8.11', 'U8.15', 'U8.17', 'C33.2', 'C34.2', 'C35.2', 'C36.2', 'D1.1',
    'U9.2', 'C37.2', 'C38.2', 'R14.2', 'D2.2', 'D3.2', 'R15.2'],
  '+3V3': ['U2.5', 'C4.1', 'U4.2', 'U4.3', 'U4.20', 'U4.46', 'U4.55', 'U4.56', 'C7.1', 'C8.1', 'C9.1', 'C10.1', 'C12.1', 'R3.1', 'R4.1', 'U5.20', 'C16.1', 'C17.1', 'R8.1'],
  '+3V3A': ['U3.5', 'C6.1', 'U5.1', 'U5.8', 'C18.1', 'C19.1', 'C20.1', 'U6.14', 'C31.1', 'C32.1', 'U6.13'],
  // CC の電圧を ESP32 の ADC（GPIO1/2）で読み、相手が 1.5A/3A を出せるかを判定（出せないときは音量の上限を下げる）
  CC1: ['J1.3', 'R1.1', 'U4.6'], CC2: ['J1.6', 'R2.1', 'U4.7'],
  USB_DP: ['J1.4', 'U1.3', 'U1.4', 'U4.26'], USB_DN: ['J1.5', 'U1.1', 'U1.6', 'U4.25'],
  CHIP_PU: ['U4.4', 'R3.2', 'C13.1'], BOOT: ['U4.5', 'R4.2', 'TP1.1'], VDD_SPI: ['U4.29', 'C11.1'],
  XTAL_P: ['U4.54', 'Y1.1', 'C14.1'], XTAL_N: ['U4.53', 'Y1.3', 'C15.1'],
  // I2S（配線は数 cm なので直列抵抗は省く）
  // I2S は 1 系統（I2S0）を、ESP32-S3 の GPIO マトリクスで 3 組のピンに同時に出す（1 つの出力を複数の GPIO に割り当てられる）
  //   右辺 → DAC、上辺（GPIO39/40/41）→ 左スピーカーアンプ U7、下辺（GPIO16/17/18）→ 右スピーカーアンプ U8
  //   （1 組を DAC と 2 つのアンプに配ると、片面実装では DAC のまわりを抜ける配線が通らない）
  I2S_BCLK: ['U4.40', 'U5.13'], I2S_LRCK: ['U4.41', 'U5.15'], I2S_DATA: ['U4.42', 'U5.14'],
  AMPL_BCLK: ['U4.44', 'U7.16'], AMPL_LRCK: ['U4.45', 'U7.14'], AMPL_DATA: ['U4.47', 'U7.1'],
  AMPR_BCLK: ['U4.22', 'U8.16'], AMPR_LRCK: ['U4.23', 'U8.14'], AMPR_DATA: ['U4.24', 'U8.1'],
  DAC_XSMT: ['U4.39', 'U5.17', 'R7.1'],
  // スピーカーアンプの左右: 左（U7）は SD_MODE を電源（+5V_SPK）に直結、右（U8）は 390kΩ で電源へ
  // （右チャンネルは SD_MODE が 0.77〜1.4V。内部の 100kΩ プルダウンとの分圧で 5V×100/490 = 1.02V。データシートの式 94×5−100 = 370kΩ に最も近い、LCSC で手に入る値）
  SPK_SD_R: ['R10.2', 'U8.4'],
  JACK_DET: ['U4.27', 'R9.1'], JACK_TN: ['R9.2', 'R8.2', 'J2.4'], LED: ['U4.43', 'R11.1'], LED_A: ['R11.2', 'D1.2'],
  // DAC 周り
  DAC_CAPP: ['U5.2', 'C21.1'], DAC_CAPM: ['U5.4', 'C21.2'], DAC_VNEG: ['U5.5', 'C22.1'], DAC_LDOO: ['U5.18', 'C23.1'],
  DAC_OUTL: ['U5.6', 'R5.1'], DAC_OUTR: ['U5.7', 'R6.1'], LINE_L: ['R5.2', 'C24.1', 'C26.1'], LINE_R: ['R6.2', 'C25.1', 'C27.1'],
  HP_INL: ['C26.2', 'U6.1'], HP_INR: ['C27.2', 'U6.4'], HP_CPP: ['U6.11', 'C28.1'], HP_CPN: ['U6.9', 'C28.2'], HP_VSS: ['U6.8', 'C29.1'], HP_VDD: ['U6.12', 'C30.1'],
  HP_L: ['U6.16', 'J2.1', 'D2.1'], HP_R: ['U6.5', 'J2.2', 'D3.1'],
  SPK_LP: ['U7.9', 'J3.1'], SPK_LN: ['U7.10', 'J3.2'], SPK_RP: ['U8.9', 'J4.1'], SPK_RN: ['U8.10', 'J4.2'],
};
// C30 は HPVDD（2.2µF）、C29 は HPVSS、C31 は VDD（2.2µF）、C28 はフライング（1µF）
const spec = {
  title: 'USB-C DAC・ヘッドホン／2ch スピーカーアンプ', summary: 'USB オーディオ（UAC2・32bit）→ ESP32-S3 → I2S → PCM5102A＋TPA6132A2（ヘッドホン）／MAX98357A×2（8Ω スピーカー）',
  requirements: ['入力: USB-C（バスパワー 5V）', '32bit の USB 音声をアナログに変換', '3.5mm ジャック（ヘッドホン）と 2ch スピーカー 8Ω', 'ダンピングファクター 40 以上（出力インピーダンスを低く）', '大きさ: USB メモリ程度'],
  parts, nets: Object.entries(nets).map(([name, pins]) => ({ name, pins })), nc: [],
  notes: [],
};

// ---------------- 回路図・ネットリスト・ERC ----------------
const prj = M.project.createProject('USB DAC アンプ（サンプル）', FIXED_TIME);
const ap = M.ai.applySpec(prj, spec, { now: FIXED_TIME });
// テストパッドは実装しない（BOM・CPL・メタルマスクから外す）
for (const sh of prj.schematic.sheets) for (const c of sh.components) if (/^TP\d/.test(c.ref)) c.props.dnp = true;
const nl = M.netlist.generateNetlist(prj, { now: new Date(FIXED_TIME).toISOString() });
prj.netlist = nl;
const erc = M.erc.runErc(prj);

// ---------------- PCB ----------------
const pcb = M.pcb.ensurePcb(prj);
pcb.settings.layers = 4;
Object.assign(prj.board.fab, { thicknessMm: 1.6, stackup: 'JLC7628', outerCopperOz: 1, innerCopperOz: 0.5, maskColor: 'green', silkColor: 'white', finish: 'ENIG', viaProcess: 'epoxyFilled' });
const resolve = (c) => { const pt = prj.library.parts.find((p) => p.id === c.partId); return (pt && M.parts.partFootprint(pt)) || M.fps.getFootprint(c.footprint); };
M.pcb.importNetlist(pcb, nl, resolve);
const W = 60, H = 26;
M.pcb.setOutlineRect(pcb, W, H);
const toMm = M.pcb.toMm;
const at = (ref, x, y, rot = 0, side = 'top') => { const f = pcb.footprints.find((q) => q.ref === ref); f.x = M.pcb.toNm(x); f.y = M.pcb.toNm(y); f.rot = rot; f.side = side; f.locked = true; return f; };
const body = (id) => M.fps.getFootprint(id).body;
// 主要部品（USB-C は左端、スピーカー端子は右端、3.5mm ジャックは上辺から差し込む向き）
const fabUsb = body('USB_C_HRO_TYPE-C-31-M-12'); // 口は KiCad の +y 側
at('J1', fabUsb.cy + fabUsb.h / 2 - 0.6, H / 2, 90);
at('U1', 10.6, H / 2, 0);
at('U2', 11.5, 3.0, 90); at('U3', 11.5, H - 3.0, 90);
at('U4', 20.5, H / 2, 0);
at('Y1', 17.2, 2.4, 0);
// 書き込み用のテストパッドは裏（部品は載せない）
at('TP1', 4.2, 2.3, 0, 'bottom'); at('TP2', 6.2, 2.3, 0, 'bottom');
// 動作表示の LED は上辺の近く（基板の真ん中は I2S の配線が通る）
at('D1', 24.0, 1.2, 0);
at('U5', 30.5, H / 2, 180);
at('U6', 37.4, H / 2, 180);
// スピーカーアンプはジャックの左の上下の縁に（出力は縁に沿って右端のスピーカー端子へ）
at('U7', 36.5, 3.4, 270); at('U8', 36.5, H - 3.4, 270);
// 3.5mm ジャックは上の長辺から差し込む向き（鼻先は KiCad の -y 側 → 回転 0 で上辺）
const fabJack = body('Jack_3.5mm_CUI_SJ-3524-SMT_Horizontal');
at('J2', 45.2, -(fabJack.cy - fabJack.h / 2) - 0.4, 0).hideRef = true;
// スピーカー端子 L/R は右端に並べ、差し込み口を右に向ける（KiCad の +y が口 → 270°）
const spkFab = body('JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal');
const spkX = W - (spkFab.cy + spkFab.h / 2);
at('J3', spkX, 4.0, 270); at('J4', spkX, H - 4.5, 270); // 位置は 2 本のピンの中心
M.pcb.addText(pcb, spkX - 2.2, 1.2, 'L', 'F.SilkS', 1.0);
M.pcb.addText(pcb, spkX - 2.2, 18.6, 'R', 'F.SilkS', 1.0);

// 受動部品: つながる IC・コネクタのピンの近くの空きに、表に置く（片面実装）
const boxes = [];
const grow = (b, g) => ({ x0: b.x0 - g, y0: b.y0 - g, x1: b.x1 + g, y1: b.y1 + g });
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
for (const f of pcb.footprints.filter((q) => q.locked && q.side === 'top')) boxes.push(M.pcb.fpBox(f));
// IC のピンの外側（引き出してビアを打つ場所）には置かない
for (const f of pcb.footprints.filter((q) => q.locked && /^U/.test(q.ref))) {
  const pads = f.fpDef.pads.filter((p) => p.type === 'smd' && Math.max(p.w, p.h) < 1.2);
  if (pads.length < 8) continue;
  for (const p of pads) { const c = M.pcb.fpToBoard(f, p.x, p.y); const r = Math.max(p.w, p.h) / 2 + 0.9; boxes.push({ x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }); }
}
for (const h of M.pcb.boardHoles(pcb)) { const r = toMm(h.drill) / 2 + 0.3; boxes.push({ x0: toMm(h.x) - r, y0: toMm(h.y) - r, x1: toMm(h.x) + r, y1: toMm(h.y) + r }); }
const padPos = new Map(); // ネット → 主要部品のパッドの位置
for (const p of M.pcb.allPads(pcb)) if (p.inst.locked && p.net && p.net !== 'GND') { const c = M.pcb.fpToBoard(p.inst, p.pad.x, p.pad.y); (padPos.get(p.net) || padPos.set(p.net, []).get(p.net)).push(c); }
// 置く相手を決めてある部品（パスコン・設定用の抵抗・保護素子）
const NEAR = { C37: 'U9', R14: 'U9', C2: 'U9', R12: 'U7', R13: 'U8', C38: 'Q1', C39: 'Q1', C40: 'Q1', R15: 'Q1', C33: 'U7', C34: 'U7', C35: 'U8', C36: 'U8', Q1: 'U1', D2: 'J2', D3: 'J2', R8: 'U5' };
const notFit = [];
// IC・トランジスタ → コンデンサ → 抵抗ほかの順
const rank = (r) => (/^[UQ]\d/.test(r) ? -1 : /^C/.test(r) ? 0 : 1);
const order = pcb.footprints.filter((f) => !f.locked).sort((a, b) => rank(a.ref) - rank(b.ref));
for (const f of order) {
  const myNets = M.pcb.allPads(pcb).filter((p) => p.inst === f && p.net && p.net !== 'GND').map((p) => p.net);
  // 信号のネットがあればそちらのピンの近く（電源のネットはパッドが基板中に散らばるので、目標の重心をずらしてしまう）
  const sigNets = myNets.filter((n) => !M.ai.isPowerNet(n));
  let targets = (sigNets.length ? sigNets : myNets).flatMap((n) => padPos.get(n) || []);
  if (NEAR[f.ref]) {
    const host = pcb.footprints.find((q) => q.ref === NEAR[f.ref]);
    const hp = M.pcb.allPads(pcb).filter((p) => p.inst === host && myNets.includes(p.net)).map((p) => M.pcb.fpToBoard(host, p.pad.x, p.pad.y));
    if (hp.length) targets = hp;
  }
  const t = targets.length ? { x: targets.reduce((s, q) => s + q.x, 0) / targets.length, y: targets.reduce((s, q) => s + q.y, 0) / targets.length } : { x: W / 2, y: H / 2 };
  // 目標から 0.25mm 刻みで外へ探し、最初に空いた所。回転 0 で置けなければ 90
  let best = null;
  for (const rot of [0, 90]) for (let r = 0; r <= 12 && !best; r += 0.25) for (let k = 0, n = Math.max(1, Math.round(r * 8)); k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = Math.round((t.x + r * Math.cos(a)) * 4) / 4, y = Math.round((t.y + r * Math.sin(a)) * 4) / 4;
    f.x = M.pcb.toNm(x); f.y = M.pcb.toNm(y); f.rot = rot; f.side = 'top';
    const b = M.pcb.fpBox(f);
    if (b.x0 < 0.5 || b.y0 < 0.5 || b.x1 > W - 0.5 || b.y1 > H - 0.5) continue;
    if (boxes.some((o) => hit(grow(b, 0.15), o))) continue;
    best = { x, y, rot };
    break;
  }
  if (!best) { notFit.push(f.ref); continue; }
  f.x = M.pcb.toNm(best.x); f.y = M.pcb.toNm(best.y); f.rot = best.rot; f.side = 'top'; f.hideRef = true;
  boxes.push(M.pcb.fpBox(f));
}

// ---------------- 内層 ----------------
// In1 = GND、In2 = 電源（USB の 5V／スピーカー用 5V（上下の帯と右端の縦の帯でひと続き）／3.3V デジタル／3.3V アナログ）
M.pcb.addBoardZone(pcb, 'In1.Cu', 'GND');
const plane = (net, pts) => pcb.zones.push({ id: M.project.newId('z'), layer: 'In2.Cu', net, polygon: pts.map(([x, y]) => ({ x: M.pcb.toNm(x), y: M.pcb.toNm(y) })), clearance: M.pcb.toNm(0.3), minWidth: M.pcb.toNm(0.25), filled: false });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const RX = 44.0;
plane('+5V_SYS', rect(0.5, 0.5, 12.0, H - 0.5));
plane('+5V_SPK', [[12.5, 0.5], [W - 0.5, 0.5], [W - 0.5, H - 0.5], [12.5, H - 0.5], [12.5, H - 5.6], [RX, H - 5.6], [RX, 5.6], [12.5, 5.6]]);
plane('+3V3', rect(12.5, 6.1, 25.6, H - 6.1));
plane('+3V3A', rect(26.1, 6.1, RX - 0.5, H - 6.1));
M.pcb.addBoardZone(pcb, 'B.Cu', 'GND');

// ネットごとの最大電流（検査 →「電流」と同じ設定）
prj.board.current = { tempRiseC: 10, nets: {
  VBUS: 0.5, '+5V_SYS': 0.5, '+5V_SPK': 0.4, GND: 0.5, '+3V3': 0.2, '+3V3A': 0.1,
  SPK_LP: 0.25, SPK_LN: 0.25, SPK_RP: 0.25, SPK_RN: 0.25, HP_L: 0.1, HP_R: 0.1,
} };
const rules = M.drc.drcRules(prj);
M.zonefill.fillAllZones(pcb, rules);

// ---------------- 露出パッドのビア ----------------
// QFN の露出パッド（GND）の中に、ビアを格子状に並べる（放熱と GND。穴埋め・蓋めっき前提）。ほかの電源・GND のパッドは自動配線が面へのビアを打つ
const VIA_D = 0.45, VIA_H = 0.2, CL = 0.22;
pcb.settings.viaDiameter = M.pcb.toNm(VIA_D); pcb.settings.viaDrill = M.pcb.toNm(VIA_H);
let epVias = 0;
for (const p of M.pcb.allPads(pcb)) {
  if (p.pad.type !== 'smd' || p.net !== 'GND' || p.pad.w < 1.5 || p.pad.h < 1.5) continue;
  const n = p.pad.w >= 3.5 ? 3 : 2, pitch = p.pad.w >= 3.5 ? 1.2 : 0.8;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const c = M.pcb.fpToBoard(p.inst, p.pad.x + (i - (n - 1) / 2) * pitch, p.pad.y + (j - (n - 1) / 2) * pitch);
    // 別ネットのパッドから離す（露出パッドの中なので、ふつうは離れている）
    const near = M.pcb.allPads(pcb).some((q) => q.net !== 'GND' && M.pcb.pointInPad(q.inst, q.pad, c.x, c.y, VIA_D / 2 + CL));
    if (near) continue;
    M.pcb.addVia(pcb, c.x, c.y, 'GND'); epVias++;
  }
}

// ---------------- 自動配線 ----------------
// 電源を太め優先で引くと、この大きさでは配線しきれない。電流から求めた幅（最低 0.15mm で 0.6A 相当）で引く
const t0 = Date.now();
const routed = await autoroute(pcb, rules, {
  powerWidth: 0.15, netWidth: (n) => Math.max(netWidthFor(prj, n, 'F.Cu'), netWidthFor(prj, n, 'B.Cu')),
  seed: 2, maxRips: 3000, layers: ['F.Cu', 'B.Cu'], maxNodes: 600000, passes: 10,
});
log('autoroute', routed.routed.length, 'ok', routed.failed.length, 'failed', routed.vias, 'vias', routed.rips, 'rips', ((Date.now() - t0) / 1000).toFixed(1), 's');
// 部品番号をパッドにかからない位置へ。置き場所の無いもの（小さい部品が密集している所）はシルクに出さない
const refd = placeRefdes(pcb);
for (const r of refd.conflicts) pcb.footprints.find((f) => f.ref === r).hideRef = true;

// ---------------- 表の GND ベタとつなぎビア ----------------
// 表の空きに GND のベタ（放熱・帰り道・シールド）。配線のあとに足すので、配線の結果は変わらない
// つなぎビア: LDO・ロードスイッチの GND ピンの近く（熱を内層・裏へ）、裏の信号が電源層の分割をまたぐ所の近く（帰り道）、残りは 3mm 格子
M.pcb.addBoardZone(pcb, 'F.Cu', 'GND');
const F = M.zonefill.fillAllZones(pcb, rules);
const cross = planeSplitCrossings(pcb, rules, { fills: F });
const heat = [];
for (const ref of ['U2', 'U3', 'U9']) {
  const f = pcb.footprints.find((q) => q.ref === ref);
  for (const pd of f.fpDef.pads) if (f.padNets[pd.num] === 'GND') heat.push(M.pcb.fpToBoard(f, pd.x, pd.y));
}
const st = addStitchVias(pcb, rules, { near: [...heat, ...cross], nearRadiusMm: 1.5, pitchMm: 3, fills: F });
M.zonefill.fillAllZones(pcb, rules);

// ---------------- 検査・書き出し ----------------
const drc = M.drc.runDrc(prj, pcb);
const asm = M.asm.buildAssembly(prj, pcb, { boards: 5 });
prj.updatedAt = FIXED_TIME;
const text = M.project.serializeProject(prj);
const by = (r) => r.issues.reduce((m, i) => ((m[`${i.level}:${i.rule}`] = (m[`${i.level}:${i.rule}`] || 0) + 1), m), {});
const report = {
  parts: ap.placed, nets: nl.nets.length, netlistProblems: nl.problems.map((p) => `${p.level}: ${p.message}`),
  erc: { summary: erc.summary, byRule: by(erc) },
  placement: { notFit }, epVias, route: { ok: routed.routed.length, failed: routed.failed, vias: routed.vias, rips: routed.rips },
  stitch: { added: st.added.length, crossings: cross.length },
  drc: { summary: drc.summary, byRule: by(drc), errors: drc.issues.filter((i) => i.level === 'error').map((i) => i.message) },
  bom: asm.bom.length, cpl: asm.cpl.length, asmProblems: asm.problems.map((p) => `${p.level}: ${p.message}`),
};
if (CHECK) {
  const same = fs.readFileSync(OUT, 'utf8') === text;
  if (!same && process.env.DIFF_OUT) fs.writeFileSync(process.env.DIFF_OUT, text);
  console.log(JSON.stringify({ same, drc: drc.summary, erc: erc.summary }));
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, text);
console.log(JSON.stringify(report, null, 1));
