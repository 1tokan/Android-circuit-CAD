// 実ブラウザ(Chrome)での第1段階E2Eテスト
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e.mjs
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const URL_ = process.env.URL || 'http://localhost:8765/';
const OUT = process.env.OUT || 'tests/out';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['OK', name]); console.log('OK  ', name); }
  catch (e) { results.push(['NG', name, e.message]); console.log('NG  ', name, '\n     ', e.message); }
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36',
  acceptDownloads: true,
});
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const ready = () => page.waitForSelector('html[data-ready="1"]', { timeout: 10000 });
const saveState = () => page.locator('#save-state').getAttribute('data-state');

await page.goto(URL_);
await ready();

await step('初回起動でプロジェクトが作成・保存される', async () => {
  assert.equal(await page.locator('#project-name').textContent(), 'はじめてのプロジェクト');
  const list = await page.evaluate(() => window.pocketEDA.store.listProjects());
  assert.equal(list.length, 1);
});

await step('スマホ縦画面: 上部・タブ・キャンバス・下部ツールが画面内', async () => {
  for (const sel of ['.topbar', '#ws-nav', '#canvas', '#toolbar']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b && b.width > 0 && b.height > 0 && b.y + b.height <= 844 + 1, sel + JSON.stringify(b));
  }
  const canvas = await page.locator('#canvas').boundingBox();
  assert.ok(canvas.height > 500, 'キャンバスが十分な高さ: ' + canvas.height);
  await page.screenshot({ path: `${OUT}/phone-portrait.png` });
});

await step('全段階の機能が有効（未実装の表示なし）・出力タブのツールが有効', async () => {
  await page.locator('#ws-nav button[data-ws="output"]').click();
  assert.equal(await page.locator('#ws-nav button[aria-current="page"]').getAttribute('data-ws'), 'output');
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  for (const id of ['gerber', 'bom', 'cpl']) assert.ok(await page.locator(`#toolbar .tool[data-tool="${id}"]`).isEnabled(), id);
  assert.doesNotMatch(await page.locator('#module-status').textContent(), /未実装/);
  assert.equal(await page.locator('#ws-nav .badge').count(), 0);
  await page.locator('#ws-nav button[data-ws="schematic"]').click();
  assert.ok(!(await page.locator('#stage-overlay').isVisible()), '回路図はキャンバスを塞がない');
  assert.ok(await page.locator('#toolbar .tool:not([disabled])').count() >= 8);
});

await step('名前変更→自動保存→再読込で復元', async () => {
  await page.locator('#project-name').click();
  await page.locator('#dlg-input').fill('LED点灯回路A');
  await page.locator('#dlg-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'LED点灯回路A');
  assert.ok(['dirty', 'saving', 'saved'].includes(await saveState()));
  await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved', null, { timeout: 5000 });
  await page.reload();
  await ready();
  assert.equal(await page.locator('#project-name').textContent(), 'LED点灯回路A');
});

await step('アプリ切替（非表示）時に即保存される', async () => {
  await page.evaluate(() => {
    window.pocketEDA.state.saver.delay = 60000; // タイマーでは保存されない状態にする
    window.pocketEDA.mutateProject((p) => { p.board.fab.thicknessMm = 1.0; });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved', null, { timeout: 3000 });
  await page.reload();
  await ready();
  const t = await page.evaluate(() => window.pocketEDA.state.project.board.fab.thicknessMm);
  assert.equal(t, 1.0);
});

let exportedPath;
await step('JSON書き出し: 正しい形式のファイル', async () => {
  await page.locator('#btn-menu').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="export"]').click()]);
  assert.match(dl.suggestedFilename(), /^LED点灯回路A\.pocketeda\.json$/);
  exportedPath = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(exportedPath);
  const j = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
  assert.equal(j.format, 'pocket-eda-project');
  assert.equal(j.name, 'LED点灯回路A');
  assert.equal(j.board.fab.thicknessMm, 1.0);
  assert.equal(j.checks.drc, null);
});

await step('同じIDのJSON読込→「コピーとして追加」で2件に', async () => {
  await page.locator('#btn-projects').click();
  await page.locator('#file-import').setInputFiles(exportedPath);
  await page.locator('#dialog-actions button[value="copy"]').click();
  await page.waitForFunction(() => document.querySelector('#project-name').textContent.includes('コピー'));
  const list = await page.evaluate(() => window.pocketEDA.store.listProjects());
  assert.equal(list.length, 2);
});

await step('壊れたJSONの読込はエラー表示し、データは変わらない', async () => {
  const bad = `${OUT}/bad.json`;
  fs.writeFileSync(bad, '{"format":"pocket-eda-project","schemaVersion":99,"id":"x"}');
  await page.locator('#btn-projects').click();
  await page.locator('#file-import').setInputFiles(bad);
  await page.waitForSelector('#toast.error:not([hidden])');
  assert.match(await page.locator('#toast').textContent(), /新しいバージョン/);
  const list = await page.evaluate(() => window.pocketEDA.store.listProjects());
  assert.equal(list.length, 2);
  await page.locator('#btn-drawer-close').click();
});

await step('保存履歴から復元', async () => {
  await page.evaluate(async () => {
    window.pocketEDA.mutateProject((p) => { p.name = '変更後'; });
    await window.pocketEDA.saveNow();
  });
  await page.locator('#btn-menu').click();
  await page.locator('[data-act="backups"]').click();
  const items = page.locator('#dialog-body [data-key]');
  await items.first().waitFor();
  assert.ok(await items.count() >= 2);
  await items.nth(1).click(); // 1つ前の保存
  await page.waitForFunction(() => document.querySelector('#project-name').textContent !== '変更後');
  assert.match(await page.locator('#project-name').textContent(), /コピー/);
});

await step('プロジェクト削除（履歴も削除）', async () => {
  const id = await page.evaluate(() => window.pocketEDA.state.project.id);
  await page.locator('#btn-projects').click();
  await page.locator('#project-list li.current button[aria-label$="を削除"]').click();
  await page.locator('#dialog-actions button[value="del"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-list li').length === 1);
  const b = await page.evaluate((i) => window.pocketEDA.store.listBackups(i), id);
  assert.equal(b.length, 0);
  assert.equal(await page.locator('#project-name').textContent(), 'LED点灯回路A');
  await page.screenshot({ path: `${OUT}/phone-drawer.png` });
  await page.locator('#btn-drawer-close').click();
});

await step('ホイールズーム・中ボタンドラッグでパン', async () => {
  const s0 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  const s1 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  assert.ok(s1 > s0, `${s0}→${s1}`);
  const x0 = await page.evaluate(() => window.pocketEDA.state.vp.x);
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(250, 420, { steps: 5 }); await page.mouse.up({ button: 'middle' });
  const x1 = await page.evaluate(() => window.pocketEDA.state.vp.x);
  assert.ok(x1 < x0, 'パン');
});

await step('2本指ピンチで拡大（タッチイベント）', async () => {
  const cdp = await ctx.newCDPSession(page);
  const s0 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  const tp = (id, x, y) => ({ x, y, id });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, 170, 400)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, 170, 400), tp(2, 220, 400)] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, 170 - i * 15, 400), tp(2, 220 + i * 15, 400)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  const s1 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  assert.ok(s1 > s0 * 2, `${s0}→${s1}`);
});

