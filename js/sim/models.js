// 内蔵のシミュレーション用モデル（部品の値・型番から選ぶ）
//
// 数値はデータシートの代表値に合わせた近似（SPICE の基本モデル: ダイオード・Gummel-Poon の基本・MOSFET レベル 1）。
// メーカーの SPICE モデルがあるときは、シミュレーション画面の「ライブラリ」に .model / .subckt を貼り、部品に割り当てる。
// どの数を使ったかは画面に出す（黙って近似しない）。

const D = (o) => ({ type: 'd', ...o });
export const DIODES = {
  GENERIC: { label: '一般のダイオード（IS=1e-14）', m: D({ IS: 1e-14, N: 1 }) },
  '1N4148': { label: '1N4148（小信号）', m: D({ IS: 2.52e-9, N: 1.752, RS: 0.568, BV: 100, IBV: 100e-6, CJO: 4e-12, M: 0.333, VJ: 0.5, TT: 11.5e-9 }) },
  '1N4148W': { alias: '1N4148' },
  BAT54: { label: 'BAT54（ショットキー）', m: D({ IS: 2e-7, N: 1.04, RS: 1.2, BV: 30, IBV: 1e-6, CJO: 10e-12, M: 0.5, VJ: 0.35 }) },
  SS14: { label: 'SS14（ショットキー 1A）', m: D({ IS: 5e-6, N: 1.1, RS: 0.05, BV: 40, IBV: 1e-3, CJO: 110e-12, M: 0.5, VJ: 0.35 }) },
  BZT52C5V1: { label: 'BZT52C5V1（ツェナー 5.1V）', m: D({ IS: 1e-14, N: 1, RS: 1, BV: 5.1, IBV: 5e-3, NBV: 1.5, CJO: 100e-12 }) },
  // 双方向の ESD 保護（約 6V で導通）。片方向の近似（逆向きもツェナーとして導通）
  PESD5V0S1BB: { label: 'PESD5V0S1BB（双方向 ESD・片側の近似）', m: D({ IS: 1e-14, N: 1, BV: 6.4, IBV: 1e-3, NBV: 1.5, CJO: 35e-12 }) },
  // LED: Vf の代表値に合わせる（赤 1.9V・緑/青/白 3.0V @ 5mA）
  RED: { label: 'LED 赤（Vf 約 1.9V @5mA）', m: D({ IS: 1e-18, N: 2, RS: 5, CJO: 20e-12 }) },
  'KT-0603R': { alias: 'RED' },
  YELLOW: { label: 'LED 黄（Vf 約 2.0V @5mA）', m: D({ IS: 3e-19, N: 2, RS: 5, CJO: 20e-12 }) },
  GREEN: { label: 'LED 緑（Vf 約 3.0V @5mA）', m: D({ IS: 3e-28, N: 2, RS: 8, CJO: 20e-12 }) },
  BLUE: { alias: 'GREEN' }, WHITE: { alias: 'GREEN' },
};

const Q = (type, o) => ({ type, ...o });
export const BJTS = {
  GENERIC_NPN: { label: '一般の NPN（BF=100）', m: Q('npn', { IS: 1e-15, BF: 100, BR: 1, VAF: 100 }) },
  GENERIC_PNP: { label: '一般の PNP（BF=100）', m: Q('pnp', { IS: 1e-15, BF: 100, BR: 1, VAF: 100 }) },
  '2N3904': { label: '2N3904 / MMBT3904', m: Q('npn', { IS: 6.734e-15, BF: 416.4, BR: 0.7371, NF: 1, NR: 1, VAF: 74.03, CJE: 4.493e-12, MJE: 0.2593, VJE: 0.75, CJC: 3.638e-12, MJC: 0.3085, VJC: 0.75, TF: 301.2e-12 }) },
  MMBT3904: { alias: '2N3904' },
  '2N3906': { label: '2N3906 / MMBT3906', m: Q('pnp', { IS: 1.41e-15, BF: 180.7, BR: 4.977, NF: 1, NR: 1, VAF: 18.7, CJE: 8.063e-12, MJE: 0.3677, VJE: 0.75, CJC: 4.017e-12, MJC: 0.5293, VJC: 0.75, TF: 513.9e-12 }) },
  MMBT3906: { alias: '2N3906' },
  BC847: { label: 'BC847', m: Q('npn', { IS: 1.8e-14, BF: 290, BR: 6, VAF: 80, CJE: 13e-12, CJC: 4e-12, TF: 0.6e-9 }) },
  BC857: { label: 'BC857', m: Q('pnp', { IS: 2e-14, BF: 250, BR: 6, VAF: 40, CJE: 13e-12, CJC: 6e-12, TF: 0.6e-9 }) },
  S8050: { label: 'S8050', m: Q('npn', { IS: 1e-14, BF: 200, BR: 3, VAF: 100, CJE: 20e-12, CJC: 9e-12, TF: 0.5e-9 }) },
  S8550: { label: 'S8550', m: Q('pnp', { IS: 1e-14, BF: 200, BR: 3, VAF: 100, CJE: 20e-12, CJC: 12e-12, TF: 0.5e-9 }) },
};

