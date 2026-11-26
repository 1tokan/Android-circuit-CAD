// 0.13.3 で足した部品: シンボルのピン・足形・ネットリスト（シミュ用の信号源は基板に載らない）・シミュレーション
import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, KIND_GROUPS, getSymbol, isVirtualKind } from '../js/schematic/symbols.js';
import { getFootprint } from '../js/library/footprints.js';
import { projectFromSpec } from '../js/ai/spec.js';
import { generateNetlist } from '../js/netlist/netlist.js';
import { runSimulation } from '../js/sim/run.js';
import { runErc } from '../js/check/erc.js';

const P = (ref, kind, value, extra = {}) => ({ ref, kind, value, package: '', lcsc: '', mpn: '', description: '', pins: [], ...extra });

test('部品の種類: すべて一覧の組に入り、ピンは格子の上、既定の足形に同じ番号のパッドがある', () => {
  const kinds = KINDS.filter((k) => !k.power).map((k) => k.kind);
  assert.deepEqual([...kinds].sort(), KIND_GROUPS.flatMap((g) => g.kinds).sort());
  for (const k of ['vac', 'vdc', 'isrc', 'transformer', 'fuse', 'ferrite', 'crystal', 'schottky', 'tvs', 'bridge', 'regulator', 'relay', 'optocoupler', 'buzzer', 'speaker', 'thermistor', 'testpoint']) assert.ok(kinds.includes(k), k);
  for (const k of KINDS.filter((x) => !x.power)) {
    const sym = getSymbol({ kind: k.kind, props: { ...k.props } });
    for (const p of sym.pins) assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), `${k.kind}.${p.num}`);
    if (!k.props.footprint) continue;
    const fp = getFootprint(k.props.footprint);
    assert.ok(fp, `${k.kind}: ${k.props.footprint}`);
    const pads = new Set(fp.pads.map((p) => String(p.num)));
    for (const p of sym.pins) assert.ok(pads.has(p.num), `${k.kind}.${p.num} → ${fp.id}`);
  }
  // KiCad 公式と同じピンの役割（ブリッジ MB2S・PC817・SRD・AMS1117・水晶 GND24）
  const names = (kind) => Object.fromEntries(getSymbol({ kind, props: {} }).pins.map((p) => [p.num, p.name]));
  assert.deepEqual(names('bridge'), { 1: '~', 2: '~', 3: '+', 4: '-' });
  assert.deepEqual(names('optocoupler'), { 1: 'A', 2: 'K', 3: 'E', 4: 'C' });
  assert.deepEqual(names('relay'), { 1: 'COM', 2: '~', 3: 'NO', 4: 'NC', 5: '~' });
  assert.deepEqual(names('regulator'), { 1: 'GND', 2: 'VO', 3: 'VI' });
  assert.deepEqual(names('crystal'), { 1: '1', 2: 'GND', 3: '3', 4: 'GND' });
  assert.deepEqual(names('pot'), { 1: '1', 2: 'W', 3: '3' }); // 足形のワイパは 2 番
  assert.ok(isVirtualKind('vac') && !isVirtualKind('transformer'));
});

// 交流 100V 50Hz → トランス 100V:12V → ブリッジ → 1000µF → 100Ω
const SUPPLY = {
  title: 'AC 電源', summary: '', requirements: [], nc: [], notes: [],
  parts: [P('V1', 'vac', 'SIN(0 141 50) AC 1'), P('T1', 'transformer', '100V:12V'), P('D1', 'bridge', 'MB10S'),
    P('C1', 'electrolytic', '1000u'), P('R1', 'resistor', '100'), P('F1', 'fuse', '500mA')],
  nets: [
    { name: 'AC_L', pins: ['V1.1', 'F1.1'] }, { name: 'AC_F', pins: ['F1.2', 'T1.1'] }, { name: 'GND', pins: ['V1.2', 'T1.2'] },
    { name: 'SEC_A', pins: ['T1.4', 'D1.1'] }, { name: 'SEC_B', pins: ['T1.3', 'D1.2'] },
    { name: 'VRAW', pins: ['D1.3', 'C1.1', 'R1.1'] }, { name: 'VNEG', pins: ['D1.4', 'C1.2', 'R1.2'] },
  ],
};

