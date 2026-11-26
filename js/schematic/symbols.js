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
    // KiCad R_Potentiometer・半固定抵抗の足形と同じ: 1・3 = 両端, 2 = ワイパ（0.13.2 までは 3 がワイパで、足形のワイパ 2 番と逆だった）
    pins: [pin(1, '1', -4, 0), pin(3, '3', 4, 0), pin(2, 'W', 0, -4)],
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

  // ---- 0.13.3: 手書きで足りなかった部品。ピン番号は KiCad 公式シンボル・フットプリントと同じ ----
  // シミュレーション用の信号源（基板・BOM に載らない virtual 部品。値は SPICE の書き方）
  vac: () => source([P('M-1.2 0 Q-0.6 -1.4 0 0 Q0.6 1.4 1.2 0')], 'passive'),
  vdc: () => source([T(0, -0.3, '+', 1.2), T(0, 1.5, '−', 1.2)], 'power_out'),
  isrc: () => source([L(0, -1.2, 0, 1.2), P('M-0.55 0.5 L0 1.3 L0.55 0.5 Z', true)], 'passive'),
  // トランス（KiCad Transformer_1P_1S: 1・2 = 1 次, 4・3 = 2 次。点は 1 と 4 の側）
  transformer: () => ({
    graphics: [L(-4, -2, -1.6, -2), L(-4, 2, -1.6, 2), L(4, -2, 1.6, -2), L(4, 2, 1.6, 2),
      P('M-1.6 -2 a0.5 0.5 0 0 1 0 1 a0.5 0.5 0 0 1 0 1 a0.5 0.5 0 0 1 0 1 a0.5 0.5 0 0 1 0 1'),
      P('M1.6 -2 a0.5 0.5 0 0 0 0 1 a0.5 0.5 0 0 0 0 1 a0.5 0.5 0 0 0 0 1 a0.5 0.5 0 0 0 0 1'),
      L(-0.35, -2.4, -0.35, 2.4), L(0.35, -2.4, 0.35, 2.4), C(-2.2, -2.7, 0.25, true), C(2.2, -2.7, 0.25, true)],
    bbox: { x0: -4, y0: -3, x1: 4, y1: 3 },
    pins: [pin(1, 'AA', -4, -2), pin(2, 'AB', -4, 2), pin(4, 'SB', 4, -2), pin(3, 'SA', 4, 2)],
    showPinNumbers: true,
  }),
  fuse: () => ({
    ...twoPin(2, 4, [R(-2, -0.7, 2, 0.7), L(-2, 0, 2, 0)]),
    pins: [pin(1, '~', -4, 0), pin(2, '~', 4, 0)],
  }),
  ferrite: () => ({
    ...twoPin(1.8, 4, [P('M-1.8 0.3 L-0.6 -1.1 L1.8 -0.3 L0.6 1.1 Z')]),
    pins: [pin(1, '~', -4, 0), pin(2, '~', 4, 0)],
  }),
  // 水晶（KiCad Crystal_GND24: 1・3 = 水晶, 2・4 = ケース）
  crystal: () => ({
    graphics: [L(-3, 0, -1.2, 0), L(1.2, 0, 3, 0), L(-1.2, -1.2, -1.2, 1.2), L(1.2, -1.2, 1.2, 1.2), R(-0.7, -1.4, 0.7, 1.4),
      L(0, -3, 0, -2.2), L(0, 3, 0, 2.2), L(-1.8, -2.2, 1.8, -2.2), L(-1.8, 2.2, 1.8, 2.2), L(-1.8, -2.2, -1.8, -1.6), L(1.8, -2.2, 1.8, -1.6), L(-1.8, 2.2, -1.8, 1.6), L(1.8, 2.2, 1.8, 1.6)],
    bbox: { x0: -3, y0: -3, x1: 3, y1: 3 },
    pins: [pin(1, '1', -3, 0), pin(3, '3', 3, 0), pin(2, 'GND', 0, -3), pin(4, 'GND', 0, 3)],
    showPinNumbers: true,
  }),
  schottky: () => ({
    graphics: [L(-3, 0, -1, 0), L(1, 0, 3, 0), P('M-1 -1 L1 0 L-1 1 Z'), P('M1.5 -0.7 L1.5 -1 L1 -1 L1 1 L0.5 1 L0.5 0.7')],
    bbox: { x0: -3, y0: -1.6, x1: 3, y1: 1.6 },
    pins: [pin(1, 'K', 3, 0), pin(2, 'A', -3, 0)],
  }),
  // TVS（双方向。KiCad D_TVS: 1 = A1, 2 = A2）
  tvs: () => ({
    graphics: [L(-3, 0, -1.6, 0), L(1.6, 0, 3, 0), P('M-1.6 -1 L0 0 L-1.6 1 Z'), P('M1.6 -1 L0 0 L1.6 1 Z'), P('M-0.4 -1.3 L0 -1 L0 1 L0.4 1.3')],
    bbox: { x0: -3, y0: -1.6, x1: 3, y1: 1.6 },
    pins: [pin(1, 'A1', -3, 0), pin(2, 'A2', 3, 0)],
  }),
  // ブリッジダイオード（KiCad MB2S〜MB10S: 1・2 = ~, 3 = +, 4 = −）
  bridge: () => ({
    graphics: [P('M0 -2.8 L2.8 0 L0 2.8 L-2.8 0 Z'), L(0, -4, 0, -2.8), L(0, 4, 0, 2.8), L(4, 0, 2.8, 0), L(-4, 0, -2.8, 0),
      ...[[-1.4, -1.4, 1, -1], [1.4, -1.4, 1, 1], [-1.4, 1.4, 1, 1], [1.4, 1.4, 1, -1]].flatMap(([x, y, dx, dy]) => diodeMark(x, y, dx, dy)),
      T(-0.9, -3.1, '~', 1), T(-0.9, 3.9, '~', 1), T(3.4, -0.7, '+', 1.1), T(-3.4, -0.7, '−', 1.1)],
    bbox: { x0: -4, y0: -4, x1: 4, y1: 4 },
    pins: [pin(1, '~', 0, 4), pin(2, '~', 0, -4), pin(3, '+', 4, 0), pin(4, '-', -4, 0)],
    showPinNumbers: true,
  }),
  // 3 端子レギュレータ（KiCad AP1117 系・AMS1117 SOT-223: 1 = GND, 2 = VO, 3 = VI）
  regulator: () => ({
    graphics: [R(-3.5, -1.8, 3.5, 2), L(-5, 0, -3.5, 0), L(3.5, 0, 5, 0), L(0, 2, 0, 3),
      T(-3.2, 0.3, 'IN', 0.75, 'start'), T(3.2, 0.3, 'OUT', 0.75, 'end'), T(0, 1.65, 'GND', 0.75)],
    bbox: { x0: -5, y0: -1.8, x1: 5, y1: 3 },
    pins: [pin(1, 'GND', 0, 3, 'power_in'), pin(2, 'VO', 5, 0, 'power_out'), pin(3, 'VI', -5, 0, 'power_in')],
    showPinNumbers: true,
  }),
  // リレー（KiCad SANYOU_SRD_Form_C: 1 = COM, 2・5 = コイル, 3 = NO, 4 = NC。接点は 4 側で休む）
  relay: () => ({
    graphics: [R(-8, -4, 8, 4), R(-6.5, -1.5, -1.5, 1.5), L(-6, 1.5, -2, -1.5), L(-4, 4, -4, 1.5), L(-4, -4, -4, -1.5),
      L(-4, -6, -4, -4), L(-4, 6, -4, 4), L(4, 6, 4, 4), L(6, -6, 6, -4), L(2, -6, 2, -4),
      L(-1.5, 0, -1, 0), L(-0.5, 0, 0, 0), L(0.5, 0, 1, 0), L(1.5, 0, 2, 0), L(2.5, 0, 3, 0),
      L(4, 4, 4, 2), L(4, 2, 2.5, -3), L(6, -4, 6, -2), L(6, -2, 5.5, -2.5), L(2, -4, 2, -2), P('M2 -3 L2.5 -2.5 L2 -2 Z', true),
      T(4.6, 3.4, 'COM', 0.7, 'start'), T(6.4, -2.4, 'NO', 0.7, 'start'), T(1.6, -2.4, 'NC', 0.7, 'end')],
    bbox: { x0: -8, y0: -6, x1: 8, y1: 6 },
    pins: [pin(1, 'COM', 4, 6), pin(2, '~', -4, 6), pin(3, 'NO', 6, -6), pin(4, 'NC', 2, -6), pin(5, '~', -4, -6)],
    showPinNumbers: true,
  }),
  // フォトカプラ（KiCad PC817: 1 = A, 2 = K, 3 = E, 4 = C）
  optocoupler: () => ({
    graphics: [R(-4, -3.4, 4, 3.4), L(-6, -2, -2.6, -2), L(-2.6, -2, -2.6, -0.8), P('M-3.4 -0.8 L-1.8 -0.8 L-2.6 0.4 Z'), L(-3.4, 0.4, -1.8, 0.4),
      L(-2.6, 0.4, -2.6, 2), L(-2.6, 2, -6, 2), L(-1.2, -0.8, 0.4, 0), L(-1.2, 0.2, 0.4, 1), P('M0.4 0 L-0.2 0.1 L0.2 -0.4 Z', true), P('M0.4 1 L-0.2 1.1 L0.2 0.6 Z', true),
      L(1.6, -1.4, 1.6, 1.4), L(1.6, -0.6, 3, -2), L(3, -2, 6, -2), L(1.6, 0.6, 3, 2), L(3, 2, 6, 2), P('M3 2 L2.2 1.8 L2.7 1.3 Z', true)],
    bbox: { x0: -6, y0: -3.4, x1: 6, y1: 3.4 },
    pins: [pin(1, 'A', -6, -2), pin(2, 'K', -6, 2), pin(3, 'E', 6, 2), pin(4, 'C', 6, -2)],
    showPinNumbers: true,
  }),
  // ブザー: KiCad の足形（Buzzer_12x9.5RM7.6）はシルクの + が 1 番なので、1 = +, 2 = −（KiCad 5 のシンボルとは逆）
  buzzer: () => ({
    graphics: [L(-2, -2, 0, -2), L(-2, 2, 0, 2), P('M0 -2.6 A2.6 2.6 0 0 1 0 2.6 Z'), T(-1, -2.4, '+', 1)],
    bbox: { x0: -2, y0: -2.8, x1: 2.8, y1: 2.8 },
    pins: [pin(1, '+', -2, -2), pin(2, '-', -2, 2)],
  }),
  // スピーカー（KiCad Speaker: 1・2。1 を +）
  speaker: () => ({
    graphics: [L(-4, 0, -2, 0), L(-4, 2, -2, 2), R(-2, -0.6, 0, 2.6), P('M0 -0.6 L2 -2.4 L2 4.4 L0 2.6 Z'), T(-3, -0.4, '+', 1)],
    bbox: { x0: -4, y0: -2.6, x1: 2.2, y1: 4.6 },
    pins: [pin(1, '+', -4, 0), pin(2, '-', -4, 2)],
  }),
  thermistor: () => ({
    ...twoPin(2.4, 4, [R(-2.4, -0.9, 2.4, 0.9), L(-2.4, 1.6, 1.6, -1.6), L(1.6, -1.6, 2.4, -1.6)]),
    pins: [pin(1, '~', -4, 0), pin(2, '~', 4, 0)],
  }),
  testpoint: () => ({
    graphics: [L(0, 2, 0, 0.8), C(0, 0, 0.8)],
    bbox: { x0: -1, y0: -1, x1: 1, y1: 2 },
    pins: [pin(1, '1', 0, 2)],
  }),
};

