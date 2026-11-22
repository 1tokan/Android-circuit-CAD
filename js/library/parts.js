// 電子部品ライブラリ（部品データのスキーマ・検証・検索・ピン↔パッド対応）
//
// 部品データ（JSON）:
// {
//   id, name, kind(回路図シンボル種別), manufacturer, mpn, lcsc, description, package,
//   specs: { 抵抗値: '10k', 許容差: '1%', ... }   … 電気的仕様（自由なキーと値）
//   symbol: { kind, pinCount?, pinNames? }          … 回路図シンボル（symbols.js の種別）
//   footprint: 'R_0805' | {インライン定義}          … フットプリント（シンボルとは別データ）
//   pinMap: { '<シンボルのピン番号>': ['<パッド番号>', ...] }  … 省略時は同じ番号どうし
//   datasheet, jlc: { type: 'basic'|'preferred'|'extended'|'unknown', assembly: true|false|null },
//   price: [{ qty, usd }], stock, updatedAt, lcscVerified, source
// }

import { getSymbol, kindInfo } from '../schematic/symbols.js';
import { getFootprint, padNumbers } from './footprints.js';

export const JLC_TYPES = { basic: 'Basic', preferred: 'Preferred', extended: 'Extended', unknown: '不明' };

export class PartFormatError extends Error {
  constructor(m) { super(m); this.name = 'PartFormatError'; }
}

const LCSC_RE = /^C\d{1,9}$/;

export function normalizeLcsc(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return '';
  return /^\d+$/.test(s) ? `C${s}` : s;
}

export function lcscUrl(lcsc) {
  return LCSC_RE.test(lcsc) ? `https://www.lcsc.com/product-detail/${lcsc}.html` : null;
}
export function jlcUrl(lcsc) {
  return LCSC_RE.test(lcsc) ? `https://jlcpcb.com/partdetail/${lcsc}` : null;
}