test('シミュ用の信号源は基板・BOM に載らず、ネットリストの simSources に入る', () => {
  const { project } = projectFromSpec(SUPPLY);
  const nl = generateNetlist(project);
  assert.ok(!nl.components.some((c) => c.ref === 'V1'));
  assert.deepEqual(nl.simSources.map((s) => [s.ref, s.pins.map((p) => p.net).join(',')]), [['V1', 'AC_L,GND']]);
  assert.ok(nl.components.some((c) => c.ref === 'T1'));
  // トランスは足形が無いので、ネットリストはそれをはっきり言う（完成扱いにしない）
  assert.ok(nl.problems.some((p) => p.level === 'error' && /T1: フットプリント/.test(p.message)));
  assert.ok(!runErc(project).items?.some?.((i) => i.level === 'error' && /V1/.test(i.message)));
});

test('交流電源 → トランス → ブリッジ → 平滑: 2 次のピーク約 17V から 2 本分の順電圧を引いた値で落ち着く', async () => {
  const { project } = projectFromSpec(SUPPLY);
  project.sim = { analysis: { type: 'tran', tran: { tstep: '100u', tstop: '200m', tstart: '0', tmax: '100u' } }, sources: [], models: {}, lib: '', probes: [] };
  const r = await runSimulation(project);
  const i = r.names.indexOf('V(VRAW)'), j = r.names.indexOf('V(VNEG)');
  const vout = r.tran.y[i].map((v, k) => v - r.tran.y[j][k]);
  const last = vout.slice(Math.floor(vout.length * 0.8));
  const max = Math.max(...last), min = Math.min(...last);
  // 141V × 12/100 = 16.9V のピーク。ブリッジ 2 本 × 約 0.8V、巻線・ヒューズの電圧降下 → 14〜16V
  assert.ok(max > 14 && max < 16.5, `max ${max}`);
  // リプル: 100Ω・1000µF・100Hz → 約 1.5V 以下
  assert.ok(max - min > 0.3 && max - min < 2, `ripple ${max - min}`);
  assert.ok(r.rows.some((x) => x.ref === 'T1' && /トランス 1:0.12/.test(x.model)), JSON.stringify(r.rows.find((x) => x.ref === 'T1')));
});

test('直流電源（シミュ）と DC スイープ、電流源', async () => {
  const spec = { ...SUPPLY, parts: [P('V1', 'vdc', 'DC 5'), P('R1', 'resistor', '1k'), P('R2', 'resistor', '1k'), P('I1', 'isrc', 'DC 1m')],
    nets: [{ name: 'IN', pins: ['V1.1', 'R1.1'] }, { name: 'MID', pins: ['R1.2', 'R2.1', 'I1.2'] }, { name: 'GND', pins: ['V1.2', 'R2.2', 'I1.1'] }] };
  const { project } = projectFromSpec(spec);
  project.sim = { analysis: { type: 'op' }, sources: [], models: {}, lib: '', probes: [] };
  const r = await runSimulation(project);
  // 重ね合わせ: 5V の分圧 2.5V ＋ 1mA × 500Ω = 3.0V（電流源は 1→2 の向きに中を流れ、MID へ出る）
  const mid = r.op.values[r.names.indexOf('V(MID)')];
  assert.ok(Math.abs(mid - 3.0) < 1e-6, String(mid));
  project.sim.analysis = { type: 'dc', dc: { src: 'V1', start: '0', stop: '5', step: '1' } };
  const d = await runSimulation(project);
  assert.equal(d.dc.x.length, 6);
});

import { queryFor, packageOf, rankParts, partForComp, missingGroups, siblingsOf } from '../js/library/quickpick.js';

