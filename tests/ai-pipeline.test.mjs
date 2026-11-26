// AI 回路設計の段階の進め方（js/ai/pipeline.js）。API は差し替え（実際には送らない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, buildDesignMessage, needsCompaction, designTurn, planOf, localCheck, improved, usageText, DESIGN_SCHEMA, MODEL_IDS } from '../js/ai/pipeline.js';
import { SAMPLE } from './ai-sample.mjs';

const base = SAMPLE.circuit;
const EMPTY_PATCH = { remove_parts: [], upsert_parts: [], remove_nets: [], upsert_nets: [], nc_add: [], nc_remove: [], requirements: [], notes: [] };
const EMPTY_CIRCUIT = { title: '', summary: '', requirements: [], parts: [], nets: [], nc: [], notes: [] };

/** 返答を順に返す fetch。送った中身を記録する */
function mockFetch(replies) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const r = replies[sent.length - 1];
    if (!r) throw new Error('呼び出しが多すぎる');
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: sent.length > 1 ? 90 : 0 } }) };
  };
  return { fetchImpl, sent };
}

test('元の回路は端末の検査でエラーなし', () => {
  assert.deepEqual(localCheck(base).errors, []);
});

test('差分: 部品を消すとピンもネットから外れ、ピンを別のネットへ移すと元のネットから外れる', () => {
  const led = base.nets.find((n) => n.pins.some((s) => s.startsWith('D1.')));
  const r = applyPatch(base, { ...EMPTY_PATCH, remove_parts: ['D1'] });
  assert.ok(!r.circuit.nets.some((n) => n.pins.some((s) => s.startsWith('D1.'))));
  assert.ok(r.fixes.length >= 1, JSON.stringify(led));
  const pin = base.nets[0].pins[0];
  const m = applyPatch(base, { ...EMPTY_PATCH, upsert_nets: [{ name: 'NEWNET', pins: [pin, 'R1.1'] }] });
  assert.equal(m.circuit.nets.filter((n) => n.pins.includes(pin)).length, 1);
  assert.equal(m.circuit.nets.filter((n) => n.pins.includes('R1.1')).length, 1);
});

test('差分: 同じ部品を消して入れ直す（差し替え）とピンは残る', () => {
  const d1 = base.parts.find((x) => x.ref === 'D1');
  const pinsBefore = base.nets.flatMap((n) => n.pins).filter((s) => s.startsWith('D1.')).length;
  const r = applyPatch(base, { ...EMPTY_PATCH, remove_parts: ['D1'], upsert_parts: [{ ...d1, value: 'green' }] });
  assert.equal(r.circuit.parts.find((x) => x.ref === 'D1').value, 'green');
  assert.equal(r.circuit.nets.flatMap((n) => n.pins).filter((s) => s.startsWith('D1.')).length, pinsBefore);
});

test('修理の採否: 形式の誤りが減れば ERC が見えて数が増えても採る', () => {
  assert.ok(improved({ errors: ['a', 'b', 'c'], format: 0 }, { errors: ['x', 'y'], format: 2 }));
  assert.ok(!improved({ errors: ['a'], format: 1 }, { errors: ['x', 'y', 'z'], format: 0 }));
  assert.ok(improved({ errors: ['a'], format: 0 }, { errors: ['x', 'y'], format: 0 }));
  assert.equal(localCheck(undefined).errors.length, 1);
});

test('要約の範囲が履歴より先（元に戻した後）でも直近のやりとりを落とさない', () => {
  const history = [{ role: 'user', text: 'HELLO-1' }, { role: 'assistant', reply: 'REPLY-1' }];
  const [m] = buildDesignMessage({ history, summary: { upTo: 10, text: 's' }, request: 'r', currentSpec: base });
  assert.match(m.content, /HELLO-1/);
  assert.match(m.content, /REPLY-1/);
});

test('送る内容: 前の回路の JSON は送らず、今の回路を 1 回だけ。直近 2 往復だけそのまま', () => {
  const big = { ...base, title: 'OLD-CIRCUIT-MARK' };
  const history = [];
  for (let i = 0; i < 4; i++) history.push({ role: 'user', text: `依頼${i}` }, { role: 'assistant', reply: `返答${i}`, questions: [], circuit: big });
  const [m] = buildDesignMessage({ history, request: '抵抗を 2.2k に', currentSpec: base });
  assert.equal(m.role, 'user');
  assert.ok(!m.content.includes('OLD-CIRCUIT-MARK'));
  assert.equal(m.content.split(JSON.stringify(base)).length - 1, 1);
  assert.ok(m.content.includes('依頼3') && m.content.includes('返答3') && !m.content.includes('依頼0'));
});

