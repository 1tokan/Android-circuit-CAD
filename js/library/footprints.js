// フットプリント定義（シンボルとは独立したデータ）
// 単位: mm、y軸は下向き（KiCad と同じ）。原点は部品の中心（CPL の Mid X/Y に使う）。
// パッド: { num, x, y, w, h, shape: 'rect'|'roundrect'|'circle'|'oval', type: 'smd'|'tht', drill?, slot?, rr? }
// 同じ番号のパッドが複数あってもよい（SOT-223 のタブ、タクトスイッチの4端子など）。
//
// 内蔵フットプリントの寸法（パッド・外形枠・本体・位置決めの穴）は、すべて KiCad 公式ライブラリのデータ（fp-kicad.js。
// tests/tools/kicad-import.mjs で生成）から取り、verified:true とする。ここには名前・説明・パッケージ名だけを書く。
// KiCad 公式に無いもの（半固定抵抗）だけ寸法をここに書き、verified:false（画面・DRC で「未照合」と表示）。

import { generateFootprint } from './pkggen.js';
import { KICAD_FP } from './fp-kicad.js';

const r4 = (v) => Math.round(v * 10000) / 10000;

function finish(fp) {
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

/** KiCad 公式データから作る内蔵フットプリント */
function kfp(id, desc, pkg = '', extra = {}) {
  const k = KICAD_FP[id];
  if (!k) throw new Error(`fp-kicad.js に ${id} がありません（tests/tools/kicad-import.mjs で作り直す）`);
  return finish({
    id, name: id, desc, package: pkg, ...extra,
    pads: k.pads.map((p) => ({ ...p, ...(p.slot ? { slot: { ...p.slot } } : {}) })),
    courtyard: k.courtyard || null, body: k.body || null,
    ...(k.npth ? { npth: k.npth.map((h) => ({ ...h })) } : {}),
    ...(k.alias ? { alias: { ...k.alias } } : {}),
    verified: true, source: `KiCad 公式ライブラリ ${k.kicad}${k.note ? `（${k.note}）` : ''}`,
  });
}
const tht = (num, x, y, size, drill, shape = 'circle') => ({ num: String(num), x, y, w: size, h: size, shape, type: 'tht', drill });

const pad2 = (n) => String(n).padStart(2, '0');
const LIST = [
  kfp('R_0402', 'チップ抵抗 0402(1005)', '0402'), kfp('R_0603', 'チップ抵抗 0603(1608)', '0603'),
  kfp('R_0805', 'チップ抵抗 0805(2012)', '0805'), kfp('R_1206', 'チップ抵抗 1206(3216)', '1206'),
  kfp('C_0402', '積層セラコン 0402', '0402'), kfp('C_0603', '積層セラコン 0603', '0603'),
  kfp('C_0805', '積層セラコン 0805', '0805'), kfp('C_1206', '積層セラコン 1206', '1206'),
  kfp('L_0603', 'チップインダクタ 0603', '0603'), kfp('L_0805', 'チップインダクタ 0805', '0805'),
  // LED・ダイオード: パッド1=カソード（KiCad と同じ）
  kfp('LED_0603', 'チップLED 0603（1=K, 2=A）', '0603', { polarity: true }), kfp('LED_0805', 'チップLED 0805（1=K, 2=A）', '0805', { polarity: true }),
  kfp('D_SOD-123', 'ダイオード SOD-123（1=K, 2=A）', 'SOD-123', { polarity: true }),
  kfp('D_SOD-323', 'ダイオード SOD-323（1=K, 2=A）', 'SOD-323', { polarity: true }),
  kfp('D_SOD-523', 'ダイオード SOD-523（1=K, 2=A）', 'SOD-523', { polarity: true }),
  kfp('D_SMA', 'ダイオード SMA(DO-214AC)（1=K, 2=A）', 'SMA', { polarity: true }),
  kfp('SOT-23', 'SOT-23 3ピン', 'SOT-23'), kfp('SOT-23-5', 'SOT-23-5', 'SOT-23-5'), kfp('SOT-23-6', 'SOT-23-6', 'SOT-23-6'),
  // SOT-223: タブはピン2と同じ番号
  kfp('SOT-223-3_TabPin2', 'SOT-223（タブ=2番）', 'SOT-223'),
  ...[8, 14, 16].map((n) => kfp(`SOIC-${n}`, `SOIC ${n}ピン ピッチ1.27mm`, `SOIC-${n}`)),
  ...[8, 14, 20].map((n) => kfp(`TSSOP-${n}`, `TSSOP ${n}ピン ピッチ0.65mm`, `TSSOP-${n}`)),
  ...[8, 14, 16].map((n) => kfp(`DIP-${n}`, `DIP ${n}ピン 7.62mm幅`, `DIP-${n}`)),
  ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20].map((n) => kfp(`PinHeader_1x${pad2(n)}_P2.54mm`, `ピンヘッダ 1列${n}ピン 2.54mm`, `Header 1x${n}`)),
  ...[2, 3, 4].map((n) => kfp(`JST_PH_B${n}B-PH-K_1x${pad2(n)}_P2.00mm`, `JST PH ${n}ピン トップ実装`, `JST-PH-${n}P`)),
  kfp('JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal', 'JST PH 2ピン 横向き（差し込み口は +y 側）', ''),
  kfp('CP_Elec_5x5.4', 'SMD電解コンデンサ 5x5.4（1=+）', 'SMD,D5xL5.4mm', { polarity: true }),
  kfp('CP_Elec_6.3x5.4', 'SMD電解コンデンサ 6.3x5.4（1=+）', 'SMD,D6.3xL5.4mm', { polarity: true }),
  // タクトスイッチ 6x6 THT: 同番号2端子ずつ（内部で導通）
  kfp('SW_PUSH_6mm', 'タクトスイッチ 6x6mm THT', 'SW-TH_4P-6x6'),
  // QFN・水晶・コネクタ（パッケージ名だけでは形が決まらないので、パッケージ名からは選ばない）
  kfp('QFN-56-1EP_7x7mm_P0.4mm_EP4.0x4.0mm', 'QFN-56 7x7mm ピッチ0.4mm 露出パッド4.0mm角（ESP32-S3 など）', ''),
  kfp('WQFN-16-1EP_3x3mm_P0.5mm_EP1.75x1.75mm', 'WQFN-16 3x3mm 露出パッド1.75mm角（TPA6132A2 など）', ''),
  kfp('TQFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm', 'TQFN-16 3x3mm 露出パッド1.6mm角（MAX98357A など）', ''),
  kfp('Crystal_SMD_3225-4Pin_3.2x2.5mm', '水晶 3225 4ピン', ''),
  kfp('TestPoint_Pad_1.0x1.0mm', 'テストパッド 1.0mm角（部品なし）'),
  kfp('USB_C_HRO_TYPE-C-31-M-12', 'USB Type-C 受け口 16P（HRO TYPE-C-31-M-12。位置決めの穴 2 つつき。部品と一緒に動く）'),
  kfp('Fuse_0805', 'チップヒューズ 0805(2012)', '0805'), kfp('Fuse_1206', 'チップヒューズ 1206(3216)', '1206'),
  kfp('TO-269AA', 'ブリッジダイオード MBS(TO-269AA)（1=~, 2=~, 3=+, 4=-）', 'MBS', { polarity: true }),
  kfp('DIP-4', 'DIP 4ピン 7.62mm幅（フォトカプラ PC817: 1=A, 2=K, 3=E, 4=C）', 'DIP-4', { polarity: true }),
  kfp('Relay_SANYOU_SRD', 'リレー SANYOU SRD（Songle SRD 互換。1=COM, 2・5=コイル, 3=NO, 4=NC）', ''),
  kfp('Buzzer_12x9_5RM7_6', 'ブザー φ12 ピッチ7.6mm THT（1=+）', '', { polarity: true }),
  kfp('Jack_3.5mm_CUI_SJ-3524-SMT_Horizontal', '3.5mm ジャック SMT 横向き（CUI SJ-3524-SMT。位置決めの穴 2 つつき。部品と一緒に動く）'),
  // 半固定抵抗（3端子インライン 2.54mm）。KiCad 公式に同じ形が無いので寸法は自前（3362P は端子が三角配置なので別途要確認）
  finish({ id: 'Trimmer_3P_Inline_P2.54', name: 'Trimmer_3P_Inline_P2.54', desc: '半固定抵抗 3端子インライン 2.54mm（1,3=両端, 2=ワイパ）', package: 'TH-3P', pads: [tht(1, -2.54, 0, 1.8, 1.0, 'rect'), tht(2, 0, 0, 1.8, 1.0), tht(3, 2.54, 0, 1.8, 1.0)], body: { w: 9.5, h: 5 }, source: '汎用（実部品の図面で要確認）' }),
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