await step('オフラインでも起動し、保存できる', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // SW の制御下に入れる
  await ready();
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SW制御下');
  await ctx.setOffline(true);
  await page.reload();
  await ready();
  assert.equal(await page.locator('#project-name').textContent(), 'LED点灯回路A');
  await page.evaluate(async () => { window.pocketEDA.mutateProject((p) => { p.name = 'オフライン編集'; }); await window.pocketEDA.saveNow(); });
  await page.reload();
  await ready();
  assert.equal(await page.locator('#project-name').textContent(), 'オフライン編集');
  await ctx.setOffline(false);
});

await step('タブレット横画面: 左レール＋右パネルのPC風配置', async () => {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await tab.goto(URL_);
  await tab.waitForSelector('html[data-ready="1"]');
  const nav = await tab.locator('#ws-nav').boundingBox();
  const side = await tab.locator('#side-panel').boundingBox();
  assert.ok(nav.x < 5 && nav.height > 400, 'left rail');
  assert.ok(side && side.x > 1000, 'right panel');
  await tab.screenshot({ path: `${OUT}/tablet-landscape.png` });
  await tab.close();
});

await step('manifest がインストール要件を満たす', async () => {
  const m = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
});

await step('戻る操作: ドロワー → メニュー → PCB画面 → 回路図の順に戻り、最後は false（アプリを閉じてよい）', async () => {
  const back = () => page.evaluate(() => window.pocketEDA.back());
  await page.locator('#ws-nav button[data-ws="pcb"]').click();
  await page.locator('#btn-projects').click();
  assert.equal(await back(), true);
  assert.ok(await page.locator('#drawer').isHidden());
  await page.locator('#btn-menu').click();
  assert.ok(await page.locator('#menu').isVisible());
  assert.equal(await back(), true);
  assert.ok(await page.locator('#menu').isHidden());
  assert.equal(await page.evaluate(() => window.pocketEDA.state.workspace), 'pcb', 'メニューを閉じても画面はそのまま');
  await page.locator('#toolbar .tool[data-tool="route"]').click();
  assert.equal(await back(), true);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.pcbEditor.state.tool), 'select', '操作中のツールを取り消す');
  assert.equal(await back(), true);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.workspace), 'schematic');
  assert.equal(await back(), false);
});

await step('小さい画面（360×640）でも全タブが横にはみ出さない', async () => {
  await page.setViewportSize({ width: 360, height: 640 });
  for (const ws of ['schematic', 'pcb', 'parts', 'check', 'output']) {
    await page.locator(`#ws-nav button[data-ws="${ws}"]`).click();
    await page.waitForTimeout(150);
    const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    assert.ok(sw <= 361, `${ws}: 横幅 ${sw}px`);
    // ツールボタンは指で押せる大きさ（高さ 40px 以上）
    const small = await page.evaluate(() => [...document.querySelectorAll('#toolbar .tool')].filter((b) => b.getBoundingClientRect().height < 40).length);
    assert.equal(small, 0, `${ws}: 小さすぎるツールボタン`);
  }
  await page.screenshot({ path: `${OUT}/small-360-output.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#ws-nav button[data-ws="schematic"]').click();
});

await step('古い WebView（structuredClone 等が無い）では本体を読み込まず、更新を案内する', async () => {
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c2.addInitScript(() => { delete window.structuredClone; });
  const p2 = await c2.newPage();
  await p2.goto(URL_);
  await p2.waitForSelector('#unsupported');
  assert.match(await p2.locator('#unsupported').textContent(), /Android System WebView/);
  assert.equal(await p2.evaluate(() => document.documentElement.dataset.ready), undefined, '本体は読み込まない');
  await c2.close();
});

await step('コンソールエラーなし', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} passed`);
process.exit(ng.length ? 1 : 0);
