// E2Eテスト共通ハーネス（スマホ表示の実ブラウザ起動・step 記録・エラー収集・終了処理）
// 使い方: const { page, step, ws, errors, finish } = await openApp({ timeout: 6000 });
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';

export const URL_ = process.env.URL || 'http://localhost:8765/';
export const OUT = process.env.OUT || 'tests/out';
fs.mkdirSync(OUT, { recursive: true });

export const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36';
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/**
 * @param {object} o
 * @param {number} [o.timeout] page のデフォルトタイムアウト(ms)
 * @param {boolean} [o.gpu] WebGL 用に SwiftShader を有効化
 * @param {object} [o.context] newContext へ追加するオプション
 * @param {boolean} [o.bundled] Playwright 同梱の Chromium を使う（sandbox iframe に page.route を効かせるため）
 * @param {boolean} [o.open] true(既定)なら URL_ を開いて起動完了を待つ
 */
export async function openApp({ timeout = 6000, gpu = false, context = {}, bundled = false, open = true } = {}) {
  const args = ['--no-sandbox', '--no-proxy-server', '--disable-background-networking'];
  if (gpu) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const browser = await chromium.launch({
    executablePath: !bundled && fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    headless: true,
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    args,
  });
  const ctx = await browser.newContext({ ...MOBILE, ...context });
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (open) {
    await page.goto(URL_);
    await page.waitForSelector('html[data-ready="1"]');
  }
  const results = [];
  async function step(name, fn) {
    try { await fn(); results.push(['OK', name]); console.log('OK  ', name); }
    catch (e) { results.push(['NG', name, e.message]); console.log('NG  ', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); }
  }
  const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();
  async function finish() {
    await browser.close();
    const ng = results.filter((r) => r[0] === 'NG');
    console.log(`\n${results.length - ng.length}/${results.length} passed`);
    process.exit(ng.length ? 1 : 0);
  }
  return { browser, ctx, page, errors, results, step, ws, finish };
}
