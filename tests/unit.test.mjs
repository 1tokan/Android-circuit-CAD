// node --test tests/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, normalizeProject, parseProject, serializeProject, touch, asCopy, safeFileName,
  ProjectFormatError, SCHEMA_VERSION, FORMAT_ID,
} from '../js/core/project.js';
import { AutoSaver } from '../js/core/autosave.js';
import { Viewport } from '../js/ui/viewport.js';
import { MODULES, WORKSPACES, workspaceStatus } from '../js/modules/registry.js';

test('新規プロジェクトは必要な項目を全て持つ', () => {
  const p = createProject('テスト', 1000);
  assert.equal(p.format, FORMAT_ID);
  assert.equal(p.schemaVersion, SCHEMA_VERSION);
  for (const k of ['schematic', 'library', 'netlist', 'pcb', 'board', 'checks']) assert.ok(k in p, k);
  assert.equal(p.checks.erc, null, 'ERC未実行はnull');
  assert.equal(p.checks.drc, null, 'DRC未実行はnull');
  assert.equal(p.name, 'テスト');
});

test('シリアライズ→パースで完全に一致（往復）', () => {
  const p = createProject('往復');
  p.library.parts.push({ id: 'r1', lcsc: 'C17414', name: '10k 0805' });
  p.board.rules.minTrackWidthMm = 0.2;
  const back = parseProject(serializeProject(p));
  assert.deepEqual(back, p);
});

test('欠けた項目は既定値で補完、既存値は保持（ルールは変えた値だけを持つ）', () => {
  const p = createProject('補完');
  delete p.pcb.vias;
  delete p.board.fab.maskColor;
  p.board.rules.minClearanceMm = 0.2;
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(n.pcb.vias, []);
  assert.equal(n.board.fab.maskColor, 'green');
  assert.deepEqual(n.board.rules, { minClearanceMm: 0.2 });
});

test('v1 → v2: 旧既定値のコピーは捨て、利用者が変えた値と板厚・層数は引き継ぐ', () => {
  const v1 = { ...createProject('旧'), schemaVersion: 1, board: { layers: 4, thicknessMm: 1.2, copperOz: 2, units: 'mm', rules: { minTrackWidthMm: 0.127, minClearanceMm: 0.15, minViaDrillMm: 0.3, minViaDiameterMm: 0.6, boardEdgeClearanceMm: 0.3 } }, pcb: { version: 2, settings: { grid: 250000 }, outline: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, footprints: [], tracks: [], vias: [], zones: [], texts: [], holes: [] } };
  const n = normalizeProject(JSON.parse(JSON.stringify(v1)));
  assert.equal(n.schemaVersion, 2);
  assert.deepEqual(n.board.rules, { minClearanceMm: 0.15 });
  assert.equal(n.board.fab.thicknessMm, 1.2);
  assert.equal(n.board.fab.outerCopperOz, 2);
  assert.equal(n.pcb.settings.layers, 4);
});

test('不正なファイルは例外（黙って空にしない）', () => {
  assert.throws(() => parseProject('{not json'), ProjectFormatError);
  assert.throws(() => parseProject('[]'), ProjectFormatError);
  assert.throws(() => parseProject(JSON.stringify({ format: 'other' })), ProjectFormatError);
  const p = createProject();
  assert.throws(() => normalizeProject({ ...p, schemaVersion: SCHEMA_VERSION + 1 }), /新しいバージョン/);
  assert.throws(() => normalizeProject({ ...p, id: '' }), ProjectFormatError);
});

test('touch で revision と updatedAt が単調増加', () => {
  const p = createProject('t', 5000);
  touch(p, 5000);
  touch(p, 4000); // 時計が戻っても増える
  assert.equal(p.revision, 2);
  assert.ok(p.updatedAt > 5000);
});

test('コピーは別IDで元を変更しない', () => {
  const p = createProject('元');
  const c = asCopy(p);
  assert.notEqual(c.id, p.id);
  assert.equal(p.name, '元');
  c.library.parts.push({});
  assert.equal(p.library.parts.length, 0);
});

test('ファイル名の禁止文字を置換', () => {
  assert.equal(safeFileName('a/b:c*?'), 'a_b_c__');
  assert.equal(safeFileName(''), 'project');
});

test('AutoSaver: 連続変更は1回にまとめて保存', async () => {
  let n = 0;
  const s = new AutoSaver(async () => { n++; }, { delay: 30, maxWait: 1000 });
  s.markDirty(); s.markDirty(); s.markDirty();
  await sleep(80);
  assert.equal(n, 1);
  assert.equal(s.dirty, false);
});

test('AutoSaver: 変更が続いても maxWait で必ず保存', async () => {
  let n = 0;
  const s = new AutoSaver(async () => { n++; }, { delay: 40, maxWait: 100 });
  const t0 = Date.now();
  while (Date.now() - t0 < 160) { s.markDirty(); await sleep(10); }
  assert.ok(n >= 1, `saved ${n}`);
  await s.flush();
});

test('AutoSaver: 保存失敗時は未保存に戻る', async () => {
  const states = [];
  const s = new AutoSaver(async () => { throw new Error('disk full'); }, { delay: 5, onState: (x) => states.push(x) });
  s.dirty = true;
  await assert.rejects(s.flush(), /disk full/);
  assert.equal(s.dirty, true);
  assert.ok(states.includes('error'));
  s.setEnabled(false);
});

test('AutoSaver: 保存中の変更は取りこぼさない', async () => {
  let n = 0;
  let release;
  const s = new AutoSaver(async () => { n++; if (n === 1) await new Promise((r) => (release = r)); }, { delay: 5 });
  s.dirty = true;
  const f = s.flush();
  await sleep(5);
  s.markDirty();   // 保存中に変更
  release();
  await f;
  await sleep(40);
  assert.equal(n, 2);
  assert.equal(s.dirty, false);
});

test('Viewport: zoomAt は指の位置を固定する', () => {
  const v = new Viewport({ x: -10, y: -5, scale: 4 });
  const before = v.screenToWorld(120, 80);
  v.zoomAt(120, 80, 2.5);
  const after = v.screenToWorld(120, 80);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  const s = v.worldToScreen(after.x, after.y);
  assert.ok(Math.abs(s.x - 120) < 1e-9);
});

test('Viewport: 倍率は上下限内', () => {
  const v = new Viewport();
  v.zoomAt(0, 0, 1e9); assert.equal(v.scale, 40);
  v.zoomAt(0, 0, 1e-9); assert.equal(v.scale, 0.1);
});

test('未実装モジュールは ready と表示されない', () => {
  const ready = MODULES.filter((m) => m.status === 'ready').map((m) => m.id);
  assert.deepEqual(ready, ['project', 'schematic', 'library', 'lcsc', 'netlist', 'pcb', 'erc', 'drc', 'gerber', 'bomcpl'], '第7段階までのモジュールが ready');
  const expect = { schematic: 'ready', parts: 'ready', pcb: 'ready', check: 'ready', output: 'ready' };
  for (const ws of WORKSPACES) assert.equal(workspaceStatus(ws), expect[ws.id], ws.id);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
