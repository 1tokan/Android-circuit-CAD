// node --test tests/scenarios.test.mjs … テストプロジェクト A〜E の通し（回路図→ネットリスト→ERC→PCB→DRC→Gerber→BOM/CPL）
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules, runPipeline, SPECS } from './scenarios.js';

const M = await loadModules(new URL('../', import.meta.url));

for (const key of Object.keys(SPECS)) {
  test(`通し: ${SPECS[key].name}`, async () => {
    const r = await runPipeline(M, key);
    assert.deepEqual(r.netlistErrors, [], 'ネットリストのエラーなし');
    assert.deepEqual(r.netMismatch, [], '期待どおりのネット');
    assert.equal(r.erc.errors, 0, r.erc.errorMessages.join('\n'));
    assert.deepEqual(r.arranged.notFit, [], '全部品が基板内に入る');
    assert.equal(r.arranged.moved, r.components);
    assert.equal(r.zone[0].polygons, 1, 'GND ベタは1つの島');
    // 配線していないので、DRC のエラーは未配線だけ（間隔・はみ出し・シルクの重なりは無い）
    for (const k of Object.keys(r.drc.byRule)) assert.ok(['error:unrouted', 'warning:footprint_unverified'].includes(k), `${k}: ${JSON.stringify(r.drc.byRule)}`);
    assert.ok(r.drc.unrouted > 0);
    for (const ext of ['gtl', 'gbl', 'gts', 'gbs', 'gto', 'gm1', 'drl']) assert.ok(r.gerber.files.some((f) => f.endsWith(ext)), ext);
    assert.equal(r.assembly.cplRows, r.components);
    assert.ok(r.assembly.bomLines >= 1 && r.assembly.bomLines <= r.components);
  });
}
