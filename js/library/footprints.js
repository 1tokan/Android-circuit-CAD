// フットプリント定義（シンボルとは独立したデータ）
// 単位: mm、y軸は下向き（KiCad と同じ）。原点は部品の中心（CPL の Mid X/Y に使う）。
// パッド: { num, x, y, w, h, shape: 'rect'|'roundrect'|'circle'|'oval', type: 'smd'|'tht', drill? }
// 同じ番号のパッドが複数あってもよい（SOT-223 のタブ、タクトスイッチの4端子など）。
//
// パッド・外形枠・本体の寸法は、KiCad 公式ライブラリのデータ（fp-kicad.js）があればそれを使い verified:true とする。
// データが無いもの（半固定抵抗など）は自前の値のままで verified:false（画面・DRC で「未照合」と表示）。

import { generateFootprint } from './pkggen.js';
import { KICAD_FP } from './fp-kicad.js';

const smd = (num, x, y, w, h, shape = 'roundrect') => ({ num: String(num), x, y, w, h, shape, type: 'smd' });
const tht = (num, x, y, size, drill, shape = 'circle') => ({ num: String(num), x, y, w: size, h: size, shape, type: 'tht', drill });
const r4 = (v) => Math.round(v * 10000) / 10000;

function finish(fp) {
  const k = KICAD_FP[fp.id];
  if (k) {
    // KiCad 公式データで置き換える（パッド・外形枠・本体）
    fp = { ...fp, pads: k.pads.map((p) => ({ ...p })), courtyard: k.courtyard || fp.courtyard, body: k.body || fp.body, verified: true, source: `KiCad 公式ライブラリ ${k.kicad}` };
  }
  // 外形（コートヤード）が無ければパッドから求めて 0.25mm 広げる
  if (!fp.courtyard) {
    const xs = [], ys = [];
    for (const p of fp.pads) { xs.push(p.x - p.w / 2, p.x + p.w / 2); ys.push(p.y - p.h / 2, p.y + p.h / 2); }
    if (fp.body) { xs.push(-fp.body.w / 2, fp.body.w / 2); ys.push(-fp.body.h / 2, fp.body.h / 2); }
    fp.courtyard = { x0: r4(Math.min(...xs) - 0.25), y0: r4(Math.min(...ys) - 0.25), x1: r4(Math.max(...xs) + 0.25), y1: r4(Math.max(...ys) + 0.25) };
  }
  fp.pads = fp.pads.map((p) => ({ ...p, x: r4(p.x), y: r4(p.y) }));
  fp.verified = fp.verified ?? false;
  return Object.freeze(fp);
}

// ---- 2端子チップ（抵抗・コンデンサ・インダクタ・LED）: [パッド中心x, パッド幅, パッド高さ, 本体w, 本体h] ----
const CHIP = {
  '0402': [0.51, 0.54, 0.64, 1.0, 0.5],
  '0603': [0.825, 0.8, 0.95, 1.6, 0.8],
  '0805': [0.9125, 1.025, 1.4, 2.0, 1.25],
  '1206': [1.4625, 1.125, 1.75, 3.2, 1.6],
};
function chip(id, size, desc, polarity = false) {
  const [x, w, h, bw, bh] = CHIP[size];
  return finish({ id, name: id, desc, package: size, pads: [smd(1, -x, 0, w, h), smd(2, x, 0, w, h)], body: { w: bw, h: bh }, polarity, source: `IPC-7351 nominal / KiCad ${size}` });
}

function soic(n, pitch = 1.27, rowX = 2.475, padW = 1.95, padH = 0.6, bodyW = 3.9, bodyH = null, prefix = 'SOIC') {
  const half = n / 2;
  const pads = [];
  const y0 = -((half - 1) * pitch) / 2;
  for (let i = 0; i < half; i++) {
    pads.push(smd(i + 1, -rowX, y0 + i * pitch, padW, padH));
    pads.push(smd(n - i, rowX, y0 + i * pitch, padW, padH));
  }
  pads.sort((a, b) => Number(a.num) - Number(b.num));
  const id = `${prefix}-${n}`;
  return finish({ id, name: id, desc: `${prefix} ${n}ピン ピッチ${pitch}mm`, package: id, pads, body: { w: bodyW, h: bodyH ?? (half * pitch + 0.8) }, pin1: true, source: 'JEDEC MS-012 / KiCad SOIC' });
}

