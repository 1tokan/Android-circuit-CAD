// node --test tests/ai.test.mjs … Claude の回路仕様（検証・作図・書き出し・API 呼び出し）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../js/core/project.js';
import { validateSpec, applySpec, exportSpec, extractJson, unwrap, projectFromSpec, RESPONSE_SCHEMA } from '../js/ai/spec.js';
import { callClaude, ClaudeError, API_URL } from '../js/ai/claude.js';
import { systemPrompt, pasteablePrompt } from '../js/ai/prompt.js';
import { generateNetlist } from '../js/netlist/netlist.js';
import { runErc } from '../js/check/erc.js';

import { SAMPLE } from './ai-sample.mjs';

test('回路仕様の検証: 正しい仕様は通り、誤りを具体的に指摘する', () => {
  assert.deepEqual(validateSpec(SAMPLE.circuit).errors, []);
  const bad = structuredClone(SAMPLE.circuit);
  bad.parts.push({ ...bad.parts[2], ref: 'C1' });
  bad.nets[0].pins.push('R1.3', 'X9.1');
  bad.nets[3].pins.push('U1.2');
  const e = validateSpec(bad).errors.join('\n');
  assert.match(e, /C1 が重複/);
  assert.match(e, /R1 にピン 3 はありません/);
  assert.match(e, /部品 X9 がありません/);
  assert.match(e, /U1\.2 が \+3V3 と LED_A の両方/);
});

test('作図: 部品を並べ、ピンにラベル・電源記号を置いて、期待どおりのネット・ERC エラー0', () => {
  const { project, report } = projectFromSpec(SAMPLE.circuit);
  assert.equal(report.placed, 9);
  assert.ok(report.newParts.includes('U1') && report.newParts.includes('J1'));
  const nl = generateNetlist(project);
  assert.deepEqual(nl.problems.filter((p) => p.level === 'error').map((p) => p.message), []);
  const net = (n) => nl.nets.find((x) => x.name === n).nodes.map((x) => `${x.ref}.${x.pin}`).sort();
  assert.deepEqual(net('+3V3'), ['C2.1', 'C3.1', 'R1.1', 'U1.2']);
  assert.deepEqual(net('LED_A'), ['D1.2', 'R1.2']);
  const erc = runErc(project);
  assert.equal(erc.summary.errors, 0, JSON.stringify(erc.issues.filter((i) => i.level === 'error')));
  // 部品が重ならない（部品の位置どうしが離れている）
  const cs = project.schematic.sheets[0].components.filter((c) => !['power', 'gnd'].includes(c.kind));
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y) >= 8, `${cs[i].ref}-${cs[j].ref}`);
  assert.equal(project.library.parts.find((p) => p.value === 'AMS1117-3.3').lcsc, 'C6186');
});

test('書き出し → 作図 の往復で同じネットになる（修正を頼むときに今の回路を渡せる）', () => {
  const { project } = projectFromSpec(SAMPLE.circuit);
  const spec = exportSpec(project);
  assert.equal(spec.parts.length, 9);
  assert.deepEqual(validateSpec(spec).errors, []);
  const p2 = createProject('往復');
  applySpec(p2, spec);
  const nets = (p) => generateNetlist(p).nets.map((n) => `${n.name}:${n.nodes.map((x) => `${x.ref}.${x.pin}`).sort().join(',')}`).sort();
  assert.deepEqual(nets(p2), nets(project));
});

test('返答の取り出し: コードブロック・前後の文章つきでも読める', () => {
  const t = `はい、次の回路です。\n\`\`\`json\n${JSON.stringify(SAMPLE)}\n\`\`\`\n以上です。`;
  const a = unwrap(extractJson(t));
  assert.equal(a.circuit.parts.length, 9);
  assert.equal(unwrap(SAMPLE.circuit).circuit.title, 'USB 3.3V 電源', '回路仕様だけでも受け取る');
  assert.throws(() => extractJson('JSON はありません'));
});

test('API 呼び出し: ヘッダー・構造化出力・エラーの区別', async () => {
  let req;
  const ok = async (url, init) => { req = { url, init }; return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: JSON.stringify(SAMPLE) }] }) }; };
  const r = await callClaude({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: 'x' }], schema: RESPONSE_SCHEMA, fetchImpl: ok });
  assert.equal(req.url, API_URL);
  assert.equal(req.init.headers['x-api-key'], 'sk-test');
  assert.equal(req.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  const body = JSON.parse(req.init.body);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(r.json.circuit.title, 'USB 3.3V 電源');
  const fail = (status, extra = {}) => async () => ({ ok: false, status, json: async () => ({ error: { message: 'm' }, ...extra }) });
  await assert.rejects(callClaude({ apiKey: 'k', fetchImpl: fail(401) }), (e) => e instanceof ClaudeError && e.kind === 'auth');
  await assert.rejects(callClaude({ apiKey: 'k', fetchImpl: fail(429) }), (e) => e.kind === 'rate');
  await assert.rejects(callClaude({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('x'); } }), (e) => e.kind === 'network');
  await assert.rejects(callClaude({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'max_tokens', content: [] }) }) }), (e) => e.kind === 'length');
  await assert.rejects(callClaude({ apiKey: '' }), (e) => e.kind === 'key');
});

test('JSON Schema は構造化出力の制約を守る（全オブジェクトが additionalProperties:false・全項目 required）', () => {
  const walk = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, path);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${path}[]`);
    for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'oneOf']) assert.ok(!(bad in s), `${path}: ${bad}`);
  };
  walk(RESPONSE_SCHEMA, '$');
  assert.match(systemPrompt(), /ピン番号/);
  assert.match(pasteablePrompt('LED を光らせたい', null), /JSON Schema/);
});