test('LCSC 品番の近道: 検索語・並べ方・割り当てる部品データ', () => {
  const comp = (kind, value, footprint, extra = {}) => ({ id: `${kind}${value}${footprint}${extra.id || ''}`, ref: extra.ref || 'X1', kind, props: { value, footprint, ...extra.props } });
  assert.equal(queryFor(comp('resistor', '10k', 'R_0805')), '10k 0805');
  assert.equal(queryFor(comp('capacitor', '100n', 'C_0603')), '100nF 0603');
  assert.equal(queryFor(comp('regulator', 'AMS1117-3.3', 'SOT-223-3_TabPin2')), 'AMS1117-3.3');
  assert.equal(queryFor(comp('crystal', '12MHz', 'Crystal_SMD_3225-4Pin_3.2x2.5mm')), '12MHz 3225');
  assert.equal(packageOf('TO-269AA'), 'MBS');
  const c = comp('resistor', '10k', 'R_0805');
  const parts = [
    { id: 'a', lcsc: 'C1', kind: 'resistor', value: '10k', package: '0603', jlc: { type: 'basic' }, stock: 100, price: [] },
    { id: 'b', lcsc: 'C2', kind: 'resistor', value: '10k', package: '0805', jlc: { type: 'extended' }, stock: 100, price: [] },
    { id: 'c', lcsc: 'C3', kind: 'resistor', value: '10k', package: '0805', jlc: { type: 'basic' }, stock: 0, price: [] },
    { id: 'd', lcsc: 'C4', kind: 'resistor', value: '10k', package: '0805', jlc: { type: 'basic' }, stock: 5000, price: [] },
    { id: 'e', lcsc: 'C5', kind: 'capacitor', value: '10u', package: '0805', jlc: { type: 'basic' }, stock: 5000, price: [] },
  ];
  // 同じ形・Basic・在庫あり が先頭。種別の違うもの・形の違うものは下
  assert.deepEqual(rankParts(parts, c).map((p) => p.lcsc), ['C4', 'C3', 'C2', 'C1', 'C5']);
  // 回路図の種別は変えない（サーミスタを抵抗として返されても）。足形が分からなければ今の足形
  const th = comp('thermistor', '10k', 'R_0805');
  const fitted = partForComp({ id: 'x', lcsc: 'C9', kind: 'resistor', footprint: '', package: '0805' }, th);
  assert.equal(fitted.kind, 'thermistor'); assert.equal(fitted.footprint, 'R_0805');
  // 品番の無い部品の組（実装しない・シミュ用・電源記号は除く）
  const sheet = { components: [comp('resistor', '10k', 'R_0805', { id: 1, ref: 'R1' }), comp('resistor', '10k', 'R_0805', { id: 2, ref: 'R2' }), comp('resistor', '1k', 'R_0805', { id: 3, ref: 'R3' }),
    comp('resistor', '10k', 'R_0805', { id: 4, ref: 'R4', props: { lcsc: 'C25804' } }), comp('resistor', '10k', 'R_0805', { id: 5, ref: 'R5', props: { dnp: true } }),
    { id: 'v', ref: 'V1', kind: 'vac', props: { value: 'AC 1' } }, { id: 'g', ref: '#PWR1', kind: 'gnd', props: { net: 'GND' } }] };
  assert.deepEqual(missingGroups(sheet).map((g) => g.map((x) => x.ref)), [['R1', 'R2'], ['R3']]);
  assert.deepEqual(siblingsOf(sheet, sheet.components[0]).map((x) => x.ref), ['R2', 'R5']);
});

import { Simulator } from '../js/sim/engine.js';
import { parseSpice, flatten, toCircuit, writeSpice } from '../js/sim/spice.js';
import { tieIsolated } from '../js/sim/circuit.js';
import { pickLcsc } from '../js/library/quickpick.js';