let seq = 0;
export function partId(p) {
  if (p.lcsc) return `lcsc:${p.lcsc}`;
  if (p.mpn) return `mpn:${(p.manufacturer || '').trim()}:${p.mpn.trim()}`;
  return `user:${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** 部品データの検証と整形。不正なら PartFormatError */
export function normalizePart(raw) {
  if (!raw || typeof raw !== 'object') throw new PartFormatError('部品データがオブジェクトではありません');
  const lcsc = normalizeLcsc(raw.lcsc);
  if (lcsc && !LCSC_RE.test(lcsc)) throw new PartFormatError(`LCSC品番の形式が不正です: ${raw.lcsc}`);
  const kind = raw.symbol?.kind || raw.kind;
  if (!kind || !kindInfo(kind) || kindInfo(kind).power) throw new PartFormatError(`シンボル種別が不正です: ${kind}`);
  const p = {
    id: '',
    name: String(raw.name || raw.mpn || raw.description || '').trim().slice(0, 200),
    kind,
    manufacturer: String(raw.manufacturer || '').trim(),
    mpn: String(raw.mpn || '').trim(),
    lcsc,
    description: String(raw.description || '').trim(),
    package: String(raw.package || '').trim(),
    value: String(raw.value || '').trim(),
    specs: raw.specs && typeof raw.specs === 'object' ? Object.fromEntries(Object.entries(raw.specs).map(([k, v]) => [String(k), String(v)])) : {},
    symbol: { kind, ...(raw.symbol?.pinCount ? { pinCount: Number(raw.symbol.pinCount) } : {}), ...(raw.symbol?.pinNames ? { pinNames: String(raw.symbol.pinNames) } : {}) },
    footprint: raw.footprint ?? '',
    pinMap: raw.pinMap && typeof raw.pinMap === 'object' ? Object.fromEntries(Object.entries(raw.pinMap).map(([k, v]) => [String(k), (Array.isArray(v) ? v : [v]).map(String)])) : null,
    datasheet: /^https?:\/\//.test(String(raw.datasheet || '')) ? String(raw.datasheet) : '',
    jlc: { type: JLC_TYPES[raw.jlc?.type] ? raw.jlc.type : 'unknown', assembly: raw.jlc?.assembly ?? null },
    price: Array.isArray(raw.price) ? raw.price.filter((b) => Number.isFinite(Number(b.qty)) && Number.isFinite(Number(b.usd))).map((b) => ({ qty: Number(b.qty), usd: Number(b.usd) })) : [],
    stock: Number.isFinite(Number(raw.stock)) && raw.stock !== '' && raw.stock !== null ? Number(raw.stock) : null,
    updatedAt: raw.updatedAt || null,
    lcscVerified: !!raw.lcscVerified,
    source: raw.source || 'user',
  };
  if (!p.name) throw new PartFormatError('部品名称がありません');
  if (typeof p.footprint === 'object' && p.footprint) getFootprint(p.footprint); // 検証（不正なら例外）
  p.id = raw.id || partId(p);
  return p;
}

// ---- シンボル・フットプリント・ピン対応 ----

/** 部品が使うシンボル（ICとコネクタはピン数・ピン名を反映） */
export function partSymbol(part) {
  return getSymbol({ kind: part.kind, props: { pinCount: part.symbol?.pinCount, pinNames: part.symbol?.pinNames } });
}

/**
 * ピン→パッド対応。優先順: 部品データの pinMap → 同じ番号のパッド。
 * pinMap で空配列を明示したピンは「未使用ピン（パッドなし）」として nc に入れる。
 * @returns {{ map: Object<string,string[]>, nc: Set<string> }}
 */
export function effectivePinMap(sym, fp, pinMap) {
  const map = {};
  const nc = new Set();
  const pads = new Set(fp ? padNumbers(fp) : []);
  for (const pin of sym.pins) {
    if (pinMap && Object.prototype.hasOwnProperty.call(pinMap, pin.num)) {
      map[pin.num] = [...pinMap[pin.num]];
      if (!map[pin.num].length) nc.add(pin.num);
    } else map[pin.num] = pads.has(pin.num) ? [pin.num] : [];
  }
  // 同番号の重複パッド（SOT-223 のタブ等）はパッド番号が同じなので自動的に含まれる
  return { map, nc };
}

/**
 * ピン↔パッド対応の検査
 * errors: シンボルのピンにパッドが無い（未使用指定を除く）/ 存在しないパッド番号 / 1つのパッドに複数ピン
 * warnings: どのピンにも割り当てられていないパッド、未使用指定のピン
 */
export function checkPinMap(sym, fp, { map, nc = new Set() }) {
  const errors = [], warnings = [];
  if (!fp) return { errors: ['フットプリントが未設定、または見つかりません'], warnings };
  const pads = padNumbers(fp);
  const used = new Map();
  for (const pin of sym.pins) {
    const list = map[pin.num] || [];
    if (!list.length) {
      if (nc.has(pin.num)) warnings.push(`ピン${pin.num}${pin.name ? `(${pin.name})` : ''} はパッドなし（未使用ピン指定）`);
      else errors.push(`ピン${pin.num}${pin.name ? `(${pin.name})` : ''} に対応するパッドがありません`);
    }
    for (const pad of list) {
      if (!pads.includes(pad)) errors.push(`ピン${pin.num} の対応先パッド${pad} はフットプリント ${fp.id} にありません`);
      if (used.has(pad) && used.get(pad) !== pin.num) errors.push(`パッド${pad} にピン${used.get(pad)} とピン${pin.num} が重複して割り当てられています`);
      used.set(pad, pin.num);
    }
  }
  for (const pad of pads) if (!used.has(pad)) warnings.push(`パッド${pad} はどのピンにも割り当てられていません（未接続パッド）`);
  return { errors, warnings };
}

// ---- 検索 ----

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[\s_\-]/g, '');

/** 値の表記ゆれ吸収: 10kΩ / 10K / 10k ohm → 10k、100nF → 100n、0.1uF → 100n */
export function normalizeValue(s) {
  let t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/ω|ohm|ohms/g, '').replace(/μ|µ/g, 'u');
  t = t.replace(/(\d)(f|h)$/, '$1').replace(/([pnumk])(f|h)$/, '$1');
  const m = t.match(/^(\d+(?:\.\d+)?)([pnumkr]?)$/);
  if (!m) return t;
  const mult = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, '': 1, r: 1, k: 1e3 }[m[2]];
  const v = Number(m[1]) * mult;
  for (const [suf, f] of [['k', 1e3], ['', 1], ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12]]) {
    const x = v / f;
    if (x >= 1 && x < 1000) return `${Number(x.toPrecision(6))}${suf}`;
  }
  return t;
}

/**
 * 検索。q はスペース区切りの語（すべて含むものを返す）。
 * 対象: 名称・メーカー・型番・LCSC品番・パッケージ・説明・値・電気的仕様
 * filters: { kind, package, jlcType, inStockOnly }
 */
export function searchParts(parts, q, filters = {}, limit = 200) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean);
  const nterms = terms.map((t) => ({ raw: norm(t), val: normalizeValue(t) }));
  const out = [];
  for (const p of parts) {
    if (filters.kind && p.kind !== filters.kind) continue;
    if (filters.package && norm(p.package) !== norm(filters.package) && !norm(p.package).includes(norm(filters.package))) continue;
    if (filters.jlcType && p.jlc.type !== filters.jlcType) continue;
    if (filters.inStockOnly && !(p.stock > 0)) continue;
    if (nterms.length) {
      const hay = norm([p.name, p.manufacturer, p.mpn, p.lcsc, p.package, p.description, p.value, ...Object.values(p.specs)].join(' '));
      const vals = [p.value, ...Object.values(p.specs), ...String(p.description).split(/\s+/)].map(normalizeValue);
      const ok = nterms.every((t) => hay.includes(t.raw) || vals.includes(t.val));
      if (!ok) continue;
    }
    out.push(p);
  }
  // 並び: LCSC品番の完全一致 → Basic/Preferred → 在庫多い順
  const exact = terms.length === 1 ? normalizeLcsc(terms[0]) : '';
  const rank = { basic: 0, preferred: 1, extended: 2, unknown: 3 };
  out.sort((a, b) => ((b.lcsc === exact) - (a.lcsc === exact)) || (rank[a.jlc.type] - rank[b.jlc.type]) || ((b.stock ?? -1) - (a.stock ?? -1)));
  return { total: out.length, items: out.slice(0, limit) };
}

/** 単価（数量 qty 時の USD） */
export function unitPrice(part, qty = 1) {
  let best = null;
  for (const b of [...part.price].sort((x, y) => x.qty - y.qty)) if (qty >= b.qty) best = b.usd;
  return best ?? (part.price[0]?.usd ?? null);
}

// ---- 分類・パッケージからの推定（CSV取込用） ----

/** カテゴリ・説明からシンボル種別を推定 */
export function guessKind(text) {
  const t = String(text || '').toLowerCase();
  const rules = [
    [/potentiometer|trimmer|variable resistor|可変抵抗|半固定/, 'pot'],
    [/aluminum electrolytic|electrolytic|tantalum|電解/, 'electrolytic'],
    [/zener/, 'zener'],
    [/light emitting|led(?!\s*driver)|発光ダイオード/, 'led'],
    [/diode|rectifier|schottky|tvs|ダイオード/, 'diode'],
    [/p-?channel.*(mosfet|mos)|(mosfet|mos).*p-?channel|pch/, 'pmos'],
    [/mosfet|mos tube|field effect/, 'nmos'],
    [/\bpnp\b/, 'pnp'],
    [/bipolar|bjt|transistor|triode|トランジスタ/, 'npn'],
    [/operational amplifier|op amp|opamp|comparator|オペアンプ/, 'opamp'],
    [/inductor|choke|ferrite|インダクタ/, 'inductor'],
    [/capacitor|mlcc|コンデンサ/, 'capacitor'],
    [/resistor|抵抗/, 'resistor'],
    [/switch|スイッチ/, 'switch'],
    [/connector|header|terminal|usb|socket|コネクタ/, 'connector'],
    [/battery|電池/, 'battery'],
  ];
  for (const [re, k] of rules) if (re.test(t)) return k;
  return 'ic';
}

/** パッケージ名と種別からフットプリントIDを推定（見つからなければ ''） */
export function guessFootprint(kind, pkg) {
  const p = String(pkg || '').toUpperCase().replace(/\s/g, '');
  const size = p.match(/\b(0402|0603|0805|1206)\b/)?.[1] || ['0402', '0603', '0805', '1206'].find((s) => p.includes(s));
  if (size) {
    const pre = { resistor: 'R', capacitor: 'C', inductor: 'L', led: 'LED' }[kind];
    if (pre && getFootprint(`${pre}_${size}`)) return `${pre}_${size}`;
  }
  const table = [
    [/^SOT-?23-?5/, 'SOT-23-5'], [/^SOT-?23(-3)?$/, 'SOT-23'], [/^SOT-?223/, 'SOT-223-3_TabPin2'],
    [/^SOD-?123/, 'D_SOD-123'], [/^SOD-?323/, 'D_SOD-323'], [/^(SMA|DO-?214AC)/, 'D_SMA'],
    [/^SOIC-?8|^SOP-?8$/, 'SOIC-8'], [/^SOIC-?14|^SOP-?14$/, 'SOIC-14'], [/^SOIC-?16|^SOP-?16$/, 'SOIC-16'],
    [/^TSSOP-?8$/, 'TSSOP-8'], [/^TSSOP-?14$/, 'TSSOP-14'], [/^TSSOP-?20$/, 'TSSOP-20'],
    [/^DIP-?8$/, 'DIP-8'], [/^DIP-?14$/, 'DIP-14'], [/^DIP-?16$/, 'DIP-16'],
  ];
  for (const [re, id] of table) if (re.test(p)) return id;
  return '';
}

/** シンボル種別と仕様から、回路図に表示する値 */
export function displayValue(part) {
  return part.value || part.specs['Resistance'] || part.specs['Capacitance'] || part.specs['抵抗値'] || part.specs['容量'] || part.mpn || part.name;
}

// ---- 内蔵部品（汎用品）----
// LCSC品番は代表例。lcscVerified:false のものは画面に「要確認」と出し、LCSCページへのリンクで確認してもらう。
const B = (o) => normalizePart({ source: 'builtin', jlc: { type: 'unknown' }, lcscVerified: false, ...o });

export const BUILTIN_PARTS = [
  B({ name: '抵抗 10kΩ 1% 0805', kind: 'resistor', value: '10k', package: '0805', footprint: 'R_0805', specs: { 抵抗値: '10kΩ', 許容差: '±1%', 定格電力: '125mW' } }),
  B({ name: '抵抗 1kΩ 1% 0805', kind: 'resistor', value: '1k', package: '0805', footprint: 'R_0805', specs: { 抵抗値: '1kΩ', 許容差: '±1%' } }),
  B({ name: '抵抗 330Ω 1% 0805', kind: 'resistor', value: '330', package: '0805', footprint: 'R_0805', specs: { 抵抗値: '330Ω', 許容差: '±1%' } }),
  B({ name: '抵抗 10kΩ 1% 0603', kind: 'resistor', value: '10k', package: '0603', footprint: 'R_0603', specs: { 抵抗値: '10kΩ', 許容差: '±1%' } }),
  B({ name: '積層セラコン 100nF 16V X7R 0402', kind: 'capacitor', value: '100n', package: '0402', footprint: 'C_0402', manufacturer: 'Samsung Electro-Mechanics', mpn: 'CL05B104KO5NNNC', lcsc: 'C1525', jlc: { type: 'basic', assembly: true }, lcscVerified: true, datasheet: 'https://www.lcsc.com/datasheet/lcsc_datasheet_2304140030_Samsung-Electro-Mechanics-CL05B104KO5NNNC_C1525.pdf', specs: { 容量: '100nF', 耐圧: '16V', 特性: 'X7R', 許容差: '±10%' } }),
  B({ name: '積層セラコン 100nF 50V X7R 0805', kind: 'capacitor', value: '100n', package: '0805', footprint: 'C_0805', specs: { 容量: '100nF', 耐圧: '50V', 特性: 'X7R' } }),
  B({ name: '積層セラコン 10uF 25V X5R 0805', kind: 'capacitor', value: '10u', package: '0805', footprint: 'C_0805', specs: { 容量: '10uF', 耐圧: '25V', 特性: 'X5R' } }),
  B({ name: '積層セラコン 1uF 25V X5R 0603', kind: 'capacitor', value: '1u', package: '0603', footprint: 'C_0603', specs: { 容量: '1uF', 耐圧: '25V' } }),
  B({ name: 'SMD電解コンデンサ 100uF 16V', kind: 'electrolytic', value: '100u', package: 'SMD,D6.3xL5.4mm', footprint: 'CP_Elec_6.3x5.4', specs: { 容量: '100uF', 耐圧: '16V' } }),
  B({ name: 'チップインダクタ 10uH 0805', kind: 'inductor', value: '10u', package: '0805', footprint: 'L_0805', specs: { インダクタンス: '10uH' } }),
  B({ name: 'LED 赤 0805', kind: 'led', value: 'Red', package: '0805', footprint: 'LED_0805', specs: { 発光色: '赤' } }),
  B({ name: 'LED 緑 0805', kind: 'led', value: 'Green', package: '0805', footprint: 'LED_0805', specs: { 発光色: '緑' } }),
  B({ name: '1N4148W スイッチングダイオード', kind: 'diode', value: '1N4148W', mpn: '1N4148W', package: 'SOD-123', footprint: 'D_SOD-123', specs: { 逆耐圧: '75V', 順電流: '150mA' } }),
  B({ name: 'SS34 ショットキーダイオード 3A 40V', kind: 'diode', value: 'SS34', mpn: 'SS34', package: 'SMA', footprint: 'D_SMA', specs: { 逆耐圧: '40V', 順電流: '3A' } }),
  B({ name: 'ツェナーダイオード 5.1V', kind: 'zener', value: 'BZT52C5V1', mpn: 'BZT52C5V1', package: 'SOD-123', footprint: 'D_SOD-123', specs: { ツェナー電圧: '5.1V' } }),
  // BJT: シンボル 1=B,2=E,3=C / SOT-23 パッド 1=B,2=E,3=C（MMBT3904 の一般的なピン配置）
  B({ name: 'MMBT3904 NPN トランジスタ', kind: 'npn', value: 'MMBT3904', mpn: 'MMBT3904', package: 'SOT-23', footprint: 'SOT-23' }),
  B({ name: 'MMBT3906 PNP トランジスタ', kind: 'pnp', value: 'MMBT3906', mpn: 'MMBT3906', package: 'SOT-23', footprint: 'SOT-23' }),
  // MOSFET: シンボル 1=G,2=S,3=D / SOT-23 パッド 1=G,2=S,3=D（AO3400A/AO3401A）
  B({ name: 'AO3400A Nch MOSFET 30V 5.7A', kind: 'nmos', value: 'AO3400A', manufacturer: 'Alpha & Omega', mpn: 'AO3400A', package: 'SOT-23', footprint: 'SOT-23' }),
  B({ name: 'AO3401A Pch MOSFET -30V -4A', kind: 'pmos', value: 'AO3401A', manufacturer: 'Alpha & Omega', mpn: 'AO3401A', package: 'SOT-23', footprint: 'SOT-23' }),
  // LM358 はデュアル。シンボルはAユニット(1,2,3,4,8)のみなので Bユニットのパッド5,6,7は未接続扱い
  B({ name: 'LM358 デュアルオペアンプ（Aユニット）', kind: 'opamp', value: 'LM358', mpn: 'LM358DR', package: 'SOIC-8', footprint: 'SOIC-8' }),
  // AMS1117-3.3: 1=GND/ADJ, 2=VOUT(タブ), 3=VIN
  B({ name: 'AMS1117-3.3 LDO 3.3V 1A', kind: 'ic', value: 'AMS1117-3.3', manufacturer: 'Advanced Monolithic Systems', mpn: 'AMS1117-3.3', package: 'SOT-223', footprint: 'SOT-223-3_TabPin2', symbol: { kind: 'ic', pinCount: 4, pinNames: 'GND,VOUT,VIN,' }, pinMap: { 1: ['1'], 2: ['2'], 3: ['3'], 4: [] }, specs: { 出力電圧: '3.3V', 出力電流: '1A' } }),
  B({ name: 'ピンヘッダ 1x02 2.54mm', kind: 'connector', value: 'Conn_01x02', package: 'Header 1x2', footprint: 'PinHeader_1x02_P2.54mm', symbol: { kind: 'connector', pinCount: 2 } }),
  B({ name: 'ピンヘッダ 1x04 2.54mm', kind: 'connector', value: 'Conn_01x04', package: 'Header 1x4', footprint: 'PinHeader_1x04_P2.54mm', symbol: { kind: 'connector', pinCount: 4 } }),
  B({ name: 'JST PH 2ピン（電池・電源入力）', kind: 'connector', value: 'JST-PH-2P', package: 'JST-PH-2P', footprint: 'JST_PH_B2B-PH-K_1x02_P2.00mm', symbol: { kind: 'connector', pinCount: 2, pinNames: '+,-' } }),
  B({ name: 'タクトスイッチ 6x6mm THT', kind: 'switch', value: 'SW_Push', package: 'SW-TH_4P-6x6', footprint: 'SW_PUSH_6mm' }),
];
