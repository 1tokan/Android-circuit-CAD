// 回路シミュレータ（js/sim）の試験
// 基準値は式で求まるもの（RC・利得）と、ngspice 42 で同じネットリストを計算した値（注記した所）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseValue, formatValue, spiceNum } from '../js/sim/units.js';
import { Simulator, freqList, sweepList, waveValue } from '../js/sim/engine.js';
import { parseSpice, flatten, toCircuit, writeSpice } from '../js/sim/spice.js';
import { buildCircuit, exportSpice } from '../js/sim/circuit.js';
import { runSimulation } from '../js/sim/run.js';
import { builtinFor } from '../js/sim/models.js';
import { measure, fft, valueAt } from '../js/sim/plot.js';

const deck = (text) => new Simulator(toCircuit(flatten(parseSpice(text))));
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-12), `${msg}: ${a} と ${b}（許容 ${rel * 100}%）`);
const sig = (r, n) => r.names.indexOf(n);

test('値の読み書き（SI の M はメガ、SPICE の M はミリ）', () => {
  assert.equal(parseValue('4k7'), 4700);
  near(parseValue('2u2'), 2.2e-6, 1e-12, '2u2');
  near(parseValue('100nF'), 1e-7, 1e-12, '100nF');
  assert.equal(parseValue('1M'), 1e6);
  assert.equal(parseValue('1M', { spice: true }), 1e-3);
  assert.equal(parseValue('1Meg', { spice: true }), 1e6);
  assert.equal(parseValue('3V3'), 3.3);
  assert.ok(Number.isNaN(parseValue('abc')));
  assert.equal(formatValue(4700, 'Ω'), '4.7kΩ');
  assert.equal(spiceNum(2.2e-6), '2.2u');
  assert.equal(spiceNum(1e6), '1Meg');
});

test('RC 回路: 過渡（時定数）と AC（遮断周波数・位相）が式どおり', async () => {
  const s = deck('rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2) AC 1\nR1 in out 1k\nC1 out 0 1u\n.end');
  const r = await s.tran(10e-6, 5e-3);
  const i = sig(r, 'V(out)');
  for (const t of [1e-3, 2e-3, 3e-3]) near(valueAt(r.t, r.y[i], t), 1 - Math.exp(-t / 1e-3), 2e-3, `v(out) @${t}`);
  const fc = 1 / (2 * Math.PI * 1e-3);
  const a = s.ac([fc]);
  const k = sig(a, 'V(out)');
  near(Math.hypot(a.re[k][0], a.im[k][0]), Math.SQRT1_2, 1e-6, '|H(fc)|');
  near((Math.atan2(a.im[k][0], a.re[k][0]) * 180) / Math.PI, -45, 1e-6, '位相');
});

test('バイポーラの動作点が ngspice と一致（2N3904 の CE 回路。ngspice 42: v(b)=2.078686 v(c)=5.408267 v(e)=1.405720）', () => {
  const s = deck('ce\nVCC vcc 0 12\nR1 vcc b 47k\nR2 b 0 10k\nRC vcc c 4.7k\nRE e 0 1k\nQ1 c b e Q2N3904\n.model Q2N3904 NPN(IS=6.734f BF=416.4 BR=0.7371 NF=1 NR=1 VAF=74.03)\n.end');
  const r = s.op();
  near(r.values[sig(r, 'V(b)')], 2.078686, 2e-5, 'v(b)');
  near(r.values[sig(r, 'V(c)')], 5.408267, 2e-5, 'v(c)');
  near(r.values[sig(r, 'V(e)')], 1.405720, 2e-5, 'v(e)');
});

test('ダイオード: 順方向の電流がショックレーの式どおり、逆向きの降伏（ツェナー）', () => {
  const s = deck('d\nV1 a 0 0.6\nD1 a 0 DX\n.model DX D(IS=1e-14 N=1)\n.end');
  const r = s.op();
  const vt = 8.617333262e-5 * 300.15;
  near(-r.values[sig(r, 'I(V1)')], 1e-14 * (Math.exp(0.6 / vt) - 1), 1e-4, 'Id');
  const z = deck('z\nV1 in 0 12\nR1 in k 1k\nD1 0 k DZ\n.model DZ D(IS=1e-14 BV=5.1 IBV=5m NBV=1.5)\n.end').op();
  const vk = z.values[sig(z, 'V(k)')];
  assert.ok(vk > 5.0 && vk < 5.4, `ツェナー電圧 ${vk}`);
});

