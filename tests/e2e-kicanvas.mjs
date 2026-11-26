// KiCanvas（KiCad ビューア）で書き出しを読み直す画面の実ブラウザE2E（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-kicanvas.mjs
// ・本物の KiCanvas は kicanvas.org から読み込む。ここではネットに出られないので、同じ形の要素を作る代わりを page.route で返し、
//   sandbox の iframe・localStorage の代わり・postMessage・数の照合・ネットにつながらないときの表示を確かめる。
//   本物の KiCanvas での読み込みは Android の実機テスト（tests/device）で確かめる。
// ・google-chrome では sandbox の iframe の読み込みに page.route が効かないので、Playwright 同梱の Chromium を使う。
import { openApp, OUT } from './e2e-lib.mjs';
import assert from 'node:assert/strict';

const { page, errors, step, ws, finish } = await openApp({ timeout: 20000, bundled: true });

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
  assert.match(await status.textContent(), /部品 79・パッド 307・配線 737・ビア 357・ベタ 7 が書き出しと一致/);
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

await finish();
