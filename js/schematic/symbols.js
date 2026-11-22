// 回路図シンボル定義と部品種別カタログ
// シンボルはローカル座標（1単位=0.05inch）で、ピン先端は必ず整数座標。
// ピン番号は一般的なフットプリントのパッド番号に合わせる（部品データのピン↔パッド対応表で変えられる）。
//   ダイオード/LED: 1=K(カソード), 2=A(アノード)  … KiCad標準と同じ
//   BJT(SOT-23): 1=B, 2=E, 3=C   MOSFET(SOT-23): 1=G, 2=S, 3=D
//   オペアンプ: LM358 のAユニット相当 1=OUT, 2=IN-, 3=IN+, 4=V-, 8=V+
//
// ピンの電気的属性 type:
//   passive / input / output / bidirectional / power_in / power_out / open_collector / nc

const L = (x1, y1, x2, y2) => ({ t: 'line', x1, y1, x2, y2 });
const R = (x0, y0, x1, y1, fill = false) => ({ t: 'rect', x0, y0, x1, y1, fill });
const C = (cx, cy, r, fill = false) => ({ t: 'circle', cx, cy, r, fill });
const P = (d, fill = false) => ({ t: 'path', d, fill });
const T = (x, y, text, size = 1, anchor = 'middle') => ({ t: 'text', x, y, text, size, anchor });
const pin = (num, name, x, y, type = 'passive') => ({ num: String(num), name, x, y, type });

// ---- 2端子の共通形（左右にピン） ----
function twoPin(bodyHalf, pinHalf, body, extra = {}) {
  return {
    graphics: [L(-pinHalf, 0, -bodyHalf, 0), L(bodyHalf, 0, pinHalf, 0), ...body],
    bbox: { x0: -pinHalf, y0: -1.6, x1: pinHalf, y1: 1.6 },
    ...extra,
  };
}

