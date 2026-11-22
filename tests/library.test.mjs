// node --test tests/library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { listFootprints, getFootprint, padNumbers, normalizeFootprint } from '../js/library/footprints.js';
import {
  BUILTIN_PARTS, normalizePart, partSymbol, effectivePinMap, checkPinMap, searchParts, normalizeValue,
  guessKind, guessFootprint, unitPrice, lcscUrl, PartFormatError, pinCountFromPackage,
} from '../js/library/parts.js';
import { parseCSV, importCSV, importJSON, exportLibraryJSON, parsePrice, valueFromDescription } from '../js/library/importer.js';
import { generateNetlist, netlistStatus, formatNetlistText, sourceHash } from '../js/netlist/netlist.js';
import { createProject } from '../js/core/project.js';
import { addComponent, addWirePath, addLabel } from '../js/schematic/model.js';

// ---------------- フットプリント ----------------
test('全フットプリント: パッド寸法が正、THTの穴径がパッドより小さい、IDが一意', () => {
  const ids = new Set();
  for (const fp of listFootprints()) {
    assert.ok(!ids.has(fp.id), fp.id); ids.add(fp.id);
    assert.ok(fp.pads.length >= 1, fp.id);
    for (const p of fp.pads) {
      assert.ok(p.w > 0 && p.h > 0, `${fp.id} pad ${p.num}`);
      if (p.type === 'tht') assert.ok(p.drill > 0 && p.drill < Math.min(p.w, p.h), `${fp.id} drill`);
    }
    assert.ok(fp.courtyard.x0 < fp.courtyard.x1 && fp.courtyard.y0 < fp.courtyard.y1);
    assert.equal(fp.verified, false, '第6段階で照合するまで未照合');
  }
});

