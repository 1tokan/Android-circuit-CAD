// 数値と単位（SPICE の書き方）
//  10k・4k7・2u2・100nF・1.5Meg・3V3・10mA などを数にする。f p n u(µ) m k Meg G T
//  単位の文字（F・H・V・A・Ω・Hz・s）は読み飛ばす。
//  部品の値（回路図）は KiCad 7 と同じ SI の書き方: M = メガ、m = ミリ（Meg も メガ）。
//  SPICE の文（.model など）は SPICE の書き方: 大文字小文字を区別せず M = ミリ、Meg = メガ（spice: true）

const SUFFIX = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, mil: 25.4e-6 };

/**
 * @param opt.spice true なら SPICE の書き方（M = ミリ）
 * @returns 数（読めなければ NaN）
 */
export function parseValue(text, opt = {}) {
  if (typeof text === 'number') return text;
  let s = String(text ?? '').trim().replace(/[Ω\s]/g, '').replace(/ohms?$/i, '');
  if (!s) return NaN;
  // 4k7・2u2・3V3・1R5 の書き方（単位の文字が小数点の位置）
  let m = s.match(/^([+-]?\d+)(meg|[tgkmunpfµμrv])(\d+)([a-z]*)$/i);
  if (m) {
    const mult = /^[rv]$/i.test(m[2]) ? 1 : (!opt.spice && m[2] === 'M') ? 1e6 : SUFFIX[m[2].toLowerCase()] ?? NaN;
    return Number(`${m[1]}.${m[3]}`) * mult;
  }
  m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i);
  if (!m) return NaN;
  const v = Number(m[1]);
  if (!m[2]) return v;
  if (!opt.spice && m[2][0] === 'M' && !/^meg/i.test(m[2])) return v * 1e6; // SI の M（メガ）
  const rest = m[2].toLowerCase();
  if (!opt.spice && /^F$/.test(m[2])) return v; // SI の大文字 F はファラド（1F の電気二重層コンデンサ）
  for (const k of ['meg', 'mil', 't', 'g', 'k', 'm', 'u', 'µ', 'μ', 'n', 'p', 'f']) if (rest.startsWith(k)) return v * SUFFIX[k];
  // 単位だけ（V・A・F・H・Hz・s）
  if (/^(v|a|f|h|hz|s|w|ohm)$/i.test(rest)) return v;
  return NaN;
}

const ENG = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
/** 工学表記（3 桁）。unit は後ろに付ける単位 */
export function formatValue(v, unit = '', digits = 3) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return `0${unit}`;
  const a = Math.abs(v);
  for (const [m, p] of ENG) {
    if (a >= m * 0.9995) return `${Number((v / m).toPrecision(digits))}${p}${unit}`;
  }
  return `${v.toPrecision(digits)}${unit}`;
}

/** SPICE に書く数（ngspice が読める形。µ は u、メガは Meg） */
export function spiceNum(v) {
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const tbl = [[1e9, 'G'], [1e6, 'Meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  for (const [m, p] of tbl) if (a >= m * 0.999999) return `${Number((v / m).toPrecision(12))}${p}`;
  return v.toExponential(9);
}
