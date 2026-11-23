// node --test tests/applog.test.mjs … 操作ログ
import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage の代わり
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const L = await import('../js/core/applog.js');

test('記録・まとめ・上限・文字にする', () => {
  L.clearLog();
  L.log('app', '起動 0.0.0');
  for (let i = 0; i < 5; i++) L.log('op', '移動', { id: 'p', rev: i, sch: 1, fp: 2, tr: 3, via: 4, zone: 1 });
  const a = L.getLog();
  assert.equal(a.length, 2, '同じ操作が続くときは 1 行（回数だけ増やす）');
  assert.equal(a[1].n, 5);
  L.log('check', 'DRC: エラー 2・警告 0', { fp: 2, tr: 3, via: 4, zone: 1, rev: 9, errors: { short: 2 }, first: ['短絡: ビア（GND）と配線（CHIP_PU） @(1.00,2.00)'] });
  L.logError(new Error('こわれた'), 'テスト');
  const t = L.formatLog(L.getLog(), { 'Pocket EDA': 'x' });
  assert.match(t, /Pocket EDA: x/);
  assert.match(t, /移動 ×5 {2}\[部品2・配線3・ビア4・ベタ1・rev4\]/);
  assert.match(t, /エラーの種類: short×2/);
  assert.match(t, /- 短絡: ビア（GND）と配線（CHIP_PU） @\(1\.00,2\.00\)/);
  assert.match(t, /error テスト: こわれた/);
  L.flushLog();
  assert.ok(JSON.parse(mem.get(L.LOG_KEY)).length === 4, '端末に保存される');
  for (let i = 0; i < L.MAX + 50; i++) L.log('op', `op${i}`);
  assert.equal(L.getLog().length, L.MAX, '最大件数を超えたら古いものから捨てる');
});

test('プロジェクトの要約', () => {
  const s = L.projectSummary({ id: 'a', revision: 3, schematic: { sheets: [{ components: [1, 2] }] }, pcb: { footprints: [1], tracks: [1, 2], vias: [], zones: [1] } });
  assert.deepEqual(s, { id: 'a', rev: 3, sch: 2, fp: 1, tr: 2, via: 0, zone: 1 });
});
