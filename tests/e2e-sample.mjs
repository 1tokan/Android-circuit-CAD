// 同梱サンプルをアプリの画面から開いて、回路図・PCB・検査・出力・3D が動くかの実ブラウザE2E（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-sample.mjs
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const URL_ = process.env.URL || 'http://localhost:8765/';
const OUT = process.env.OUT || 'tests/out';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['OK', name]); console.log('OK  ', name); }
  catch (e) { results.push(['NG', name, e.message]); console.log('NG  ', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); }
}
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();

await step('プロジェクト一覧の「サンプル」から USB DAC アンプを開ける', async () => {
  await page.click('#btn-projects');
  await page.click('#btn-sample');
  await page.click('#dialog-actions button[value="usb-dac-amp"]');
  await page.waitForFunction(() => /USB DAC アンプ/.test(window.pocketEDA.state.project?.name || ''));
  const st = await page.evaluate(() => {
    const p = window.pocketEDA.state.project;
    return { name: p.name, fps: p.pcb.footprints.length, tracks: p.pcb.tracks.length, layers: p.pcb.settings.layers };
  });
  assert.ok(st.fps >= 60 && st.tracks > 100 && st.layers === 4, JSON.stringify(st));
});

await step('2回開くと別のプロジェクトとして増える（元のサンプルは変わらない）', async () => {
  const id1 = await page.evaluate(() => window.pocketEDA.state.project.id);
  await page.evaluate(() => window.pocketEDA.openSample('usb-dac-amp'));
  const id2 = await page.evaluate(() => window.pocketEDA.state.project.id);
  assert.notEqual(id1, id2);
});

await step('回路図と PCB が表示される', async () => {
  await ws('schematic');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/sample-sch.png` });
  await ws('pcb');
  await page.waitForSelector('#pcb-content .pad');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/sample-pcb.png` });
});

await step('回路図で部品（Y1）を指で動かしても、付いているラベル・GND 記号が追従して接続が外れない', async () => {
  await ws('schematic');
  const info = await page.evaluate(() => {
    const sh = window.pocketEDA.state.project.schematic.sheets[0];
    const c = sh.components.find((x) => x.ref === 'Y1');
    window.pocketEDA.jumpTo('schematic', { x: c.x, y: c.y });
    return { id: c.id, x: c.x, y: c.y };
  });
  await page.waitForTimeout(400);
  const box = await page.locator(`[data-key="c:${info.id}"]`).boundingBox();
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx + i * 12, sy - i * 15);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const r = await page.evaluate(async (id) => {
    const { runErc } = await import('./js/check/erc.js');
    const p = window.pocketEDA.state.project;
    const c = p.schematic.sheets[0].components.find((x) => x.id === id);
    const e = runErc(p);
    return { x: c.x, y: c.y, errors: e.summary.errors, warnings: e.summary.warnings, msgs: e.issues.map((i) => i.message).slice(0, 5) };
  }, info.id);
  assert.ok(r.x !== info.x || r.y !== info.y, 'Y1 が動いていない');
  assert.deepEqual([r.errors, r.warnings], [0, 0], r.msgs.join('\n'));
  await page.screenshot({ path: `${OUT}/sample-move.png` });
});

await step('検査タブ: ERC・DRC のエラー 0、未配線 0', async () => {
  await ws('check');
  await page.waitForTimeout(500);
  const r = await page.evaluate(async () => {
    const { runErc } = await import('./js/check/erc.js');
    const { runDrc } = await import('./js/check/drc.js');
    const p = window.pocketEDA.state.project;
    const e = runErc(p), d = runDrc(p, p.pcb);
    return { erc: e.summary.errors, drc: d.summary.errors, unrouted: d.summary.unrouted, msgs: d.issues.filter((i) => i.level === 'error').map((i) => i.message).slice(0, 5) };
  });
  assert.deepEqual([r.erc, r.drc, r.unrouted], [0, 0, 0], r.msgs.join('\n'));
  await page.screenshot({ path: `${OUT}/sample-check.png` });
});

await step('出力タブ: 4層の注文一覧（.G1）が出る', async () => {
  await ws('output');
  await page.waitForSelector('.order-sheet', { state: 'attached' });
  const sheet = await page.locator('.order-sheet').textContent();
  assert.match(sheet, /G1/);
});

await step('3D 表示: 基板と部品が描かれる', async () => {
  await page.click('[data-3d]');
  await page.waitForFunction(() => document.querySelector('#viewer3d')._viewer);
  await page.waitForTimeout(500);
  const n = await page.evaluate(() => document.querySelector('#viewer3d')._viewer.stats.parts);
  assert.ok(n >= 60, `部品 ${n}`);
  await page.screenshot({ path: `${OUT}/sample-3d.png` });
  await page.evaluate(() => window.pocketEDA.back());
  await page.waitForSelector('#viewer3d', { state: 'hidden' });
});

await step('コンソールエラーなし', async () => {
  assert.deepEqual(errors.filter((e) => !/WebGL|GPU stall|GL_|swiftshader/i.test(e)), []);
});

await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
