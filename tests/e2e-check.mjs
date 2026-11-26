// 第5段階: ERC/DRC の実ブラウザE2Eテスト（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-check.mjs
import { openApp, OUT } from './e2e-lib.mjs';
import assert from 'node:assert/strict';

const { page, errors, step, ws, finish } = await openApp({ timeout: 6000 });
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const checks = () => page.evaluate(() => window.pocketEDA.state.project.checks);

// テストA（R1-D1 間の配線を1本わざと欠く）
await page.evaluate(async () => {
  const m = await import('./js/schematic/model.js');
  const { BUILTIN_PARTS } = await import('./js/library/parts.js');
  const app = window.pocketEDA;
  const P = (pred) => BUILTIN_PARTS.find(pred);
  const parts = { r: P((p) => p.name.startsWith('抵抗 330Ω')), led: P((p) => p.name === 'LED 赤 0805'), j: P((p) => p.name.startsWith('JST PH 2ピン')) };
  app.mutateProject((p) => { p.library.parts.push(...Object.values(parts)); });
  app.editSchematic(() => {
    const sh = app.state.project.schematic.sheets[0];
    const place = (part, x, y) => m.addComponent(sh, part.kind, x, y, { partId: part.id, value: part.value, footprint: part.footprint, pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames });
    place(parts.j, -10, 0); place(parts.r, 4, -10); place(parts.led, 14, -10);
    const g = m.addComponent(sh, 'gnd', -20, 10); g.props.net = 'GND';
    m.addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
    m.addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
    m.addLabel(sh, 20, 6, 'GND');
    m.addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  }, 'setup');
});

await step('検査タブ: 「未実装」表示なし・4ツール有効・未実行表示', async () => {
  await ws('check');
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  assert.ok(await page.locator('#check-view').isVisible());
  assert.equal(await page.locator('#toolbar .tool:not([disabled])').count(), 4);
  assert.equal(await page.locator('#check-view .badge.planned').count(), 3, 'ERC/DRC/信号経路とも未実行');
  assert.doesNotMatch(await page.locator('#check-view').textContent(), /エラーなし/, '未実行を検査済みと表示しない');
});

await step('ERC: 未接続ピン2件をエラー/警告で表示し、検査した項目・未検査の項目を出す', async () => {
  await tool('erc');
  const c = await checks();
  assert.equal(c.erc.issues.filter((i) => i.rule === 'pin_unconnected').length, 2);
  assert.ok(await page.locator('#check-view .issue').count() >= 2);
  const txt = await page.locator('#check-view').textContent();
  assert.match(txt, /R1\.2 が未接続/);
  assert.match(txt, /検査していない項目/);
  assert.match(txt, /階層シート/);
  await page.screenshot({ path: `${OUT}/check-erc-phone.png`, fullPage: false });
});

await step('ERC: 「表示」で回路図へ移動し、位置に印を出す', async () => {
  await page.locator('#check-view [data-jump]').first().click();
  assert.equal(await page.evaluate(() => window.pocketEDA.state.workspace), 'schematic');
  const m = await page.evaluate(() => window.pocketEDA.state.marker);
  assert.ok(m && m.ws === 'schematic');
  assert.equal(await page.locator('#check-marker circle').count(), 1);
  const s = await page.evaluate(() => { const m = window.pocketEDA.state.marker; return window.pocketEDA.state.vp.worldToScreen(m.x, m.y); });
  const box = await page.locator('#canvas').boundingBox();
  assert.ok(s.x > 0 && s.x < box.width && s.y > 0 && s.y < box.height, '印が画面内');
  assert.match(await page.locator('#sel-info').textContent(), /ERC: 最新/);
  await page.screenshot({ path: `${OUT}/check-erc-jump.png` });
});

await step('回路図を直すと ERC は「古い結果」になり、再実行でエラー0', async () => {
  await page.evaluate(async () => {
    const m = await import('./js/schematic/model.js');
    window.pocketEDA.editSchematic(() => m.addWirePath(window.pocketEDA.state.project.schematic.sheets[0], [{ x: 8, y: -10 }, { x: 11, y: -10 }]), 'fix');
  });
  assert.match(await page.locator('#sel-info').textContent(), /ERC: 変更後に未実行/);
  await ws('check');
  assert.equal(await page.locator('#check-view .check-card[data-tab="erc"] .badge.partial').count(), 1, '古い結果');
  assert.equal(await page.locator('#check-view [data-jump]').count(), 0, '古い結果では位置へ飛ばない');
  await tool('erc');
  assert.equal((await checks()).erc.summary.errors, 0);
  assert.equal((await checks()).erc.summary.warnings, 0);
  assert.match(await page.locator('#check-view .check-card[data-tab="erc"]').textContent(), /エラーなし/);
});

await step('DRC: 取込直後は未配置・未配線をエラー表示', async () => {
  await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const { generateNetlist } = await import('./js/netlist/netlist.js');
    const { partFootprint } = await import('./js/library/parts.js');
    const app = window.pocketEDA;
    const nl = generateNetlist(app.state.project);
    app.mutateProject((p) => { p.netlist = nl; });
    app.editPcb(() => {
      const b = pm.ensurePcb(app.state.project);
      pm.importNetlist(b, nl, (c) => partFootprint(app.state.project.library.parts.find((q) => q.id === c.partId)));
      pm.setOutlineRect(b, 30, 20);
    }, 'import');
  });
  await tool('drc');
  const d = (await checks()).drc;
  assert.equal(d.issues.filter((i) => i.rule === 'outside_board' && i.level === 'error').length, 3);
  assert.equal(d.issues.filter((i) => i.rule === 'unrouted').length, 3);
  assert.match(await page.locator('#check-view').textContent(), /ベタの細い部分/, '未検査項目を表示');
});