function dip(n) {
  const half = n / 2;
  const pads = [];
  const y0 = -((half - 1) * 2.54) / 2;
  for (let i = 0; i < half; i++) {
    pads.push(tht(i + 1, -3.81, y0 + i * 2.54, 1.6, 0.8, i === 0 ? 'rect' : 'circle'));
    pads.push(tht(n - i, 3.81, y0 + i * 2.54, 1.6, 0.8));
  }
  pads.sort((a, b) => Number(a.num) - Number(b.num));
  return finish({ id: `DIP-${n}`, name: `DIP-${n}`, desc: `DIP ${n}ピン 7.62mm幅`, package: `DIP-${n}`, pads, body: { w: 6.35, h: half * 2.54 + 0.5 }, pin1: true, source: 'KiCad DIP-N_W7.62mm' });
}

function pinHeader(n, pitch = 2.54) {
  const pads = [];
  const y0 = -((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(i + 1, 0, y0 + i * pitch, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
  const id = `PinHeader_1x${String(n).padStart(2, '0')}_P2.54mm`;
  return finish({ id, name: id, desc: `ピンヘッダ 1列${n}ピン 2.54mm`, package: `Header 1x${n}`, pads, body: { w: 2.54, h: n * 2.54 }, pin1: true, source: 'KiCad PinHeader_1xN_P2.54mm_Vertical（原点は中心に移動）' });
}

function jstPH(n) {
  const pads = [];
  const x0 = -((n - 1) * 2.0) / 2;
  for (let i = 0; i < n; i++) pads.push({ ...tht(i + 1, x0 + i * 2.0, 0, 1.2, 0.75, i === 0 ? 'rect' : 'oval'), h: 1.75 });
  const id = `JST_PH_B${n}B-PH-K_1x${String(n).padStart(2, '0')}_P2.00mm`;
  return finish({ id, name: id, desc: `JST PH ${n}ピン トップ実装`, package: `JST-PH-${n}P`, pads, body: { w: (n - 1) * 2 + 3.9, h: 4.5 }, pin1: true, source: 'JST PH 図面 / KiCad JST_PH_B*B-PH-K' });
}

const LIST = [
  chip('R_0402', '0402', 'チップ抵抗 0402(1005)'), chip('R_0603', '0603', 'チップ抵抗 0603(1608)'),
  chip('R_0805', '0805', 'チップ抵抗 0805(2012)'), chip('R_1206', '1206', 'チップ抵抗 1206(3216)'),
  chip('C_0402', '0402', '積層セラコン 0402'), chip('C_0603', '0603', '積層セラコン 0603'),
  chip('C_0805', '0805', '積層セラコン 0805'), chip('C_1206', '1206', '積層セラコン 1206'),
  chip('L_0603', '0603', 'チップインダクタ 0603'), chip('L_0805', '0805', 'チップインダクタ 0805'),
  // LED: パッド1=カソード（KiCad と同じ）
  chip('LED_0603', '0603', 'チップLED 0603（1=K, 2=A）', true), chip('LED_0805', '0805', 'チップLED 0805（1=K, 2=A）', true),
  finish({ id: 'D_SOD-123', name: 'D_SOD-123', desc: 'ダイオード SOD-123（1=K, 2=A）', package: 'SOD-123', pads: [smd(1, -1.65, 0, 0.9, 1.2), smd(2, 1.65, 0, 0.9, 1.2)], body: { w: 2.7, h: 1.6 }, polarity: true, source: 'KiCad D_SOD-123' }),
  finish({ id: 'D_SOD-323', name: 'D_SOD-323', desc: 'ダイオード SOD-323（1=K, 2=A）', package: 'SOD-323', pads: [smd(1, -1.05, 0, 0.6, 0.45), smd(2, 1.05, 0, 0.6, 0.45)], body: { w: 1.7, h: 1.25 }, polarity: true, source: 'KiCad D_SOD-323' }),
  finish({ id: 'D_SMA', name: 'D_SMA', desc: 'ダイオード SMA(DO-214AC)（1=K, 2=A）', package: 'SMA', pads: [smd(1, -2.0, 0, 1.5, 1.7), smd(2, 2.0, 0, 1.5, 1.7)], body: { w: 4.3, h: 2.6 }, polarity: true, source: 'KiCad D_SMA' }),
  finish({ id: 'SOT-23', name: 'SOT-23', desc: 'SOT-23 3ピン', package: 'SOT-23', pads: [smd(1, -0.9375, -0.95, 1.475, 0.6), smd(2, -0.9375, 0.95, 1.475, 0.6), smd(3, 0.9375, 0, 1.475, 0.6)], body: { w: 1.3, h: 2.9 }, pin1: true, source: 'KiCad SOT-23' }),
  finish({ id: 'SOT-23-5', name: 'SOT-23-5', desc: 'SOT-23-5', package: 'SOT-23-5', pads: [smd(1, -1.1375, -0.95, 1.325, 0.6), smd(2, -1.1375, 0, 1.325, 0.6), smd(3, -1.1375, 0.95, 1.325, 0.6), smd(4, 1.1375, 0.95, 1.325, 0.6), smd(5, 1.1375, -0.95, 1.325, 0.6)], body: { w: 1.6, h: 2.9 }, pin1: true, source: 'KiCad SOT-23-5' }),
  // SOT-223: タブはピン2と同じ番号（KiCad SOT-223-3_TabPin2）
  finish({ id: 'SOT-223-3_TabPin2', name: 'SOT-223-3_TabPin2', desc: 'SOT-223（タブ=2番）', package: 'SOT-223', pads: [smd(1, -3.15, -2.3, 2.0, 1.5), smd(2, -3.15, 0, 2.0, 1.5), smd(3, -3.15, 2.3, 2.0, 1.5), smd(2, 3.15, 0, 2.0, 3.8)], body: { w: 3.5, h: 6.5 }, pin1: true, source: 'KiCad SOT-223-3_TabPin2' }),
  soic(8), soic(14), soic(16),
  soic(8, 0.65, 2.8625, 1.525, 0.4, 4.4, 3.0, 'TSSOP'), soic(14, 0.65, 2.8625, 1.525, 0.4, 4.4, 5.0, 'TSSOP'), soic(20, 0.65, 2.8625, 1.525, 0.4, 4.4, 6.5, 'TSSOP'),
  dip(8), dip(14), dip(16),
  ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20].map((n) => pinHeader(n)), // map(pinHeader) だと添字がピッチに入るので不可
  ...[2, 3, 4].map((n) => jstPH(n)),
  finish({ id: 'CP_Elec_5x5.4', name: 'CP_Elec_5x5.4', desc: 'SMD電解コンデンサ 5x5.4（1=+）', package: 'SMD,D5xL5.4mm', pads: [smd(1, -2.2, 0, 2.8, 1.6), smd(2, 2.2, 0, 2.8, 1.6)], body: { w: 5.3, h: 5.3 }, polarity: true, source: 'KiCad CP_Elec_5x5.4' }),
  finish({ id: 'CP_Elec_6.3x5.4', name: 'CP_Elec_6.3x5.4', desc: 'SMD電解コンデンサ 6.3x5.4（1=+）', package: 'SMD,D6.3xL5.4mm', pads: [smd(1, -2.7, 0, 3.3, 1.6), smd(2, 2.7, 0, 3.3, 1.6)], body: { w: 6.6, h: 6.6 }, polarity: true, source: 'KiCad CP_Elec_6.3x5.4' }),
  // タクトスイッチ 6x6 THT: 同番号2端子ずつ（内部で導通）
  finish({ id: 'SW_PUSH_6mm', name: 'SW_PUSH_6mm', desc: 'タクトスイッチ 6x6mm THT', package: 'SW-TH_4P-6x6', pads: [tht(1, -3.25, -2.25, 2.0, 1.0), tht(1, 3.25, -2.25, 2.0, 1.0), tht(2, -3.25, 2.25, 2.0, 1.0), tht(2, 3.25, 2.25, 2.0, 1.0)], body: { w: 6, h: 6 }, source: 'KiCad SW_PUSH_6mm（原点は中心に移動）' }),
  // 半固定抵抗（3端子インライン 2.54mm）※ 3362P は端子が三角配置なので別途要確認
  finish({ id: 'Trimmer_3P_Inline_P2.54', name: 'Trimmer_3P_Inline_P2.54', desc: '半固定抵抗 3端子インライン 2.54mm（1,3=両端, 2=ワイパ）', package: 'TH-3P', pads: [tht(1, -2.54, 0, 1.8, 1.0, 'rect'), tht(2, 0, 0, 1.8, 1.0), tht(3, 2.54, 0, 1.8, 1.0)], body: { w: 9.5, h: 5 }, pin1: true, source: '汎用（実部品の図面で要確認）' }),
];

const MAP = new Map(LIST.map((f) => [f.id, f]));

// 旧い仮のフットプリント名 → 実体のID
const ALIASES = {
  SOIC8: 'SOIC-8', 'SOIC-8': 'SOIC-8', SOT23: 'SOT-23', 'SOT-223': 'SOT-223-3_TabPin2',
  SW_SPST_6x6: 'SW_PUSH_6mm', Potentiometer_3362P: 'Trimmer_3P_Inline_P2.54', BatteryHolder: 'JST_PH_B2B-PH-K_1x02_P2.00mm',
  'PinHeader_1x02_P2.54mm': 'PinHeader_1x02_P2.54mm',
};

export function listFootprints() { return LIST; }

/** ID（または別名）から定義を返す。部品にインライン定義があればそれを優先 */
const GEN = new Map();
export function getFootprint(idOrDef) {
  if (!idOrDef) return null;
  if (typeof idOrDef === 'object') return normalizeFootprint(idOrDef);
  if (idOrDef.startsWith('PKG:')) {
    // パッケージ名から自動生成したフットプリント（"PKG:<種別>:<パッケージ名>"）
    if (!GEN.has(idOrDef)) {
      const m = idOrDef.match(/^PKG:([^:]*):(.+)$/);
      GEN.set(idOrDef, m ? generateFootprint(m[1], m[2]) : null);
    }
    return GEN.get(idOrDef);
  }
  return MAP.get(idOrDef) || MAP.get(ALIASES[idOrDef]) || null;
}

/** 汎用ICのピン数からフットプリント名を推定（SOIC-8 / TSSOP-14 / DIP-16 など） */
export function resolveFootprintId(id) {
  const f = getFootprint(id);
  return f ? f.id : null;
}

/** パッド番号の一覧（重複を除き自然順） */
export function padNumbers(fp) {
  return [...new Set(fp.pads.map((p) => p.num))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** ユーザー定義（JSON取込）フットプリントの検証と整形。不正なら例外 */
export function normalizeFootprint(def) {
  if (!def || typeof def !== 'object') throw new Error('フットプリント定義がオブジェクトではありません');
  if (!def.id || typeof def.id !== 'string') throw new Error('フットプリントに id がありません');
  if (!Array.isArray(def.pads) || !def.pads.length) throw new Error(`${def.id}: pads がありません`);
  const pads = def.pads.map((p, i) => {
    const n = { num: String(p.num ?? ''), x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h ?? p.w), shape: p.shape || 'roundrect', type: p.type || (p.drill ? 'tht' : 'smd') };
    if (!n.num) throw new Error(`${def.id}: ${i + 1}番目のパッドに番号がありません`);
    for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(n[k])) throw new Error(`${def.id}: パッド${n.num} の ${k} が数値ではありません`);
    if (n.w <= 0 || n.h <= 0) throw new Error(`${def.id}: パッド${n.num} の寸法が0以下です`);
    if (n.type === 'tht') {
      if (p.slot) {
        // 長穴: slot = { w, h }（パッドの向きでの外形）。drill は短い方
        const sw = Number(p.slot.w), sh = Number(p.slot.h);
        if (!(sw > 0 && sh > 0) || sw >= n.w || sh >= n.h) throw new Error(`${def.id}: パッド${n.num} の長穴の寸法が不正です（パッドより小さく）`);
        n.slot = { w: sw, h: sh };
        n.drill = Math.min(sw, sh);
      } else {
        n.drill = Number(p.drill);
        if (!(n.drill > 0) || n.drill >= Math.min(n.w, n.h)) throw new Error(`${def.id}: パッド${n.num} の穴径が不正です`);
      }
    }
    if (!['rect', 'roundrect', 'circle', 'oval'].includes(n.shape)) throw new Error(`${def.id}: パッド${n.num} の形状 ${n.shape} は未対応です`);
    return n;
  });
  return finish({ ...def, name: def.name || def.id, pads, courtyard: def.courtyard || null, verified: !!def.verified, source: def.source || 'ユーザー定義' });
}