test('段階: 設計は Opus（指示文をキャッシュ）、検査の誤りの修理は Sonnet。直った差分を当てる', async () => {
  // 設計: 抵抗 R9 を足すが、ありもしない U9 のピンにつなぐ（検査で誤り）
  const bad = { reply: 'R9 を足しました', questions: [], mode: 'patch', circuit: EMPTY_CIRCUIT, patch: { ...EMPTY_PATCH, upsert_parts: [{ ...base.parts.find((p) => p.ref === 'R1'), ref: 'R9' }], upsert_nets: [{ name: 'X', pins: ['R9.1', 'U9.1'] }, { name: 'GND', pins: [...base.nets.find((n) => n.name === 'GND').pins, 'R9.2'] }] } };
  const fix = { reply: 'U9 は無いので R9 を +3V3 へ', questions: [], mode: 'patch', circuit: EMPTY_CIRCUIT, patch: { ...EMPTY_PATCH, remove_nets: ['X'], upsert_nets: [{ name: '+3V3', pins: [...base.nets.find((n) => n.name === '+3V3').pins, 'R9.1'] }] } };
  const { fetchImpl, sent } = mockFetch([bad, fix]);
  const r = await designTurn({ apiKey: 'k', plan: planOf('auto'), system: 'S'.repeat(5000), history: [], request: 'プルアップを足して', currentSpec: base, fetchImpl });
  assert.deepEqual(sent.map((b) => b.model), [MODEL_IDS.opus, MODEL_IDS.sonnet]);
  assert.deepEqual(sent[0].system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(sent[0].output_config.format.schema, DESIGN_SCHEMA);
  assert.deepEqual(r.check.errors, []);
  assert.equal(r.repaired, 1);
  assert.ok(r.circuit.parts.some((p) => p.ref === 'R9'));
  assert.ok(r.circuit.nets.find((n) => n.name === '+3V3').pins.includes('R9.1'));
  assert.match(usageText(r.calls), /設計 Opus: 入力 100・出力 50 ／ 修理 Sonnet: 入力 100（キャッシュ 読 90・書 0）・出力 50/);
});

test('段階: 修理が 2 回とも効かなければ設計のモデルで 1 回。誤りが減らない直しは採らない', async () => {
  const bad = { reply: '', questions: [], mode: 'patch', circuit: EMPTY_CIRCUIT, patch: { ...EMPTY_PATCH, upsert_nets: [{ name: 'X', pins: ['R1.1', 'U9.1'] }] } };
  const noop = { reply: '', questions: [], mode: 'patch', circuit: EMPTY_CIRCUIT, patch: EMPTY_PATCH };
  const { fetchImpl, sent } = mockFetch([bad, noop, noop, noop]);
  const r = await designTurn({ apiKey: 'k', plan: planOf('auto'), system: 'S', history: [], request: 'x', currentSpec: base, fetchImpl });
  assert.deepEqual(sent.map((b) => b.model), [MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.sonnet, MODEL_IDS.opus]);
  assert.equal(r.repaired, 0);
  assert.ok(r.check.errors.length > 0); // 画面に残った誤りを出す
});

test('質問だけ（mode = none）なら回路はそのまま・検査も修理もしない', async () => {
  const { fetchImpl, sent } = mockFetch([{ reply: '電流は？', questions: ['最大電流は？'], mode: 'none', circuit: EMPTY_CIRCUIT, patch: EMPTY_PATCH }]);
  const r = await designTurn({ apiKey: 'k', system: 'S', history: [], request: 'x', currentSpec: base, fetchImpl });
  assert.equal(sent.length, 1);
  assert.equal(r.circuit, base);
});

test('会話が長くなったら Haiku で 1 度だけ要約し、以後は要約を送る', async () => {
  const history = [];
  for (let i = 0; i < 10; i++) history.push({ role: 'user', text: `依頼${i} ${'あ'.repeat(700)}` }, { role: 'assistant', reply: `返答${i}`, questions: [] });
  assert.ok(needsCompaction(history, null));
  const { fetchImpl, sent } = mockFetch([{ summary: '要約: 3.3V・LED あり' }, { reply: 'ok', questions: [], mode: 'none', circuit: EMPTY_CIRCUIT, patch: EMPTY_PATCH }]);
  const r = await designTurn({ apiKey: 'k', system: 'S', history, request: 'x', currentSpec: base, fetchImpl });
  assert.deepEqual(sent.map((b) => b.model), [MODEL_IDS.haiku, MODEL_IDS.opus]);
  assert.equal(r.summary.upTo, history.length - 4);
  assert.match(sent[1].messages[0].content, /要約: 3\.3V・LED あり/);
  assert.ok(!sent[1].messages[0].content.includes('依頼0'));
  assert.ok(!needsCompaction(history, r.summary));
});

test('以前のモデルの設定は近い組み合わせに', () => {
  assert.equal(planOf('claude-sonnet-5-5').id, 'sonnet');
  assert.equal(planOf('claude-opus-5-5').id, 'opus');
  assert.equal(planOf('auto').design, MODEL_IDS.opus);
});