/** 信号源の丸（縦置き。1 = ＋ が上、2 = − が下） */
function source(inner, plusType) {
  return {
    graphics: [L(0, -4, 0, -2), L(0, 2, 0, 4), C(0, 0, 2), ...inner, T(1.4, -2.4, '+', 1)],
    bbox: { x0: -2.2, y0: -4, x1: 2.2, y1: 4 },
    pins: [pin(1, '+', 0, -4, plusType), pin(2, '-', 0, 4, 'passive')],
  };
}

/** ブリッジの中の小さなダイオード（(x,y) を中心に (dx,dy) の向き） */
function diodeMark(x, y, dx, dy) {
  const n = Math.hypot(dx, dy), ux = dx / n, uy = dy / n, px = -uy, py = ux, a = 0.45;
  const f = (v) => Math.round(v * 100) / 100;
  const tip = [x + ux * a, y + uy * a], b1 = [x - ux * a + px * a, y - uy * a + py * a], b2 = [x - ux * a - px * a, y - uy * a - py * a];
  return [P(`M${f(b1[0])} ${f(b1[1])} L${f(tip[0])} ${f(tip[1])} L${f(b2[0])} ${f(b2[1])} Z`, true), L(f(tip[0] + px * a), f(tip[1] + py * a), f(tip[0] - px * a), f(tip[1] - py * a))];
}

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
  // 0.13.3 で追加
  { kind: 'schottky', label: 'ショットキー', prefix: 'D', props: { value: 'SS34', footprint: 'D_SMA' } },
  { kind: 'tvs', label: 'TVS（双方向）', prefix: 'D', props: { value: 'SMBJ5.0CA', footprint: 'D_SMA' } },
  { kind: 'bridge', label: 'ブリッジダイオード', prefix: 'D', props: { value: 'MB10S', footprint: 'TO-269AA' } },
  { kind: 'regulator', label: '3端子レギュレータ', prefix: 'U', props: { value: 'AMS1117-3.3', footprint: 'SOT-223-3_TabPin2' } },
  { kind: 'transformer', label: 'トランス', prefix: 'T', props: { value: '100V:12V', footprint: '' } },
  { kind: 'fuse', label: 'ヒューズ', prefix: 'F', props: { value: '500mA', footprint: 'Fuse_1206' } },
  { kind: 'ferrite', label: 'フェライトビーズ', prefix: 'FB', props: { value: '600R@100MHz', footprint: 'L_0805' } },
  { kind: 'thermistor', label: 'サーミスタ（NTC）', prefix: 'TH', props: { value: '10k', footprint: 'R_0805' } },
  { kind: 'crystal', label: '水晶振動子', prefix: 'Y', props: { value: '12MHz', footprint: 'Crystal_SMD_3225-4Pin_3.2x2.5mm' } },
  { kind: 'relay', label: 'リレー', prefix: 'K', props: { value: 'SRD-05VDC-SL-C', footprint: 'Relay_SANYOU_SRD' } },
  { kind: 'optocoupler', label: 'フォトカプラ', prefix: 'U', props: { value: 'PC817', footprint: 'DIP-4' } },
  { kind: 'buzzer', label: 'ブザー', prefix: 'BZ', props: { value: 'Buzzer', footprint: 'Buzzer_12x9_5RM7_6' } },
  { kind: 'speaker', label: 'スピーカー', prefix: 'LS', props: { value: '8Ω', footprint: 'JST_PH_B2B-PH-K_1x02_P2.00mm' } },
  { kind: 'testpoint', label: 'テストポイント', prefix: 'TP', props: { value: 'TP', footprint: 'TestPoint_Pad_1.0x1.0mm' } },
  // シミュレーション用（基板・BOM に載らない。値は SPICE の書き方: DC 5 / AC 1 / SIN(…) / PULSE(…)）
  { kind: 'vac', label: '交流電源（シミュ）', prefix: 'V', props: { value: 'SIN(0 141 50) AC 1' }, virtual: true },
  { kind: 'vdc', label: '直流電源（シミュ）', prefix: 'V', props: { value: 'DC 5' }, virtual: true },
  { kind: 'isrc', label: '電流源（シミュ）', prefix: 'I', props: { value: 'DC 1m' }, virtual: true },
  { kind: 'power', label: '電源記号', prefix: '#PWR', props: { net: 'VCC' }, power: true },
  { kind: 'gnd', label: 'GND', prefix: '#PWR', props: { net: 'GND' }, power: true },
];

