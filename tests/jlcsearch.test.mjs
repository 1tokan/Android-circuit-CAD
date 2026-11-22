// node --test tests/jlcsearch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapComponent, createJlcsearch, JlcsearchError, DEFAULT_BASE } from '../js/library/jlcsearch.js';

// 実際の /resistors/list.json の応答（2026-11-22取得）から1件
const RES = {
  lcsc: 2907365, mfr: 'FRC1206F1R30TS',
  description: '-55℃~+155℃ 1.3Ω 200V 250mW Thick Film Resistor ±1% ±200ppm/℃ 1206 Chip Resistor - Surface Mount ROHS',
  stock: 5314393, price1: 0.01, in_stock: true, resistance: 1.3, package: '1206', is_basic: false, is_preferred: false,
  attributes: { 'Power(Watts)': '250mW', Resistance: '1.3Ω', Tolerance: '±1%', Type: 'Thick Film Resistors' },
};

test('抵抗の応答を部品データに変換（品番・値・フットプリント・区分・価格・在庫）', () => {
  const p = mapComponent(RES, { now: '2026-11-22T08:00:00Z' });
  assert.equal(p.lcsc, 'C2907365');
  assert.equal(p.id, 'lcsc:C2907365');
  assert.equal(p.kind, 'resistor');
  assert.equal(p.value, '1.3');
  assert.equal(p.footprint, 'R_1206');
  assert.equal(p.mpn, 'FRC1206F1R30TS');
  assert.equal(p.jlc.type, 'extended');
  assert.deepEqual(p.price, [{ qty: 1, usd: 0.01 }]);
  assert.equal(p.stock, 5314393);
  assert.equal(p.specs.Tolerance, '±1%');
  assert.equal(p.source, 'jlcsearch');
  assert.equal(p.lcscVerified, true);
});

test('文字列のattributes・価格表・Basic区分・コンデンサの値', () => {
  const p = mapComponent({ lcsc: 'C1525', mfr: 'CL05B104KO5NNNC', package: '0402', description: '100nF 16V X7R ±10% 0402 Multilayer Ceramic Capacitors MLCC - SMD/SMT ROHS', stock: '1000', price: '[{"qFrom":1,"qTo":199,"price":0.0011},{"qFrom":200,"price":0.0005}]', is_basic: true, attributes: '{"Capacitance":"100nF"}' });
  assert.equal(p.kind, 'capacitor');
  assert.equal(p.value, '100n');
  assert.equal(p.footprint, 'C_0402');
  assert.equal(p.jlc.type, 'basic');
  assert.equal(p.price.length, 2);
  assert.equal(p.stock, 1000);
});

test('ESP32-S3（実データの形）: ICとして57ピン、フットプリント未設定', () => {
  const p = mapComponent({ lcsc: 2913192, mfr: 'ESP32-S3', package: 'QFN-56-EP(7x7)', is_basic: false, is_preferred: false, description: '-40℃~+105℃ -98.4dBm 150Mbps 2.412GHz~2.484GHz 2.4GHz 21dBm 340mA 3V~3.6V 88mA SPI、USB、UART', stock: 525, price: 2.8747 });
  assert.equal(p.kind, 'ic');
  assert.equal(p.symbol.pinCount, 57);
  assert.equal(p.footprint, '');
  assert.equal(p.jlc.type, 'extended');
  const op = mapComponent({ lcsc: 7950, mfr: 'LM358DR2G', package: 'SOIC-8', is_basic: true, description: '-16V~16V 0℃~+70℃ SOIC-8 Operational Amplifier ROHS', stock: 415763, price: 0.0589 });
  assert.equal(op.kind, 'opamp');
  assert.equal(op.footprint, 'SOIC-8');
  assert.equal(op.jlc.type, 'basic');
});

test('区分不明・品番なし・壊れたデータ', () => {
  assert.equal(mapComponent({ lcsc: 1, mfr: 'X', description: 'IC' }).jlc.type, 'unknown');
  assert.equal(mapComponent({ mfr: 'X' }), null);
  assert.equal(mapComponent(null), null);
  assert.equal(mapComponent({ lcsc: 'abc' }), null);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url) => { calls.push(url); return handler(url); };
  f.calls = calls;
  return f;
}
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('LCSC品番は品番検索、それ以外は全文検索のURLになる', async () => {
  const f = fakeFetch(() => json({ components: [RES] }));
  const js = createJlcsearch({ fetchImpl: f });
  const r1 = await js.search('c2907365');
  assert.equal(f.calls[0], `${DEFAULT_BASE}/components/list.json?search=C2907365&full=true`);
  assert.equal(r1.parts[0].lcsc, 'C2907365');
  await js.search('10k 0603');
  assert.equal(f.calls[1], `${DEFAULT_BASE}/api/search?q=10k+0603&limit=30&full=true`);
});

test('同じ検索はキャッシュし、カテゴリ別のキー（resistors）も読める', async () => {
  const f = fakeFetch(() => json({ resistors: [RES, RES] }));
  const js = createJlcsearch({ fetchImpl: f });
  const a = await js.search('FRC1206');
  const b = await js.search('FRC1206');
  assert.equal(f.calls.length, 1);
  assert.equal(a.parts.length, 1, '重複は1件に');
  assert.deepEqual(a, b);
});

test('エラーの種類を区別する', async () => {
  const neterr = createJlcsearch({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(neterr.search('x'), (e) => e instanceof JlcsearchError && e.kind === 'network');
  await assert.rejects(createJlcsearch({ fetchImpl: async () => json({}, 429) }).search('x'), (e) => e.kind === 'rate');
  await assert.rejects(createJlcsearch({ fetchImpl: async () => json({}, 500) }).search('x'), (e) => e.kind === 'http' && /500/.test(e.message));
  await assert.rejects(createJlcsearch({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }) }).search('x'), (e) => e.kind === 'format');
});

test('中継URLへの切替と空検索', async () => {
  const f = fakeFetch(() => json({ components: [] }));
  const js = createJlcsearch({ fetchImpl: f });
  js.setBase('https://relay.example.workers.dev/');
  await js.search('AMS1117');
  assert.match(f.calls[0], /^https:\/\/relay\.example\.workers\.dev\/api\/search\?/);
  js.setBase('');
  assert.equal(js.base, DEFAULT_BASE);
  assert.deepEqual((await js.search('  ')).parts, []);
});