test('結合（K）: 巻数比と向き（点どうしが同じ向き）、誤りの検出、SPICE の読み書き', async () => {
  const deck = (k, l2 = 'L2') => `t\nV1 a 0 SIN(0 10 1k) AC 1\nR1 a p 1m\nL1 p 0 1\nL2 s 0 0.04\nRL s 0 1meg\nK1 L1 ${l2} ${k}\n.end`;
  const C = (t) => toCircuit(flatten(parseSpice(t)));
  // 1:0.2 の巻数比（L は巻数の 2 乗）→ 2 次の振幅は 2V。同じ向き（位相差 ≈ 0）
  const r = new Simulator(C(deck(0.9999))).ac([1000]);
  const i = r.names.indexOf('V(s)');
  assert.ok(Math.abs(Math.hypot(r.re[i][0], r.im[i][0]) - 0.2) < 2e-3, String(r.re[i][0]));
  assert.ok(r.re[i][0] > 0, '点どうしが同じ向き');
  const tr = await new Simulator(C(deck(0.9999))).tran(10e-6, 3e-3, { tmax: 10e-6 });
  const y = tr.y[tr.names.indexOf('V(s)')];
  assert.ok(Math.abs(Math.max(...y.slice(y.length / 2)) - 2) < 0.03, String(Math.max(...y)));
  assert.throws(() => new Simulator(C(deck(1.5))), /結合係数/);
  assert.throws(() => new Simulator(C(deck(0.99, 'LX'))), /LX がありません/);
  assert.throws(() => new Simulator(C(deck(0.99, 'L1'))), /同じインダクタ/);
  // 書き出し → 読み直しで同じ
  const again = parseSpice(writeSpice(C(deck(0.99))));
  const k = again.elements.find((e) => e.type === 'K');
  assert.deepEqual([k.l.map((x) => x.toUpperCase()), k.k], [['L1', 'L2'], 0.99]);
});

test('GND とつながらない部分だけ 1kΩ で結ぶ（容量だけでつながる所・オペアンプの出力は結ばない）', () => {
  const els = [
    { type: 'V', name: 'V1', n: ['a', '0'] }, { type: 'L', name: 'L1', n: ['a', '0'] }, { type: 'L', name: 'L2', n: ['s1', 's2'] }, { type: 'K', name: 'K1', n: [], l: ['L1', 'L2'], k: 0.99 },
    { type: 'R', name: 'R1', n: ['s1', 's2'] }, // 2 次側（磁気だけ）→ 結ぶ
    { type: 'C', name: 'C1', n: ['c1', '0'] }, { type: 'R', name: 'R2', n: ['c1', 'c2'] }, // 容量で GND へ → 結ばない
    { type: 'OA', name: 'U1', n: ['p', 'm', 'o'] }, { type: 'R', name: 'R3', n: ['o', 'm'] }, // 出力は中で GND 基準 → 結ばない
  ];
  const w = [];
  tieIsolated(els, w);
  const ties = els.filter((e) => e.name.startsWith('RTIE_'));
  assert.deepEqual(ties.map((e) => e.n), [['s1', '0']]);
  assert.equal(w.length, 1);
});

test('LCSC 品番の近道: 種別を合わせて変えた部品は、元の部品データを上書きしない（別の ID で保存）', async () => {
  const saved = { id: 'lcsc:C111', lcsc: 'C111', kind: 'ic', name: 'X', mpn: 'AMS1117-3.3', footprint: 'SOT-223-3_TabPin2', package: 'SOT-223', symbol: { kind: 'ic', pinCount: 4 }, pinMap: { 1: ['1'], 2: ['2', '4'], 3: ['3'] }, jlc: { type: 'basic' }, stock: 10, price: [] };
  const upserted = [];
  let assigned = null;
  const ctx = {
    lib: { search: () => ({ items: [saved] }), get: (id) => (id === saved.id ? saved : null), upsert: async (ps) => { upserted.push(...ps); return ps; } },
    online: { search: async () => ({ parts: [] }) },
    ui: { ask: async () => 'L:lcsc:C111', toast: () => {} },
    sheet: () => ({ components: [comp] }),
    assign: (keys, part) => { assigned = [keys, part]; },
  };
  const comp = { id: 'u1', ref: 'U1', kind: 'regulator', props: { value: 'AMS1117-3.3', footprint: 'SOT-223-3_TabPin2' } };
  globalThis.document = { querySelector: (s) => (s === '#dialog' ? { close() {} } : { querySelector: () => ({ addEventListener() {}, value: '', checked: false, innerHTML: '', querySelectorAll: () => [] }), querySelectorAll: () => [] }) };
  try { assert.equal(await pickLcsc(ctx, [comp]), 'ok'); } finally { delete globalThis.document; }
  assert.equal(upserted.length, 1);
  assert.notEqual(upserted[0].id, saved.id);
  assert.equal(upserted[0].kind, 'regulator');
  assert.equal(saved.pinMap[2].length, 2, '元の部品データはそのまま');
  assert.deepEqual(assigned[0], ['c:u1']);
});