const SYMBOLS = {
  resistor: () => ({
    ...twoPin(2.4, 4, [R(-2.4, -0.9, 2.4, 0.9)]),
    pins: [pin(1, '~', -4, 0), pin(2, '~', 4, 0)],
  }),
  pot: () => ({
    ...twoPin(2.4, 4, [R(-2.4, -0.9, 2.4, 0.9), L(0, -4, 0, -1.8), P('M-0.6 -2.2 L0 -1 L0.6 -2.2 Z', true)]),
    bbox: { x0: -4, y0: -4, x1: 4, y1: 1.6 },
    pins: [pin(1, '1', -4, 0), pin(2, '2', 4, 0), pin(3, 'W', 0, -4)],
  }),
  capacitor: () => ({
    ...twoPin(0.5, 2, [L(-0.5, -1.6, -0.5, 1.6), L(0.5, -1.6, 0.5, 1.6)]),
    bbox: { x0: -2, y0: -1.8, x1: 2, y1: 1.8 },
    pins: [pin(1, '~', -2, 0), pin(2, '~', 2, 0)],
  }),
  electrolytic: () => ({
    ...twoPin(0.5, 2, [R(-0.8, -1.6, -0.4, 1.6), P('M0.9 -1.6 Q0.3 0 0.9 1.6'), L(-1.9, -1.6, -1.1, -1.6), L(-1.5, -2, -1.5, -1.2)]),
    graphics: [L(-2, 0, -0.8, 0), L(0.5, 0, 2, 0), R(-0.8, -1.6, -0.4, 1.6), P('M0.9 -1.6 Q0.3 0 0.9 1.6'), L(-1.9, -1.6, -1.1, -1.6), L(-1.5, -2, -1.5, -1.2)],
    bbox: { x0: -2, y0: -2, x1: 2, y1: 1.8 },
    pins: [pin(1, '+', -2, 0), pin(2, '-', 2, 0)],
  }),
  inductor: () => ({
    ...twoPin(2.4, 4, [P('M-2.4 0 a0.6 0.6 0 0 1 1.2 0 a0.6 0.6 0 0 1 1.2 0 a0.6 0.6 0 0 1 1.2 0 a0.6 0.6 0 0 1 1.2 0')]),
    pins: [pin(1, '1', -4, 0), pin(2, '2', 4, 0)],
  }),
  diode: () => ({
    ...twoPin(1, 3, [P('M-1 -1 L1 0 L-1 1 Z'), L(1, -1, 1, 1)]),
    graphics: [L(-3, 0, -1, 0), L(1, 0, 3, 0), P('M-1 -1 L1 0 L-1 1 Z'), L(1, -1, 1, 1)],
    bbox: { x0: -3, y0: -1.6, x1: 3, y1: 1.6 },
    pins: [pin(1, 'K', 3, 0), pin(2, 'A', -3, 0)],
  }),
  led: () => ({
    graphics: [L(-3, 0, -1, 0), L(1, 0, 3, 0), P('M-1 -1 L1 0 L-1 1 Z'), L(1, -1, 1, 1),
      L(-0.2, -1.4, 0.8, -2.4), P('M0.8 -2.4 L0.2 -2.3 L0.7 -1.8 Z', true),
      L(0.8, -1.4, 1.8, -2.4), P('M1.8 -2.4 L1.2 -2.3 L1.7 -1.8 Z', true)],
    bbox: { x0: -3, y0: -2.6, x1: 3, y1: 1.6 },
    pins: [pin(1, 'K', 3, 0), pin(2, 'A', -3, 0)],
  }),
  zener: () => ({
    graphics: [L(-3, 0, -1, 0), L(1, 0, 3, 0), P('M-1 -1 L1 0 L-1 1 Z'), P('M0.6 -1.2 L1 -1 L1 1 L1.4 1.2')],
    bbox: { x0: -3, y0: -1.6, x1: 3, y1: 1.6 },
    pins: [pin(1, 'K', 3, 0), pin(2, 'A', -3, 0)],
  }),
  npn: () => bjt(false),
  pnp: () => bjt(true),
  nmos: () => mosfet(false),
  pmos: () => mosfet(true),
  opamp: () => ({
    graphics: [P('M-4 -4.5 L-4 4.5 L4 0 Z'), L(-6, -2, -4, -2), L(-6, 2, -4, 2), L(4, 0, 6, 0),
      L(0, -4, 0, -2.25), L(0, 4, 0, 2.25), T(-3.1, -1.6, '+', 1.4, 'middle'), T(-3.1, 2.4, '−', 1.4, 'middle')],
    bbox: { x0: -6, y0: -4.5, x1: 6, y1: 4.5 },
    pins: [pin(3, '+', -6, -2, 'input'), pin(2, '-', -6, 2, 'input'), pin(1, 'OUT', 6, 0, 'output'),
      pin(8, 'V+', 0, -4, 'power_in'), pin(4, 'V-', 0, 4, 'power_in')],
    showPinNumbers: true,
  }),
  switch: () => ({
    graphics: [L(-4, 0, -2, 0), L(2, 0, 4, 0), C(-1.6, 0, 0.4), C(1.6, 0, 0.4), L(-1.3, -0.4, 1.6, -1.6)],
    bbox: { x0: -4, y0: -1.8, x1: 4, y1: 1.6 },
    pins: [pin(1, '1', -4, 0), pin(2, '2', 4, 0)],
  }),
  battery: () => ({
    graphics: [L(0, -4, 0, -0.6), L(0, 0.6, 0, 4), L(-1.6, -0.6, 1.6, -0.6), L(-0.8, 0.6, 0.8, 0.6), T(1.6, -1.4, '+', 1.2, 'middle')],
    bbox: { x0: -1.8, y0: -4, x1: 1.8, y1: 4 },
    pins: [pin(1, '+', 0, -4, 'power_out'), pin(2, '-', 0, 4, 'power_out')],
  }),
  power: (comp) => ({
    graphics: [L(0, 0, 0, -1.6), L(-1.2, -1.6, 1.2, -1.6), T(0, -2.3, comp?.props?.net || 'VCC', 1.1, 'middle')],
    bbox: { x0: -1.4, y0: -3.2, x1: 1.4, y1: 0 },
    pins: [pin(1, comp?.props?.net || 'VCC', 0, 0, 'power_in')],
    isPower: true,
  }),
  gnd: (comp) => ({
    graphics: [L(0, 0, 0, 1), L(-1.4, 1, 1.4, 1), L(-0.9, 1.5, 0.9, 1.5), L(-0.4, 2, 0.4, 2)],
    bbox: { x0: -1.5, y0: 0, x1: 1.5, y1: 2.2 },
    pins: [pin(1, comp?.props?.net || 'GND', 0, 0, 'power_in')],
    isPower: true,
  }),
  ic: (comp) => boxIC(comp),
  connector: (comp) => connector(comp),
};

