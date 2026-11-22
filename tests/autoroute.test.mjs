// node --test tests/autoroute.test.mjs … 自動配線と長穴
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules, runPipeline } from './scenarios.js';
import { normalizeFootprint } from '../js/library/footprints.js';
import { padHole, padHoleLocal } from '../js/pcb/model.js';
import { writeExcellon } from '../js/output/gerber.js';

const M = await loadModules(new URL('../', import.meta.url));

test('自動配線: テストA・B は全部つながり、DRC エラー 0', async () => {
  for (const k of ['A', 'B']) {
    const r = await runPipeline(M, k, { route: true });
    assert.equal(r.routed.failed.length, 0, `${k}: ${JSON.stringify(r.routed.failed)}`);
    assert.equal(r.drc.unrouted, 0, k);
    assert.equal(r.drc.errors, 0, `${k}: ${JSON.stringify(r.drc.byRule)}`);
  }
});

test('自動配線: 引けない接続があっても、引いた配線は間隔違反を作らない（テストE）', async () => {
  const r = await runPipeline(M, 'E', { route: true });
  const bad = Object.entries(r.drc.byRule).filter(([k]) => k.startsWith('error:') && k !== 'error:unrouted');
  assert.deepEqual(bad, []);
  assert.equal(r.drc.unrouted, r.routed.failed.length > 0 ? r.drc.unrouted : 0);
  assert.ok(r.routed.ok > 0);
});

test('長穴: フットプリントの slot、穴の線分、Excellon の G85', () => {
  const fp = normalizeFootprint({ id: 'SlotTest', pads: [{ num: '1', x: 0, y: 0, w: 1.0, h: 2.1, shape: 'oval', type: 'tht', slot: { w: 0.6, h: 1.7 } }] });
  const p = fp.pads[0];
  assert.equal(p.drill, 0.6);
  const l = padHoleLocal(p);
  assert.deepEqual([l.a.y, l.b.y, l.d], [-0.55, 0.55, 0.6]);
  // 90°回すと横向き
  const h = padHole({ x: 10e6, y: 5e6, rot: 90, side: 'top' }, p);
  assert.ok(Math.abs(h.a.x - 10.55) < 1e-9 && Math.abs(h.b.x - 9.45) < 1e-9 && Math.abs(h.a.y - 5) < 1e-9);
  const drl = writeExcellon([{ x: 10, y: 5, d: 0.6, slot: { a: h.a, b: h.b } }, { x: 1, y: 1, d: 0.3 }], true, { version: 't', date: 'd' });
  assert.match(drl, /X10\.550Y-5\.000G85X9\.450Y-5\.000/);
  assert.match(drl, /X1\.000Y-1\.000/);
  assert.throws(() => normalizeFootprint({ id: 'Bad', pads: [{ num: '1', x: 0, y: 0, w: 1, h: 2, type: 'tht', slot: { w: 1.2, h: 1.5 } }] }), /長穴/);
});
