// KiCanvas（KiCad ビューア）で書き出しを読み直す画面の実ブラウザE2E（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-kicanvas.mjs
// ・本物の KiCanvas は kicanvas.org から読み込む。ここではネットに出られないので、同じ形の要素を作る代わりを page.route で返し、
//   sandbox の iframe・localStorage の代わり・postMessage・数の照合・ネットにつながらないときの表示を確かめる。
//   本物の KiCanvas での読み込みは Android の実機テスト（tests/device）で確かめる。
// ・google-chrome では sandbox の iframe の読み込みに page.route が効かないので、Playwright 同梱の Chromium を使う。
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
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();

await step('同梱サンプルを開き、出力 → KiCad タブ', async () => {
  await page.evaluate(() => window.pocketEDA.openSample('usb-dac-amp'));
  await ws('output');
  await page.locator('#output-view [data-tab="kicad"]').click();
  await page.locator('[data-kicanvas]').waitFor();
});

await step('KiCanvas: sandbox の中で読み直し、数を照合する（KiCanvas の代わりのスクリプトで配線を確認）', async () => {
  // 本物の KiCanvas は kicanvas.org から読む（ここではネットに出られないので、同じ形の要素を作る代わりを返す）
  const stub = `
    customElements.define('kc-board-viewer', class extends HTMLElement {});
    customElements.define('kicanvas-embed', class extends HTMLElement {
      connectedCallback() { setTimeout(() => {
        window.localStorage.setItem('kc:prefs', '{}'); // sandbox でも落ちない
        const src = this.querySelector('kicanvas-source').textContent;
        const n = (re) => (src.match(re) || []).length;
        const root = this.attachShadow({ mode: 'open' });
        const v = document.createElement('kc-board-viewer');
        v.viewer = { board: { version: Number(src.match(/\\(version (\\d+)\\)/)[1]), footprints: Array.from({ length: n(/^  \\(footprint /gm) }, () => ({ pads: [] })).map((f, i, a) => i === 0 ? { pads: new Array(n(/^    \\(pad /gm)) } : f),
          segments: new Array(n(/^  \\(segment /gm)), vias: new Array(n(/^  \\(via /gm)), zones: new Array(n(/^  \\(zone /gm)), nets: [], layers: [] } };
        root.appendChild(v);
      }, 50); }
    });`;
  await page.route('https://kicanvas.org/kicanvas/kicanvas.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
  await page.locator('[data-kicanvas]').click();
  const status = page.locator('.kicanvas-overlay .kicanvas-status');
  await status.filter({ hasText: '読み込めました' }).waitFor({ timeout: 10000 });
  assert.match(await status.textContent(), /部品 79・パッド 303・配線 702・ビア 319・ベタ 7 が書き出しと一致/);
  assert.equal(await page.locator('.kicanvas-overlay iframe').getAttribute('sandbox'), 'allow-scripts');
  await page.screenshot({ path: `${OUT}/output-kicanvas-phone.png` });
  await page.locator('.kicanvas-overlay [data-close]').click();
  assert.equal(await page.locator('.kicanvas-overlay').count(), 0);
  // ネットにつながらないとき
  await page.unroute('https://kicanvas.org/kicanvas/kicanvas.js');
  await page.route('https://kicanvas.org/kicanvas/kicanvas.js', (r) => r.abort());
  await page.locator('[data-kicanvas]').click();
  await status.filter({ hasText: 'ネット接続を確認' }).waitFor({ timeout: 10000 });
  await page.locator('.kicanvas-overlay [data-close]').click();
});

await step('コンソールエラーは、ネット切れを試したときの読み込み失敗だけ', async () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
});

await browser.close();
const ok = results.filter((r) => r[0] === 'OK').length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