test('SOIC-8: 1番ピンが左上、反時計回りの番号、ピッチ1.27mm', () => {
  const fp = getFootprint('SOIC-8');
  const pad = (n) => fp.pads.find((p) => p.num === String(n));
  assert.ok(pad(1).x < 0 && pad(1).y < 0, '1番は左上');
  assert.ok(pad(4).x < 0 && pad(4).y > 0, '4番は左下');
  assert.ok(pad(5).x > 0 && pad(5).y > 0, '5番は右下');
  assert.ok(pad(8).x > 0 && pad(8).y < 0, '8番は右上');
  assert.equal(Math.round((pad(2).y - pad(1).y) * 1000), 1270);
  assert.equal(pad(1).y, pad(8).y);
  assert.deepEqual(padNumbers(fp), ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('チップ部品は原点対称、SOT-223のタブはパッド2と同番号', () => {
  for (const id of ['R_0402', 'R_0603', 'R_0805', 'R_1206', 'C_0805', 'LED_0805']) {
    const [a, b] = getFootprint(id).pads;
    assert.equal(a.x, -b.x, id); assert.equal(a.y, 0);
  }
  const sot = getFootprint('SOT-223-3_TabPin2');
  assert.equal(sot.pads.filter((p) => p.num === '2').length, 2);
  assert.deepEqual(padNumbers(sot), ['1', '2', '3']);
});

test('第2段階の仮フットプリント名も解決できる', () => {
  assert.equal(getFootprint('SW_SPST_6x6').id, 'SW_PUSH_6mm');
  assert.equal(getFootprint('PinHeader_1x02_P2.54mm').pads.length, 2);
  assert.equal(getFootprint('なし'), null);
});

test('ユーザー定義フットプリントの検証', () => {
  const ok = normalizeFootprint({ id: 'MY_FP', pads: [{ num: 1, x: 0, y: 0, w: 1, h: 1 }, { num: 2, x: 2, y: 0, w: 1.6, drill: 0.8 }] });
  assert.equal(ok.pads[1].type, 'tht');
  assert.throws(() => normalizeFootprint({ id: 'X', pads: [{ num: 1, x: 0, y: 0, w: 1, drill: 1.2 }] }), /穴径/);
  assert.throws(() => normalizeFootprint({ id: 'X', pads: [{ num: 1, x: 'a', y: 0, w: 1 }] }), /数値/);
  assert.throws(() => normalizeFootprint({ id: 'X', pads: [] }), /pads/);
});

// ---------------- 部品とピン↔パッド対応 ----------------
test('内蔵部品は全てピン↔パッド対応にエラーがない', () => {
  for (const p of BUILTIN_PARTS) {
    const fp = getFootprint(p.footprint);
    assert.ok(fp, `${p.name}: footprint ${p.footprint}`);
    const r = checkPinMap(partSymbol(p), fp, effectivePinMap(partSymbol(p), fp, p.pinMap));
    assert.deepEqual(r.errors, [], p.name);
  }
});

test('LM358(Aユニット)はBユニットのパッド5,6,7が未接続の警告、AMS1117はピン4が未使用ピン', () => {
  const lm = BUILTIN_PARTS.find((p) => p.mpn === 'LM358DR');
  const fp = getFootprint(lm.footprint);
  const r = checkPinMap(partSymbol(lm), fp, effectivePinMap(partSymbol(lm), fp, lm.pinMap));
  assert.deepEqual(r.warnings.map((w) => w.match(/パッド(\d)/)?.[1]).filter(Boolean), ['5', '6', '7']);
  const ams = BUILTIN_PARTS.find((p) => p.mpn === 'AMS1117-3.3');
  const fa = getFootprint(ams.footprint);
  const pm = effectivePinMap(partSymbol(ams), fa, ams.pinMap);
  assert.ok(pm.nc.has('4'));
  assert.deepEqual(pm.map['2'], ['2']);
  assert.deepEqual(checkPinMap(partSymbol(ams), fa, pm).errors, []);
});

test('ピン↔パッド対応の誤りを検出', () => {
  const p = normalizePart({ name: 'X', kind: 'npn', footprint: 'SOT-23', pinMap: { 1: ['1'], 2: ['1'], 3: ['9'] } });
  const fp = getFootprint('SOT-23');
  const r = checkPinMap(partSymbol(p), fp, effectivePinMap(partSymbol(p), fp, p.pinMap));
  assert.ok(r.errors.some((e) => /パッド9/.test(e)));
  assert.ok(r.errors.some((e) => /重複/.test(e)));
  const none = checkPinMap(partSymbol(p), null, effectivePinMap(partSymbol(p), null, null));
  assert.match(none.errors[0], /フットプリント/);
});

test('部品データの検証', () => {
  assert.throws(() => normalizePart({ name: 'x', kind: 'resistor', lcsc: 'X123' }), PartFormatError);
  assert.throws(() => normalizePart({ name: 'x', kind: 'gnd' }), /シンボル種別/);
  assert.throws(() => normalizePart({ kind: 'resistor' }), /名称/);
  assert.equal(normalizePart({ name: 'x', kind: 'resistor', lcsc: '17414' }).lcsc, 'C17414');
  assert.equal(normalizePart({ name: 'x', kind: 'resistor', lcsc: 'c17414' }).id, 'lcsc:C17414');
  assert.equal(normalizePart({ name: 'x', kind: 'resistor', datasheet: 'javascript:alert(1)' }).datasheet, '');
  assert.equal(lcscUrl('C1525'), 'https://www.lcsc.com/product-detail/C1525.html');
});

test('値の表記ゆれ吸収と検索', () => {
  assert.equal(normalizeValue('0.1uF'), '100n');
  assert.equal(normalizeValue('100nF'), '100n');
  assert.equal(normalizeValue('10KΩ'), '10k');
  assert.equal(normalizeValue('4.7k'), '4.7k');
  assert.equal(normalizeValue('1000'), '1k');
  const r = searchParts(BUILTIN_PARTS, '0.1uF 0402');
  assert.equal(r.items[0].lcsc, 'C1525');
  assert.equal(searchParts(BUILTIN_PARTS, 'C1525').items[0].lcsc, 'C1525');
  assert.equal(searchParts(BUILTIN_PARTS, '', { kind: 'nmos' }).items.length, 1);
  assert.equal(searchParts(BUILTIN_PARTS, 'ao3400').items[0].mpn, 'AO3400A');
  assert.ok(searchParts(BUILTIN_PARTS, '', { jlcType: 'basic' }).items.every((p) => p.jlc.type === 'basic'));
  assert.equal(searchParts(BUILTIN_PARTS, 'zzzz').total, 0);
});

test('ICの説明文を他の部品と取り違えない（USB・switch・controlled など）', () => {
  const cases = {
    'SOIC-8 Operational Amplifier ROHS': 'opamp',
    '2.4GHz 21dBm 340mA 3V~3.6V 88mA SPI、USB、UART': 'ic',
    'USB to UART converter SOP-16 USB Converters ROHS': 'ic',
    'Current limited power switch SOIC-8 Power Distribution Switches': 'ic',
    'Charge controlled Li-ion battery charger IC ESOP-8': 'ic',
    'Bluetooth、WiFi DMA': 'ic',
    'USB Type-C Receptacle 16P Connectors': 'connector',
    'Tactile Switches 6x6': 'switch',
    '0603 Red Light Emitting Diodes (LED)': 'led',
    'Zener Diodes 5.1V': 'zener',
    'PNP Bipolar Transistors SOT-23': 'pnp',
    'P-Channel MOSFET -30V SOT-23': 'pmos',
  };
  for (const [d, k] of Object.entries(cases)) assert.equal(guessKind(d), k, d);
});

test('パッケージ名からピン数（露出パッド・タブを含む）', () => {
  const cases = { 'SOIC-8': 8, 'QFN-56-EP(7x7)': 57, 'QFN-56(7x7)': 56, 'SOT-223': 4, 'SOT-23-5': 5, 'SOT-23': 3, 'TSSOP-20': 20, 'LQFP-48(7x7)': 48, '0603': null, '5050': null };
  for (const [p, n] of Object.entries(cases)) assert.equal(pinCountFromPackage(p), n, p);
});

test('汎用ICシンボルは奇数ピンも作れて、番号は反時計回り', () => {
  const sym = partSymbol(normalizePart({ name: 'x', kind: 'ic', symbol: { kind: 'ic', pinCount: 57 } }));
  assert.equal(sym.pins.length, 57);
  const pin = (n) => sym.pins.find((p) => p.num === String(n));
  assert.ok(pin(1).x < 0 && pin(29).x < 0 && pin(30).x > 0 && pin(57).x > 0);
  assert.equal(pin(1).y, pin(57).y, '1番と57番が同じ高さ（左上と右上）');
  assert.ok(pin(29).y > pin(1).y);
});

test('種別・フットプリントの推定', () => {
  assert.equal(guessKind('Resistors / Chip Resistor - Surface Mount'), 'resistor');
  assert.equal(guessKind('Multilayer Ceramic Capacitors MLCC'), 'capacitor');
  assert.equal(guessKind('Aluminum Electrolytic Capacitors'), 'electrolytic');
  assert.equal(guessKind('Light Emitting Diodes (LED)'), 'led');
  assert.equal(guessKind('Schottky Barrier Diodes'), 'diode');
  assert.equal(guessKind('MOSFETs N-Channel'), 'nmos');
  assert.equal(guessKind('Linear Voltage Regulators (LDO)'), 'ic');
  assert.equal(guessFootprint('resistor', '0603'), 'R_0603');
  assert.equal(guessFootprint('capacitor', 'C0805'), 'C_0805');
  assert.equal(guessFootprint('ic', 'SOT-23-5'), 'SOT-23-5');
  assert.equal(guessFootprint('ic', 'SOIC-8'), 'SOIC-8');
  assert.equal(guessFootprint('ic', 'QFN-56'), '', '本体寸法の無いQFNは生成しない');
  assert.equal(guessFootprint('ic', 'QFN-56-EP(7x7)'), 'PKG:ic:QFN-56-EP(7x7)');
});

// ---------------- CSV / JSON 取込 ----------------
test('CSVパーサ: 引用符・セル内改行・BOM・タブ区切り', () => {
  const rows = parseCSV('﻿a,b,c\n1,"x,y","line1\nline2"\n2,"say ""hi""",\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', 'line1\nline2'], ['2', 'say "hi"', '']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('価格表記の解析', () => {
  assert.deepEqual(parsePrice('1-199:0.0029,200-:0.0015'), [{ qty: 1, usd: 0.0029 }, { qty: 200, usd: 0.0015 }]);
  assert.deepEqual(parsePrice('$0.12'), [{ qty: 1, usd: 0.12 }]);
  assert.deepEqual(parsePrice('[{"qFrom":1,"qTo":9,"price":0.5},{"qFrom":10,"price":0.4}]'), [{ qty: 1, usd: 0.5 }, { qty: 10, usd: 0.4 }]);
  assert.deepEqual(parsePrice(''), []);
  const p = normalizePart({ name: 'x', kind: 'resistor', price: parsePrice('1-199:0.0029,200-:0.0015') });
  assert.equal(unitPrice(p, 1), 0.0029);
  assert.equal(unitPrice(p, 500), 0.0015);
});

test('説明文から値を取り出す', () => {
  assert.equal(valueFromDescription('resistor', '10kΩ ±1% 125mW 0805 Chip Resistor'), '10k');
  assert.equal(valueFromDescription('capacitor', '100nF 16V X7R ±10% 0402 MLCC'), '100n');
  assert.equal(valueFromDescription('inductor', '4.7uH ±20% 0805 Inductor'), '4.7u');
});

test('JLCPCB形式のCSV取込: 列名の表記ゆれ、種別・フットプリント推定、不正行のスキップ', () => {
  const csv = [
    'LCSC Part,First Category,Second Category,MFR.Part,Package,Solder Joint,Manufacturer,Library Type,Description,Datasheet,Price,Stock',
    'C1525,Capacitors,Multilayer Ceramic Capacitors MLCC - SMD/SMT,CL05B104KO5NNNC,0402,2,Samsung Electro-Mechanics,Basic,"100nF 16V X7R ±10% 0402 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS",https://example.com/c1525.pdf,"1-199:0.0011,200-:0.0005",19000000',
    'C25804,Resistors,Chip Resistor - Surface Mount,0603WAF1002T5E,0603,2,UNI-ROYAL,Basic,"10kΩ ±1% 100mW 0603 Chip Resistor",,0.0005,"12,345"',
    'C6186,Power Management ICs,Linear Voltage Regulators (LDO),AMS1117-3.3,SOT-223,4,Advanced Monolithic Systems,Basic,"1A 3.3V LDO",,0.06,500',
    'BAD1,Resistors,Chip,X,0603,2,Y,Basic,desc,,,',
    'C1525,Capacitors,dup,CL05B104KO5NNNC,0402,2,Samsung,Basic,dup,,,',
  ].join('\n');
  const r = importCSV(csv, { now: '2026-11-22T00:00:00Z' });
  assert.equal(r.parts.length, 3);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].reason, /LCSC品番/);
  assert.match(r.skipped[1].reason, /重複/);
  const [cap, res, ldo] = r.parts;
  assert.equal(cap.kind, 'capacitor'); assert.equal(cap.footprint, 'C_0402'); assert.equal(cap.value, '100n');
  assert.equal(cap.jlc.type, 'basic'); assert.equal(cap.stock, 19000000); assert.equal(cap.price.length, 2);
  assert.equal(res.kind, 'resistor'); assert.equal(res.footprint, 'R_0603'); assert.equal(res.value, '10k'); assert.equal(res.stock, 12345);
  assert.equal(ldo.kind, 'ic'); assert.equal(ldo.footprint, 'SOT-223-3_TabPin2');
  assert.equal(r.columns.lcsc, 'LCSC Part');
  assert.equal(r.columns.mpn, 'MFR.Part');
});

test('jlcparts形式（basic/preferred列）とユーザーCSV（日本語見出し）', () => {
  const a = importCSV('lcsc,mfr,package,manufacturer,basic,preferred,description,stock\n17414,0805W8F1002T5E,0805,UNI-ROYAL,0,1,10kΩ Chip Resistor,100');
  assert.equal(a.parts[0].lcsc, 'C17414');
  assert.equal(a.parts[0].jlc.type, 'preferred');
  assert.equal(a.parts[0].mpn, '0805W8F1002T5E');
  const b = importCSV('部品名称,LCSC品番,パッケージ,シンボル,フットプリント\n自作LED,C2286,0805,led,LED_0805');
  assert.equal(b.parts[0].kind, 'led');
  assert.equal(b.parts[0].footprint, 'LED_0805');
  assert.throws(() => importCSV('foo,bar\n1,2'), /必要/);
});

test('JSONの書き出し→取込で一致', () => {
  const out = exportLibraryJSON(BUILTIN_PARTS.slice(0, 3));
  const r = importJSON(out);
  assert.deepEqual(r.parts.map((p) => p.id), BUILTIN_PARTS.slice(0, 3).map((p) => p.id));
  assert.throws(() => importJSON('{"x":1}'), /部品ライブラリ/);
});

// ---------------- ネットリスト ----------------
function projectA() {
  // テストA: 電池(JST) - R(330Ω) - LED - GND
  const prj = createProject('A');
  const sh = prj.schematic.sheets[0];
  const parts = {
    r: BUILTIN_PARTS.find((p) => p.name.startsWith('抵抗 330Ω')),
    led: BUILTIN_PARTS.find((p) => p.name === 'LED 赤 0805'),
    j: BUILTIN_PARTS.find((p) => p.name.startsWith('JST PH 2ピン')),
  };
  prj.library.parts.push(...Object.values(parts));
  const place = (part, x, y) => addComponent(sh, part.kind, x, y, { partId: part.id, value: part.value, footprint: part.footprint, pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames });
  const j = place(parts.j, -10, 0);     // コネクタ: ピン1 (-14,-1), ピン2 (-14,1)
  const r = place(parts.r, 4, -10);     // ピン1 (0,-10), ピン2 (8,-10)
  const d = place(parts.led, 14, -10);  // A=2 (11,-10), K=1 (17,-10)
  const g = addComponent(sh, 'gnd', -20, 10);
  g.props.net = 'GND';
  addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
  addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
  addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
  addLabel(sh, 20, 6, 'GND');
  addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  return { prj, j, r, d };
}

test('ネットリスト（テストA）: パッド単位の接続、GND名、LEDの向き（A=パッド2,K=パッド1）', () => {
  const { prj } = projectA();
  const nl = generateNetlist(prj, { now: 'T' });
  assert.equal(nl.summary.components, 3, '電源記号は部品に含めない');
  assert.equal(nl.summary.errors, 0, JSON.stringify(nl.problems));
  const byName = Object.fromEntries(nl.nets.map((n) => [n.name, n.nodes.map((x) => `${x.ref}-${x.pad}`)]));
  assert.deepEqual(byName.GND, ['D1-1', 'J1-2']);
  const others = nl.nets.filter((n) => n.name !== 'GND').map((n) => n.nodes.map((x) => `${x.ref}-${x.pad}`));
  assert.deepEqual(others.sort(), [['D1-2', 'R1-2'], ['J1-1', 'R1-1']].sort());
  const d1 = nl.components.find((c) => c.ref === 'D1');
  assert.equal(d1.footprint, 'LED_0805');
  assert.deepEqual(d1.pins.find((p) => p.name === 'A').pads, ['2']);
  // 各ネットのノードは一意
  for (const n of nl.nets) assert.equal(new Set(n.nodes.map((x) => x.ref + x.pad)).size, n.nodes.length);
  assert.ok(nl.problems.some((p) => /LCSC品番が未設定/.test(p.message)), 'LCSC未設定は警告');
  assert.match(formatNetlistText(nl), /GND\tD1-1 J1-2/);
});

test('ネットリスト: 回路図を変えると「古い」判定、DNPと未接続ピン', () => {
  const { prj, r } = projectA();
  prj.netlist = generateNetlist(prj);
  assert.equal(netlistStatus(prj), 'current');
  r.props.dnp = true;
  assert.equal(netlistStatus(prj), 'stale');
  const h1 = sourceHash(prj);
  const sh = prj.schematic.sheets[0];
  sh.wires = sh.wires.filter((w) => !((w.a.x === -14 && w.a.y === 1) || (w.b.x === -14 && w.b.y === 1)));
  assert.notEqual(sourceHash(prj), h1);
  const nl = generateNetlist(prj);
  assert.ok(nl.components.find((c) => c.ref === 'R1').dnp);
  assert.ok(nl.problems.some((p) => /J1\.2.*未接続/.test(p.message)));
});

test('ネットリスト: 重複番号・フットプリント不明・ピン対応の誤りはエラー', () => {
  const prj = createProject('E');
  const sh = prj.schematic.sheets[0];
  const a = addComponent(sh, 'resistor', 0, 0);
  const b = addComponent(sh, 'resistor', 0, 10);
  b.ref = a.ref;
  const c = addComponent(sh, 'npn', 20, 0, { footprint: 'NO_SUCH_FP' });
  const bad = normalizePart({ name: 'bad', kind: 'npn', footprint: 'SOT-23', pinMap: { 1: ['1'], 2: ['1'], 3: ['3'] } });
  prj.library.parts.push(bad);
  const q2 = addComponent(sh, 'npn', 40, 0, { partId: bad.id });
  void c; void q2;
  const nl = generateNetlist(prj);
  const msgs = nl.problems.filter((p) => p.level === 'error').map((p) => p.message).join('\n');
  assert.match(msgs, /R1 が重複/);
  assert.match(msgs, /NO_SUCH_FP/);
  assert.match(msgs, /重複して割り当て/);
});