import { readSourceForm, sourceFromSpice, sourceToSpice, sourceShort, sourceSummary } from '../js/sim/waveform.js';
import { regulatorVout } from '../js/sim/circuit.js';

/** 入力欄の代わり（name → 値） */
const fakeForm = (vals) => ({ querySelector: (sel) => { const n = sel.match(/name="([^"]+)"/)?.[1]; return n in vals ? { value: vals[n] } : null; } });

test('信号源の入力欄: 実効値・周波数から SIN を作る（ピークに直す）、必要な値が無ければことわる', () => {
  const r = readSourceForm(fakeForm({ w_type: 'sin', w_sin_vo: '', w_sin_amp: '100', w_sin_kind: 'rms', w_sin_freq: '60', w_sin_td: '', w_sin_theta: '', w_sin_phase: '', w_dc: '', w_acMag: '1', w_acPh: '' }));
  assert.deepEqual(r, { dc: '0', acMag: '1', acPh: '', wave: { type: 'sin', p: ['0', '141.421', '60'] } });
  assert.equal(sourceToSpice(r), 'DC 0 AC 1 SIN(0 141.421 60)');
  assert.equal(sourceShort(sourceToSpice(r), 'vac'), '100V 60Hz');
  const pk = readSourceForm(fakeForm({ w_type: 'sin', w_sin_amp: '5', w_sin_kind: 'peak', w_sin_freq: '1k', w_dc: '' }));
  assert.deepEqual(pk.wave.p, ['0', '5', '1k']);
  assert.match(readSourceForm(fakeForm({ w_type: 'sin', w_sin_amp: '100', w_sin_kind: 'rms', w_sin_freq: '', w_dc: '' })).error, /周波数/);
  assert.match(readSourceForm(fakeForm({ w_type: 'sin', w_sin_amp: 'abc', w_sin_kind: 'rms', w_sin_freq: '50', w_dc: '' })).error, /数として読めません/);
  // パルス: 途中の空欄は既定、後ろの空欄は省く
  const pu = readSourceForm(fakeForm({ w_type: 'pulse', w_pulse_v1: '0', w_pulse_v2: '5', w_pulse_td: '1m', w_pulse_tr: '', w_pulse_tf: '', w_pulse_pw: '5m', w_pulse_per: '', w_dc: '' }));
  assert.deepEqual(pu.wave.p, ['0', '5', '1m', '1u', '1u', '5m']);
  // 折れ線
  const pw = readSourceForm(fakeForm({ w_type: 'pwl', w_pwl: '0 0\n1m 5\n2m 5', w_dc: '' }));
  assert.deepEqual(pw.wave.p, ['0', '0', '1m', '5', '2m', '5']);
  // 古い書き方（SIN(0 141 50) AC 1）も読み直せる
  const old = sourceFromSpice('SIN(0 141 50) AC 1');
  assert.deepEqual([old.wave.type, old.wave.p, old.acMag], ['sin', ['0', '141', '50'], '1']);
  assert.match(sourceSummary(old), /実効値 99.7V（ピーク 141V）・50Hz/);
});

test('足りなかったモデル: レギュレータ（出力・落差）・フォトカプラ・水晶・リレー', async () => {
  assert.deepEqual(['AMS1117-3.3', '7805', 'L7812CV', 'AP2112K-3.3TRG1'].map(regulatorVout), [3.3, 5, 12, 3.3]);
  assert.ok(Number.isNaN(regulatorVout('LM317')));
  const mk = (parts, nets, analysis) => { const { project } = projectFromSpec({ ...SUPPLY, parts, nets }); project.sim = { analysis, sources: [], models: {}, lib: '', probes: [] }; return project; };
  const at = (r, name, t) => r.tran.y[r.names.indexOf(name)][r.tran.t.findIndex((x) => x >= t)];
  const reg = await runSimulation(mk([P('V1', 'vdc', 'DC 6 PWL(0 0 20m 6)'), P('U1', 'regulator', 'AMS1117-3.3'), P('C1', 'capacitor', '10u'), P('R1', 'resistor', '33')],
    [{ name: 'VIN', pins: ['V1.1', 'U1.3'] }, { name: 'VOUT', pins: ['U1.2', 'C1.1', 'R1.1'] }, { name: 'GND', pins: ['V1.2', 'U1.1', 'C1.2', 'R1.2'] }],
    { type: 'tran', tran: { tstep: '20u', tstop: '25m', tstart: '0', tmax: '20u' } }));
  const vin4 = at(reg, 'V(VOUT)', (4 / 6) * 20e-3);
  assert.ok(vin4 > 2.7 && vin4 < 3.0, `落差: 入力 4V で ${vin4}`);
  assert.ok(Math.abs(at(reg, 'V(VOUT)', 24e-3) - 3.3) < 0.01);
  assert.ok(Math.abs(at(reg, 'V(VOUT)', (5 / 6) * 20e-3) - 3.3) < 0.02, '入力 5V で 3.3V に収まる');
  const op = (r, n) => r.op.values[r.names.indexOf(n)];
  const opto = await runSimulation(mk([P('V1', 'vdc', 'DC 5'), P('R1', 'resistor', '1k'), P('U1', 'optocoupler', 'PC817'), P('R2', 'resistor', '10k')],
    [{ name: 'VCC', pins: ['V1.1', 'R1.1', 'R2.1'] }, { name: 'A', pins: ['R1.2', 'U1.1'] }, { name: 'C', pins: ['R2.2', 'U1.4'] }, { name: 'GND', pins: ['V1.2', 'U1.2', 'U1.3'] }], { type: 'op' }));
  assert.ok(op(opto, 'V(A)') > 1.1 && op(opto, 'V(A)') < 1.4 && op(opto, 'V(C)') < 0.2);
  const xt = await runSimulation(mk([P('V1', 'vac', 'DC 0 AC 1'), P('R1', 'resistor', '1k'), P('Y1', 'crystal', '12MHz')],
    [{ name: 'IN', pins: ['V1.1', 'R1.1'] }, { name: 'X', pins: ['R1.2', 'Y1.1'] }, { name: 'GND', pins: ['V1.2', 'Y1.3'] }], { type: 'ac', ac: { scale: 'lin', points: '201', fstart: '11.99Meg', fstop: '12.01Meg' } }));
  const i = xt.names.indexOf('V(X)'), mag = xt.ac.re[i].map((re, k) => Math.hypot(re, xt.ac.im[i][k]));
  assert.ok(Math.abs(xt.ac.f[mag.indexOf(Math.min(...mag))] - 12e6) < 200, '直列共振が 12MHz');
});

test('信号源の入力欄の見直し: 1M はメガにそろえる・指数の下がり始め・折れ線の時刻の順・AC なしの位相', async () => {
  const r = readSourceForm(fakeForm({ w_type: 'pulse', w_pulse_v1: '0', w_pulse_v2: '5', w_pulse_td: '', w_pulse_tr: '', w_pulse_tf: '', w_pulse_pw: '1M', w_pulse_per: '2Meg', w_dc: '', w_acMag: '', w_acPh: '30' }));
  assert.deepEqual(r.wave.p.slice(-2), ['1Meg', '2Meg']); // SPICE の M（ミリ）と取り違えない
  assert.equal(r.acPh, '');
  const e = readSourceForm(fakeForm({ w_type: 'exp', w_exp_v1: '0', w_exp_v2: '5', w_exp_td1: '1m', w_exp_tau1: '2m', w_exp_td2: '', w_exp_tau2: '3m', w_dc: '' }));
  assert.deepEqual(e.wave.p, ['0', '5', '1m', '2m', '3m', '3m']); // 下がり始め = 1m + 2m
  assert.match(readSourceForm(fakeForm({ w_type: 'pwl', w_pwl: '0 0\n2m 5\n1m 0', w_dc: '' })).error, /増えていく順/);
  // 回路図の信号源として計算すると、1Meg はメガ
  const { project } = projectFromSpec({ ...SUPPLY, parts: [P('V1', 'vdc', sourceToSpice(r)), P('R1', 'resistor', '1k')], nets: [{ name: 'A', pins: ['V1.1', 'R1.1'] }, { name: 'GND', pins: ['V1.2', 'R1.2'] }] });
  const { buildCircuit } = await import('../js/sim/circuit.js');
  const v1 = buildCircuit(project).circuit.elements.find((x) => x.name === 'V1');
  assert.equal(v1.wave.p[5], 1e6);
});

test('リレー（接点の状態・コイル）とレギュレータの設定（出力電圧の上書き・読めない型番はことわる）', async () => {
  const mk = (parts, nets, analysis, models = {}) => { const { project } = projectFromSpec({ ...SUPPLY, parts, nets }); project.sim = { analysis, sources: [], models: {}, lib: '', probes: [] }; for (const [ref, m] of Object.entries(models)) project.sim.models[project.schematic.sheets[0].components.find((c) => c.ref === ref).id] = m; return project; };
  const op = (r, n) => r.op.values[r.names.indexOf(n)];
  const parts = [P('V1', 'vdc', 'DC 5'), P('K1', 'relay', 'SRD-05VDC-SL-C'), P('R1', 'resistor', '1k'), P('R2', 'resistor', '1k')];
  const nets = [{ name: 'VCC', pins: ['V1.1', 'K1.5', 'K1.1'] }, { name: 'NO', pins: ['K1.3', 'R1.1'] }, { name: 'NC', pins: ['K1.4', 'R2.1'] }, { name: 'GND', pins: ['V1.2', 'K1.2', 'R1.2', 'R2.2'] }];
  const off = await runSimulation(mk(parts, nets, { type: 'op' }));
  assert.ok(op(off, 'V(NC)') > 4.99 && op(off, 'V(NO)') < 0.01);
  const on = await runSimulation(mk(parts, nets, { type: 'op' }, { K1: { mode: 'auto', params: { state: 'on', rcoil: '50' } } }));
  assert.ok(op(on, 'V(NO)') > 4.99 && op(on, 'V(NC)') < 0.01);
  assert.ok(Math.abs(-op(on, 'I(V1)') - (5 / 50 + 5 / 1000 / 1)) < 0.002, String(op(on, 'I(V1)'))); // コイル 50Ω ＋ NO 側 1k
  const rp = [P('V1', 'vdc', 'DC 12'), P('U1', 'regulator', 'MCP1700-3302E'), P('R1', 'resistor', '100')];
  const rn = [{ name: 'VIN', pins: ['V1.1', 'U1.3'] }, { name: 'VOUT', pins: ['U1.2', 'R1.1'] }, { name: 'GND', pins: ['V1.2', 'U1.1', 'R1.2'] }];
  const bad = await runSimulation(mk(rp, rn, { type: 'op' })).catch((e) => e);
  const rows = bad.rows || [];
  assert.ok(String(bad.message || '').includes('出力電圧') || rows.some((x) => x.ref === 'U1' && x.status === 'error'), '型番から読めない電圧はことわる');
  const ok = await runSimulation(mk(rp, rn, { type: 'op' }, { U1: { mode: 'auto', params: { vout: '3.3' } } }));
  assert.ok(Math.abs(op(ok, 'V(VOUT)') - 3.3) < 0.02, String(op(ok, 'V(VOUT)')));
});