function bjt(pnp) {
  // B 左, C 上, E 下（矢印はエミッタ）
  const arrow = pnp ? 'M0.9 1.1 L0.2 0.4 L0.4 1.3 Z' : 'M2 2 L1.1 1.8 L1.7 1.2 Z';
  return {
    graphics: [L(-4, 0, -0.8, 0), L(-0.8, -1.6, -0.8, 1.6), L(-0.8, -0.6, 2, -2), L(2, -2, 2, -4),
      L(-0.8, 0.6, 2, 2), L(2, 2, 2, 4), P(arrow, true), C(0.2, 0, 2.8)],
    bbox: { x0: -4, y0: -4, x1: 3, y1: 4 },
    pins: [pin(1, 'B', -4, 0, 'input'), pin(2, 'E', 2, 4, 'passive'), pin(3, 'C', 2, -4, 'passive')],
  };
}

function mosfet(p) {
  const arrow = p ? 'M1.6 0 L0.6 -0.5 L0.6 0.5 Z' : 'M-0.2 0 L0.8 -0.5 L0.8 0.5 Z';
  return {
    graphics: [L(-4, 0, -1.2, 0), L(-1.2, -1.6, -1.2, 1.6),
      L(-0.6, -2, -0.6, -1), L(-0.6, -0.5, -0.6, 0.5), L(-0.6, 1, -0.6, 2),
      L(-0.6, -1.5, 2, -1.5), L(2, -1.5, 2, -4), L(-0.6, 1.5, 2, 1.5), L(2, 1.5, 2, 4),
      L(-0.6, 0, 2, 0), L(2, 0, 2, 1.5), P(arrow, true)],
    bbox: { x0: -4, y0: -4, x1: 3, y1: 4 },
    pins: [pin(1, 'G', -4, 0, 'input'), pin(2, 'S', 2, 4, 'passive'), pin(3, 'D', 2, -4, 'passive')],
  };
}

export function clampPinCount(n, min, max, even = false) {
  let v = Math.round(Number(n));
  if (!Number.isFinite(v)) v = min;
  v = Math.max(min, Math.min(max, v));
  if (even && v % 2) v += 1;
  return v;
}

function pinNameList(comp) {
  return String(comp?.props?.pinNames || '').split(',').map((s) => s.trim());
}

/**
 * 汎用IC: DIP/SOIC と同じ反時計回りの番号。
 * 左に 1..L（上から）、右に n..L+1（上から）。L = ceil(n/2)。奇数ピン（露出パッド付きQFNなど）にも対応
 */
function boxIC(comp) {
  const n = clampPinCount(comp?.props?.pinCount ?? 8, 1, 256);
  const left = Math.ceil(n / 2), right = n - left;
  const names = pinNameList(comp);
  const top = -(left - 1);
  const pins = [];
  const g = [];
  const width = 5 + Math.min(6, Math.ceil(Math.max(0, ...names.map((s) => s.length)) * 0.35));
  for (let i = 0; i < left; i++) {
    const y = top + i * 2;
    pins.push(pin(i + 1, names[i] || '', -width - 2, y, 'bidirectional'));
    g.push(L(-width - 2, y, -width, y));
    if (names[i]) g.push(T(-width + 0.4, y + 0.35, names[i], 0.9, 'start'));
  }
  for (let j = 0; j < right; j++) {
    const num = n - j;
    const y = top + j * 2;
    pins.push(pin(num, names[num - 1] || '', width + 2, y, 'bidirectional'));
    g.push(L(width, y, width + 2, y));
    if (names[num - 1]) g.push(T(width - 0.4, y + 0.35, names[num - 1], 0.9, 'end'));
  }
  pins.sort((a, b) => Number(a.num) - Number(b.num));
  const y0 = top - 1.5, y1 = top + (left - 1) * 2 + 1.5;
  g.unshift(R(-width, y0, width, y1));
  return { graphics: g, bbox: { x0: -width - 2, y0, x1: width + 2, y1 }, pins, showPinNumbers: true };
}