test('MOSFET レベル 1: オン抵抗と、P チャネルのゆっくり立ち上げ（ngspice 42 と比べた回路）', async () => {
  const s = deck('n\nVG g 0 4.5\nVD d 0 0.1\nM1 d g 0 0 NX W=1 L=1\n.model NX NMOS(LEVEL=1 VTO=1.05 KP=10.3)\n.end');
  const r = s.op();
  const id = -r.values[sig(r, 'I(VD)')];
  near(0.1 / id, 1 / (10.3 * (4.5 - 1.05 - 0.05)), 1e-3, 'Rds（線形領域）');
  // サンプルと同じ形の突入電流の制限（ngspice 42 で t(4.5V) = 9.91ms・電流の最大 約 60mA）
  const p = deck(`ss\nVBUS vbus 0 PULSE(0 5 0 100u 1m 1 2)\nM1 out g vbus vbus PX W=1 L=1\nC40 vbus g 4.7u\nR15 g 0 100k\nC39 g out 100n\nCL out 0 47u\nRL out 0 100\n.model PX PMOS(LEVEL=1 VTO=-0.9 KP=6.3 LAMBDA=0.01 CGSO=600p CGDO=60p)\n.end`);
  const t = await p.tran(100e-6, 200e-3);
  const v = t.y[sig(t, 'V(out)')];
  assert.ok(v[v.length - 1] > 4.9, `最後の電圧 ${v[v.length - 1]}`);
  const i45 = t.t[v.findIndex((x) => x >= 4.5)];
  assert.ok(i45 > 5e-3 && i45 < 200e-3, `4.5V までの時間 ${i45}`);
});

test('オペアンプ: 非反転増幅の利得・GBW・電源での飽和', async () => {
  const OA = { A: 1e5, GBW: 1e6, ROUT: 10, VOH: 1.5, VOL: 0.05 };
  const circ = (vin) => ({ nodes: ['0'], elements: [
    { type: 'V', name: 'VCC', n: ['vcc', '0'], dc: 5 },
    { type: 'V', name: 'VIN', n: ['in', '0'], dc: vin, ac: { mag: 1, ph: 0 } },
    { type: 'R', name: 'R1', n: ['out', 'fb'], value: 9e3 }, { type: 'R', name: 'R2', n: ['fb', '0'], value: 1e3 },
    { type: 'OA', name: 'U1', n: ['in', 'fb', 'out', 'vcc', '0'], model: OA }] });
  const fix = (c) => { const nodes = ['0']; for (const e of c.elements) for (const n of e.n) if (!nodes.includes(n)) nodes.push(n); return { ...c, nodes }; };
  const s = new Simulator(fix(circ(0.2)));
  const op = s.op();
  near(op.values[sig(op, 'V(out)')], 2.0, 1e-3, '利得 10');
  const ac = s.ac([10, 100e3]);
  const k = sig(ac, 'V(out)');
  near(Math.hypot(ac.re[k][0], ac.im[k][0]), 10, 1e-3, '低い周波数の利得');
  near(Math.hypot(ac.re[k][1], ac.im[k][1]), 10 / Math.SQRT2, 0.02, 'GBW/利得 = 100kHz で −3dB');
  const sat = new Simulator(fix(circ(0.6))).op();
  near(sat.values[sig(sat, 'V(out)')], 3.5, 0.01, '電源 5V − 1.5V で飽和');
});

test('直流スイープ・周波数の並び・波形', () => {
  const s = deck('dc\nV1 a 0 0\nR1 a b 1k\nR2 b 0 1k\n.end');
  const r = s.dc('V1', sweepList(0, 2, 0.5));
  assert.deepEqual(r.x, [0, 0.5, 1, 1.5, 2]);
  r.y[sig(r, 'V(b)')].forEach((v, i) => near(v, r.x[i] / 2, 1e-9, '分圧'));
  const f = freqList('dec', 10, 10, 1e3);
  assert.equal(f.length, 21);
  near(f[10], 100, 1e-9, '10 倍ごと');
  assert.equal(waveValue({ wave: { type: 'pulse', p: [0, 5, 1, 1, 1, 2, 10] } }, 2.5), 5);
  near(waveValue({ wave: { type: 'sin', p: [1, 2, 1] } }, 0.25), 3, 1e-9, 'SIN');
  near(waveValue({ wave: { type: 'pwl', p: [0, 0, 1, 10] } }, 0.3), 3, 1e-9, 'PWL');
});

