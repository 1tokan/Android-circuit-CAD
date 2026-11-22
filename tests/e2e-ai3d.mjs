// Claude で作図・製造仕様（多層）・3D 表示の実ブラウザE2Eテスト（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-ai3d.mjs
// API は page.route でモックする（実際の Anthropic API には送らない）
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { SAMPLE } from './ai-sample.mjs';

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
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let apiReq = null;
await page.route('https://api.anthropic.com/**', async (route) => {
  apiReq = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(SAMPLE) }], stop_reason: 'end_turn', usage: { input_tokens: 1234, output_tokens: 567 } }) });
});
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();

await step('回路図の「Claude で作る」から開ける', async () => {
  await ws('schematic');
  await page.locator('[data-chip="ai"], .chip:has-text("Claude で作る")').first().click();
  await page.waitForSelector('#ai-view:not([hidden]) .ai-wrap');
});

await step('API に送る（モック）→ 返答と回路が表示される', async () => {
  await page.fill('#ai-key', 'sk-ant-test');
  await page.fill('#ai-text', 'USB 5V から 3.3V を作って LED を点けたい');
  await page.locator('#ai-text').dispatchEvent('input');
  await page.click('[data-send]');
  await page.waitForSelector('[data-apply="replace"]');
  assert.equal(apiReq.headers['x-api-key'], 'sk-ant-test');
  assert.equal(apiReq.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(apiReq.body.output_config.format.type, 'json_schema');
  assert.match(await page.locator('.ai-log').innerText(), /AMS1117/);
  assert.match(await page.locator('.ai-log').innerText(), /1234/);
});

await step('この回路図に作図 → 部品・ラベルが置かれ ERC エラー 0', async () => {
  await page.click('[data-apply="replace"]');
  await page.waitForFunction(() => window.pocketEDA.state.project.schematic.sheets[0].components.length > 0);
  const r = await page.evaluate(async () => {
    const { runErc } = await import('./js/check/erc.js');
    const p = window.pocketEDA.state.project;
    const sh = p.schematic.sheets[0];
    const refs = sh.components.map((c) => c.ref).filter(Boolean);
    const e = runErc(p);
    return { refs, errors: (e.issues || e).filter((x) => x.level === 'error').map((x) => x.message), aiTitle: p.ai?.spec?.title };
  });
  for (const ref of ['J1', 'U1', 'C1', 'R1', 'D1']) assert.ok(r.refs.includes(ref), `${ref} が無い: ${r.refs}`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.aiTitle, 'USB 3.3V 電源');
  await page.screenshot({ path: `${OUT}/ai-applied.png` });
});

await step('claude.ai 用の返答貼り付けでも読み込める', async () => {
  await page.evaluate(() => window.pocketEDA.openAi());
  await page.waitForSelector('#ai-view:not([hidden]) [data-paste]');
  await page.click('[data-paste]');
  await page.fill('#ai-paste', '以下です。\n```json\n' + JSON.stringify({ ...SAMPLE, reply: '貼り付けテスト' }) + '\n```');
  await page.click('#dialog-actions button[value="ok"]');
  await page.waitForFunction(() => /貼り付けテスト/.test(document.querySelector('.ai-log')?.innerText || ''));
  await page.click('#ai-view [data-close]');
  assert.equal(await page.locator('#ai-view').isHidden(), true);
});

await step('PCB に取り込み・出力タブで4層に変更すると積層構成と .G1 が注文一覧に出る', async () => {
  const r = await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const { partFootprint } = await import('./js/library/parts.js');
    const { generateNetlist } = await import('./js/netlist/netlist.js');
    const app = window.pocketEDA;
    const nl = generateNetlist(app.state.project);
    app.mutateProject((p) => { p.netlist = nl; });
    app.editPcb(() => {
      const b = pm.ensurePcb(app.state.project);
      pm.importNetlist(b, nl, (c) => partFootprint(app.state.project.library.parts.find((q) => q.id === c.partId)));
      pm.setOutlineRect(b, 40, 30);
      pm.arrangeInBoard?.(b);
    }, 'setup');
    return { n: pm.ensurePcb(app.state.project).footprints.length };
  });
  assert.ok(r.n >= 9);
  await ws('output');
  await page.waitForSelector('.fab select[name="layers"]');
  await page.selectOption('.fab select[name="layers"]', '4');
  await page.waitForSelector('.fab select[name="stackup"]');
  const s = await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const app = window.pocketEDA;
    const b = pm.ensurePcb(app.state.project);
    return { layers: b.settings.layers, fab: app.state.project.board.fab, cu: pm.copperLayers(b) };
  });
  assert.equal(s.layers, 4);
  assert.deepEqual(s.cu, ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  assert.ok(['JLC7628', 'JLC2313'].includes(s.fab.stackup));
  const sheet = await page.locator('.order-sheet').textContent();
  assert.match(sheet, /4/);
  assert.match(sheet, /G1/);
  await page.selectOption('.fab select[name="maskColor"]', 'blue');
  assert.equal(await page.evaluate(() => window.pocketEDA.state.project.board.fab.maskColor), 'blue');
});

await step('3D 表示が開き、基板・穴・部品が描かれる', async () => {
  await page.click('[data-3d]');
  await page.waitForSelector('#viewer3d:not([hidden]) canvas');
  await page.waitForFunction(() => document.querySelector('#viewer3d')._viewer);
  const st = await page.evaluate(() => {
    const v = document.querySelector('#viewer3d')._viewer;
    const c = v.renderer.domElement;
    // 中央付近のピクセルが背景色でないこと（基板が描けている）
    v.draw();
    const gl = v.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { ...v.stats, w: c.width, h: c.height, px: [...px] };
  });
  assert.ok(st.parts >= 9, `部品 ${st.parts}`);
  assert.ok(st.w > 100 && st.h > 100);
  const bg = [0x20, 0x25, 0x2d];
  assert.ok(st.px.slice(0, 3).some((v, i) => Math.abs(v - bg[i]) > 12), `中央が背景色のまま ${st.px}`);
  await page.screenshot({ path: `${OUT}/3d-iso.png` });
  await page.click('#viewer3d [data-view="top"]');
  await page.screenshot({ path: `${OUT}/3d-top.png` });
  await page.click('#viewer3d [data-view="bottom"]');
  await page.screenshot({ path: `${OUT}/3d-bottom.png` });
  await page.click('#viewer3d [data-parts]');
  assert.equal(await page.evaluate(() => document.querySelector('#viewer3d')._viewer.parts.visible), false);
});

await step('戻る操作で 3D 表示が閉じる', async () => {
  await page.evaluate(() => window.pocketEDA.back());
  await page.waitForSelector('#viewer3d', { state: 'hidden' });
});

await step('コンソールエラーなし', async () => {
  const real = errors.filter((e) => !/WebGL|GPU stall|GL_|swiftshader/i.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