/** ピンヘッダ等: 左にピン 1..n（上から） */
function connector(comp) {
  const n = clampPinCount(comp?.props?.pinCount ?? 2, 1, 64);
  const names = pinNameList(comp);
  const top = -(n - 1);
  const pins = [];
  const g = [R(-2, top - 1.4, 1, top + (n - 1) * 2 + 1.4)];
  for (let i = 0; i < n; i++) {
    const y = top + i * 2;
    pins.push(pin(i + 1, names[i] || String(i + 1), -4, y, 'passive'));
    g.push(L(-4, y, -2, y), R(-1.4, y - 0.3, -0.8, y + 0.3, true));
  }
  return { graphics: g, bbox: { x0: -4, y0: top - 1.4, x1: 1, y1: top + (n - 1) * 2 + 1.4 }, pins, showPinNumbers: true };
}

// ---- 部品種別カタログ ----
// prefix: 部品番号の接頭辞 / props: 既定の属性 / footprint は既定のフットプリント
export const KINDS = [
  { kind: 'resistor', label: '抵抗', prefix: 'R', props: { value: '10k', footprint: 'R_0805' } },
  { kind: 'pot', label: '可変抵抗', prefix: 'RV', props: { value: '10k', footprint: 'Potentiometer_3362P' } },
  { kind: 'capacitor', label: 'コンデンサ', prefix: 'C', props: { value: '100n', footprint: 'C_0805' } },
  { kind: 'electrolytic', label: '電解コンデンサ', prefix: 'C', props: { value: '10u', footprint: 'CP_Elec_5x5.4' } },
  { kind: 'inductor', label: 'インダクタ', prefix: 'L', props: { value: '10u', footprint: 'L_0805' } },
  { kind: 'diode', label: 'ダイオード', prefix: 'D', props: { value: '1N4148W', footprint: 'D_SOD-123' } },
  { kind: 'led', label: 'LED', prefix: 'D', props: { value: 'Red', footprint: 'LED_0805' } },
  { kind: 'zener', label: 'ツェナー', prefix: 'D', props: { value: 'BZT52C5V1', footprint: 'D_SOD-123' } },
  { kind: 'npn', label: 'NPNトランジスタ', prefix: 'Q', props: { value: 'MMBT3904', footprint: 'SOT-23' } },
  { kind: 'pnp', label: 'PNPトランジスタ', prefix: 'Q', props: { value: 'MMBT3906', footprint: 'SOT-23' } },
  { kind: 'nmos', label: 'Nch MOSFET', prefix: 'Q', props: { value: 'AO3400A', footprint: 'SOT-23' } },
  { kind: 'pmos', label: 'Pch MOSFET', prefix: 'Q', props: { value: 'AO3401A', footprint: 'SOT-23' } },
  { kind: 'opamp', label: 'オペアンプ', prefix: 'U', props: { value: 'LM358', footprint: 'SOIC-8' } },
  { kind: 'ic', label: 'IC（汎用）', prefix: 'U', props: { value: 'IC', footprint: 'SOIC-8', pinCount: 8, pinNames: '' } },
  { kind: 'connector', label: 'コネクタ', prefix: 'J', props: { value: 'Conn_01x02', footprint: 'PinHeader_1x02_P2.54mm', pinCount: 2, pinNames: '' } },
  { kind: 'switch', label: 'スイッチ', prefix: 'SW', props: { value: 'SW_Push', footprint: 'SW_SPST_6x6' } },
  { kind: 'battery', label: '電池・電源', prefix: 'BT', props: { value: '3V', footprint: 'BatteryHolder' } },
  { kind: 'power', label: '電源記号', prefix: '#PWR', props: { net: 'VCC' }, power: true },
  { kind: 'gnd', label: 'GND', prefix: '#PWR', props: { net: 'GND' }, power: true },
];

export const POWER_NETS = ['VCC', '+5V', '+3V3', '+12V', 'VBUS', 'GND'];

export function kindInfo(kind) { return KINDS.find((k) => k.kind === kind); }

const cache = new Map();
/** 部品の現在の属性に合ったシンボルを返す（ICとコネクタはピン数で形が変わる） */
export function getSymbol(comp) {
  const f = SYMBOLS[comp.kind];
  if (!f) throw new Error(`未知の部品種別: ${comp.kind}`);
  const k = `${comp.kind}|${comp.props?.pinCount ?? ''}|${comp.props?.pinNames ?? ''}|${comp.props?.net ?? ''}`;
  if (!cache.has(k)) {
    if (cache.size > 500) cache.clear();
    cache.set(k, Object.freeze(f(comp)));
  }
  return cache.get(k);
}