await step('DRC: 配置・配線後はエラー0、間隔不足を作ると検出して PCB の位置へ飛べる', async () => {
  await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const app = window.pocketEDA;
    app.editPcb(() => {
      const b = app.state.project.pcb;
      const at = (ref, x, y, rot = 0) => { const f = b.footprints.find((q) => q.ref === ref); f.x = pm.toNm(x); f.y = pm.toNm(y); f.rot = rot; };
      at('J1', 6, 10, 90); at('R1', 15, 6); at('D1', 23, 10);
      const pad = (ref, n) => pm.allPads(b).find((p) => p.ref === ref && p.pad.num === n);
      const w = pm.toNm(0.3);
      const j1 = pad('J1', '1'), j2 = pad('J1', '2'), r1 = pad('R1', '1'), r2 = pad('R1', '2'), d1 = pad('D1', '1'), d2 = pad('D1', '2');
      pm.addTrackPath(b, [j1, { x: j1.x, y: 6 }, r1], 'F.Cu', w, j1.net);
      pm.addTrackPath(b, [r2, { x: d2.x, y: 6 }, d2], 'F.Cu', w, r2.net);
      pm.addTrackPath(b, [j2, { x: j2.x, y: 15 }, { x: d1.x, y: 15 }, d1], 'F.Cu', w, j2.net);
    }, 'route');
  });
  await tool('drc');
  let d = (await checks()).drc;
  assert.equal(d.summary.errors, 0, JSON.stringify(d.issues.map((i) => i.message)));
  // GND 配線を R1 パッド1のすぐ横に通す
  await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const app = window.pocketEDA;
    app.editPcb(() => {
      const b = app.state.project.pcb;
      const r1 = pm.allPads(b).find((p) => p.ref === 'R1' && p.pad.num === '1');
      const gnd = pm.allPads(b).find((p) => p.ref === 'D1' && p.pad.num === '1').net;
      const x = r1.x - r1.pad.w / 2 - 0.1 - 0.15;
      pm.addTrackPath(b, [{ x, y: r1.y + 3 }, { x, y: r1.y - 3 }], 'F.Cu', pm.toNm(0.3), gnd);
    }, 'bad');
  });
  assert.equal(await page.locator('#check-view .check-card[data-tab="drc"] .badge.partial').count(), 1, '古い結果');
  await tool('drc');
  d = (await checks()).drc;
  assert.ok(d.issues.some((i) => i.rule === 'clearance'), JSON.stringify(d.issues.map((i) => i.message)));
  await page.locator('#check-view .chip[data-filter="error"]').click();
  const msgs = await page.locator('#check-view .issue .msg').allTextContents();
  assert.ok(msgs.length >= 1 && msgs.every((t) => !/外形線|未照合/.test(t)), 'エラーだけに絞り込み');
  await page.screenshot({ path: `${OUT}/check-drc-phone.png` });
  await page.locator('#check-view .issue', { hasText: '間隔不足' }).first().locator('[data-jump]').click();
  assert.equal(await page.evaluate(() => window.pocketEDA.state.workspace), 'pcb');
  assert.equal(await page.locator('#check-marker circle').count(), 1);
  assert.match(await page.locator('#sel-info').textContent(), /DRC: 最新（エラー[1-9]/);
  await page.screenshot({ path: `${OUT}/check-drc-jump.png` });
});

await step('DRCルール: 最小配線幅を 0.4mm にすると配線幅エラー', async () => {
  await ws('check');
  await tool('rules');
  await page.locator('#dialog [data-rule="minTrackWidthMm"]').fill('0.4');
  await page.locator('#dialog button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.project.board.rules.minTrackWidthMm === 0.4);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.project.board.rules.minTrackWidthMm), 0.4);
  await tool('drc');
  assert.ok((await checks()).drc.issues.filter((i) => i.rule === 'track_width').length >= 3);
});

await step('結果は保存され、再読込後も残る', async () => {
  await page.evaluate(() => window.pocketEDA.saveNow());
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  const c = await checks();
  assert.ok(c.erc && c.drc);
  await ws('check');
  await page.locator('#check-view .check-card[data-tab="drc"]').click();
  assert.ok(await page.locator('#check-view .issue').count() >= 1);
});

await step('ログ: DRC の結果と操作が記録され、画面で見られる', async () => {
  await page.locator('#btn-menu').click();
  await page.locator('#menu [data-act="log"]').click();
  const t = await page.locator('#dialog .log-view').textContent();
  assert.match(t, /起動 0\.13\.3/);
  assert.match(t, /DRC: エラー/);
  assert.match(t, /エラーの種類: /);
  await page.screenshot({ path: `${OUT}/check-log.png` });
  await page.locator('#dialog button', { hasText: '閉じる' }).click();
});

await step('コンソールエラーなし', async () => { assert.deepEqual(errors, []); });
await finish();