export const POWER_NETS = ['VCC', '+5V', '+3V3', '+12V', 'VBUS', 'GND'];

export function kindInfo(kind) { return KINDS.find((k) => k.kind === kind); }

/** 部品の一覧（下からのシート）の組。KINDS の電源記号以外は必ずどこかの組に入る（テストで確かめる） */
export const KIND_GROUPS = [
  { label: '受動部品', kinds: ['resistor', 'pot', 'capacitor', 'electrolytic', 'inductor', 'ferrite', 'thermistor', 'fuse', 'crystal', 'transformer'] },
  { label: 'ダイオード', kinds: ['diode', 'schottky', 'zener', 'tvs', 'led', 'bridge'] },
  { label: 'トランジスタ・IC', kinds: ['npn', 'pnp', 'nmos', 'pmos', 'opamp', 'regulator', 'optocoupler', 'ic'] },
  { label: '電源・入出力', kinds: ['battery', 'connector', 'switch', 'relay', 'buzzer', 'speaker', 'testpoint'] },
  { label: 'シミュレーション用（基板に載らない）', kinds: ['vac', 'vdc', 'isrc'] },
];

/** 基板・BOM に載らない（シミュレーション用の）部品か */
export const isVirtualKind = (kind) => !!kindInfo(kind)?.virtual;

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