test('SPICE の読み書き: 書いたネットリストを読み直すと同じ結果。サブ回路を展開できる', () => {
  const src = 'x\nV1 in 0 DC 1\nX1 in out DIV\n.subckt DIV a b\nR1 a b 1k\nR2 b 0 3k\n.ends\n.end';
  const els = flatten(parseSpice(src));
  assert.deepEqual(els.map((e) => e.name), ['V1', 'X1.R1', 'X1.R2']);
  const r1 = new Simulator(toCircuit(els)).op();
  near(r1.values[sig(r1, 'V(out)')], 0.75, 1e-9, '分圧');
  const text = writeSpice(toCircuit(els));
  const r2 = new Simulator(toCircuit(flatten(parseSpice(text)))).op();
  near(r2.values[sig(r2, 'V(out)')], 0.75, 1e-9, '読み直し');
  assert.throws(() => parseSpice('t\nB1 a 0 V=1\n.end'), /扱えません/);
});

test('測定と FFT: 正弦波の振幅・実効値・周波数', () => {
  const t = [], y = [];
  for (let i = 0; i <= 4000; i++) { t.push(i * 1e-5); y.push(2 * Math.sin(2 * Math.PI * 1000 * i * 1e-5)); }
  const m = measure(t, y);
  near(m.pp, 4, 1e-3, 'P-P'); near(m.rms, 2 / Math.SQRT2, 2e-3, '実効値'); near(m.freq, 1000, 2e-3, '周波数');
  const f = fft(t, y, { n: 4096 });
  let k = 1; f.mag.forEach((v, i) => { if (i && v > f.mag[k]) k = i; });
  near(f.f[k], 1000, 0.03, 'FFT のピークの周波数');
  near(f.mag[k], 2, 0.1, 'FFT の振幅');
});

test('内蔵モデル: 型番から選び、種類の違うものは使わない', () => {
  assert.equal(builtinFor('pmos', 'AO3401A').key, 'AO3401A');
  assert.equal(builtinFor('npn', 'MMBT3906').key, 'GENERIC_NPN'); // PNP の型番を NPN には使わない
  assert.equal(builtinFor('led', 'Red').key, 'RED');
  assert.equal(builtinFor('opamp', 'LM358').key, 'LM358');
});

test('サンプル: 突入電流の制限（Q1 AO3401A）を回路図から計算できる（ngspice 42 で t(4.5V)=99.10ms・最大 104.7mA）', async () => {
  const prj = JSON.parse(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
  prj.sim = {
    analysis: { type: 'tran', tran: { tstep: '100u', tstop: '300m' } },
    sources: [{ name: 'VBUS_IN', type: 'V', pos: 'VBUS', neg: 'GND', dc: '0', wave: { type: 'pulse', p: ['0', '5', '1m', '100u', '1m', '1', '2'] } }],
  };
  const b = buildCircuit(prj);
  assert.ok(b.rows.find((r) => r.ref === 'Q1').model.includes('AO3401A'));
  assert.equal(b.rows.find((r) => r.ref === 'U4').status, 'off');
  const r = await runSimulation(prj);
  const v = r.tran.y[sig(r, 'V(+5V_SYS)')], i = r.tran.y[sig(r, 'I(VBUS_IN)')];
  near(r.tran.t[v.findIndex((x) => x >= 4.5)], 0.09910, 0.01, '4.5V になる時刻');
  near(Math.max(...i.map((x) => -x)), 0.10472, 0.02, '突入電流の最大');
  const cir = exportSpice(prj);
  assert.match(cir, /^\.tran 100u 300m/m);
  assert.match(cir, /^\.options rshunt=1e12$/m);
  assert.match(cir, /^\.model MMOD\d+ PMOS\(LEVEL=1 VTO=-900m/m);
});

test('単位: SI の大文字 F はファラド、SPICE の f はフェムト。1MEG は書き出しで壊れない', () => {
  assert.equal(parseValue('1F'), 1);
  assert.equal(parseValue('0.1F'), 0.1);
  assert.ok(Math.abs(parseValue('10fF') - 1e-14) < 1e-20);
  assert.equal(parseValue('1f', { spice: true }), 1e-15);
  assert.equal(parseValue('1MEG'), 1e6);
});