// MOSFET（レベル 1。W=L=1 として KP をそのまま β に。オン抵抗の代表値: Rds ≈ 1/(KP·(|Vgs|−|Vth|))）
const M = (type, o) => ({ type, ...o });
export const MOSFETS = {
  GENERIC_NMOS: { label: '一般の N チャネル（Vth 2V）', m: M('nmos', { VTO: 2, KP: 1, LAMBDA: 0.01 }) },
  GENERIC_PMOS: { label: '一般の P チャネル（Vth −2V）', m: M('pmos', { VTO: -2, KP: 1, LAMBDA: 0.01 }) },
  // AO3400A: Vth 1.05V（代表）、Rds 約 28mΩ @4.5V、Ciss 約 630pF、Crss 約 50pF
  AO3400A: { label: 'AO3400A（30V・Vth 1.05V・Rds 約 28mΩ@4.5V）', m: M('nmos', { VTO: 1.05, KP: 10.3, LAMBDA: 0.01, CGSO: 580e-12, CGDO: 50e-12 }) },
  // AO3401A: Vth −0.9V（代表）、Rds 約 44mΩ @−4.5V、Ciss 約 645pF、Crss 約 60pF
  AO3401A: { label: 'AO3401A（−30V・Vth −0.9V・Rds 約 44mΩ@−4.5V）', m: M('pmos', { VTO: -0.9, KP: 6.3, LAMBDA: 0.01, CGSO: 585e-12, CGDO: 60e-12 }) },
  '2N7002': { label: '2N7002（60V・Vth 2.1V・Rds 約 2Ω@5V）', m: M('nmos', { VTO: 2.1, KP: 0.17, LAMBDA: 0.02, CGSO: 20e-12, CGDO: 5e-12 }) },
  BSS138: { label: 'BSS138（50V・Vth 1.3V・Rds 約 1.4Ω@5V）', m: M('nmos', { VTO: 1.3, KP: 0.19, LAMBDA: 0.02, CGSO: 25e-12, CGDO: 6e-12 }) },
  SI2301: { label: 'SI2301（−20V・Vth −0.8V・Rds 約 110mΩ@−4.5V）', m: M('pmos', { VTO: -0.8, KP: 2.4, LAMBDA: 0.01, CGSO: 380e-12, CGDO: 70e-12 }) },
};

// オペアンプ（開ループ利得 A・GBW・出力抵抗・電源から出力の上限/下限までの電圧）
const OA = (o) => ({ A: 1e5, GBW: 1e6, ROUT: 10, VOH: 1.5, VOL: 0.05, ...o });
export const OPAMPS = {
  GENERIC: { label: '一般のオペアンプ（A=100dB・GBW 1MHz）', m: OA({ VOH: 1, VOL: 1 }) },
  LM358: { label: 'LM358（GBW 1MHz・出力は電源 −1.5V／GND 近くまで）', m: OA({ A: 1e5, GBW: 1e6, VOH: 1.5, VOL: 0.02 }) },
  LM324: { alias: 'LM358' },
  MCP6002: { label: 'MCP6002（GBW 1MHz・レール・ツー・レール）', m: OA({ A: 1e5, GBW: 1e6, ROUT: 50, VOH: 0.025, VOL: 0.025 }) },
  TL072: { label: 'TL072（GBW 3MHz・出力は電源 ±1.5V まで）', m: OA({ A: 2e5, GBW: 3e6, VOH: 1.5, VOL: 1.5 }) },
  NE5532: { label: 'NE5532（GBW 10MHz）', m: OA({ A: 1e5, GBW: 10e6, ROUT: 0.3, VOH: 1.5, VOL: 1.5 }) },
};

const LIBS = { diode: DIODES, led: DIODES, zener: DIODES, npn: BJTS, pnp: BJTS, nmos: MOSFETS, pmos: MOSFETS, opamp: OPAMPS };

/** 名前（大文字小文字・空白・- を無視）で引く */
export function lookup(lib, name) {
  if (!name) return null;
  const key = String(name).toUpperCase().replace(/\s+/g, '');
  const keys = Object.keys(lib);
  let k = keys.find((x) => x === key) || keys.find((x) => key.startsWith(x) || key.includes(x));
  if (!k) return null;
  let e = lib[k];
  for (let i = 0; e?.alias && i < 4; i++) { k = e.alias; e = lib[k]; }
  return e ? { key: k, ...e } : null;
}

/** 部品の種類と値・型番から、内蔵モデル（無ければ種類ごとの一般モデル） */
export function builtinFor(kind, value, mpn = '') {
  const lib = LIBS[kind];
  if (!lib) return null;
  const okType = (h) => h && (['npn', 'pnp', 'nmos', 'pmos'].includes(kind) ? h.m.type === kind : true);
  const hit = [lookup(lib, mpn), lookup(lib, value)].find(okType);
  if (hit) return hit;
  if (kind === 'led') return { key: 'RED', ...DIODES.RED, guessed: true };
  if (kind === 'npn' || kind === 'pnp') return { key: `GENERIC_${kind.toUpperCase()}`, ...BJTS[`GENERIC_${kind.toUpperCase()}`], guessed: true };
  if (kind === 'nmos' || kind === 'pmos') return { key: `GENERIC_${kind.toUpperCase()}`, ...MOSFETS[`GENERIC_${kind.toUpperCase()}`], guessed: true };
  if (kind === 'opamp') return { key: 'GENERIC', ...OPAMPS.GENERIC, guessed: true };
  return { key: 'GENERIC', ...DIODES.GENERIC, guessed: true };
}

/** 選べる内蔵モデルの一覧（種類ごと） */
export function builtinChoices(kind) {
  const lib = LIBS[kind];
  if (!lib) return [];
  return Object.entries(lib).filter(([, v]) => !v.alias && (kind !== 'npn' || v.m.type === 'npn') && (kind !== 'pnp' || v.m.type === 'pnp') && (kind !== 'nmos' || v.m.type === 'nmos') && (kind !== 'pmos' || v.m.type === 'pmos')).map(([k, v]) => ({ key: k, label: v.label }));
}
