// 回路シミュレーション画面の実ブラウザE2E（スマホ）。同梱サンプルで、信号源の追加・過渡・動作点・AC・カーソル・FFT・モデルの変更・SPICE 書き出し
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-sim.mjs
import { openApp, OUT } from './e2e-lib.mjs';
import assert from 'node:assert/strict';

const { page, errors, step, ws, finish } = await openApp({ timeout: 30000 });
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const sim = () => page.evaluate(() => window.pocketEDA.state.project.sim);
const dialog = async (fields, btn = 'ok') => {
  for (const [k, v] of Object.entries(fields)) {
    const el = page.locator(`#dialog-body [name="${k}"]`);
    if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(v); else await el.fill(v);
  }
  await page.click(`#dialog-actions button[value="${btn}"]`);
};

await page.evaluate(() => window.pocketEDA.openSample('usb-dac-amp'));

await step('シミュ タブ: 画面が出て、ツール 3 つが使え、一部実装の印がある', async () => {
  await ws('sim');
  assert.ok(await page.locator('#sim-view').isVisible());
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  assert.equal(await page.locator('#toolbar .tool:not([disabled])').count(), 3);
  assert.equal(await page.locator('#ws-nav button[data-ws="sim"] .badge.partial').count(), 1);
  // サンプルには信号源 2 つ（USB の立ち上がり・DAC の出力の AC）が入っていて、開いてすぐ計算できる
  assert.match(await page.locator('#sim-view').textContent(), /信号源（2）/);
});

await step('信号源: サンプルの 2 つ。新しい信号源は空いたネットが既定で、同じネットの電圧源は保存できない', async () => {
  const s = await sim();
  assert.deepEqual(s.sources.map((x) => x.name), ['VBUS_IN', 'VDAC']);
  assert.deepEqual(s.sources[0].wave, { type: 'pulse', p: ['0', '5', '1m', '100u', '1m', '1', '2'] });
  assert.match(await page.locator('#sim-view').textContent(), /VBUS_IN 電圧源 VBUS → GND/);
  await tool('source');
  const pos = await page.locator('#dialog-body [name="pos"]').inputValue();
  assert.ok(!['VBUS', 'DAC_OUTL', 'GND'].includes(pos), pos);
  await dialog({ pos: 'VBUS', dc: '5' });
  await page.waitForSelector('.toast', { hasText: /電圧源 VBUS_IN があります/ }).catch(() => {});
  assert.match(await page.locator('body').textContent(), /電圧源 VBUS_IN があります/);
  await page.click('#dialog-actions button[value=""]').catch(() => {});
  assert.equal((await sim()).sources.length, 2);
});

await step('電圧源のループは計算の前に名前を挙げて知らせる', async () => {
  await page.evaluate(() => window.pocketEDA.mutateProject((p) => { p.sim.sources.push({ id: 'x', name: 'V9', type: 'V', pos: 'VBUS', neg: '+5V_SYS', dc: '0', acMag: '', acPh: '', wave: { type: 'none', p: [] } }, { id: 'y', name: 'V8', type: 'V', pos: '+5V_SYS', neg: 'GND', dc: '5', acMag: '', acPh: '', wave: { type: 'none', p: [] } }); }, 'sim'));
  await page.locator('#sim-view [data-type="op"]').click();
  await tool('run');
  await page.waitForFunction(() => /電圧源がループ/.test(document.querySelector('#sim-view').textContent + document.body.textContent), null, { timeout: 10000 });
  await page.evaluate(() => window.pocketEDA.mutateProject((p) => { p.sim.sources = p.sim.sources.filter((x) => !['V9', 'V8'].includes(x.name)); }, 'sim'));
  await page.locator('#sim-view [data-type="tran"]').click();
});

await step('過渡解析: 300ms を計算し、+5V_SYS が約 100ms で 4.5V（ngspice と同じ）', async () => {
  await page.locator('[data-an="tran.tstep"]').fill('100u'); await page.locator('[data-an="tran.tstep"]').dispatchEvent('change');
  await page.locator('[data-an="tran.tstop"]').fill('300m'); await page.locator('[data-an="tran.tstop"]').dispatchEvent('change');
  await tool('run');
  await page.waitForSelector('#sim-view .sim-plot');
  // 信号を選ぶ
  await page.evaluate(() => window.pocketEDA.mutateProject((p) => { p.sim.probes = ['V(VBUS)', 'V(+5V_SYS)', 'V(SYS_G)']; }, 'sim'));
  await page.locator('#sim-view [data-act="zoomall"]').click();
  const txt = await page.locator('#sim-view').textContent();
  assert.match(txt, /過渡・\d+ms・\d+ 点/);
  assert.match(txt, /測定（表示している範囲）/);
  const t45 = await page.evaluate(() => { const r = window.pocketEDA.state.simView.result(); const i = r.names.indexOf('V(+5V_SYS)'); const v = r.tran.y[i]; return r.tran.t[v.findIndex((x) => x >= 4.5)]; });
  assert.ok(Math.abs(t45 - 0.0991) < 0.002, String(t45));
  await page.screenshot({ path: `${OUT}/sim-tran-phone.png`, fullPage: true });
});

await step('グラフをタップするとカーソル A・B と値の表、間を拡大できる', async () => {
  const box = await page.locator('#sim-view .sim-plot').boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  const txt = await page.locator('#sim-view').textContent();
  assert.match(txt, /B−A/);
  await page.locator('#sim-view [data-act="zoomin"]').click();
  assert.equal(await page.locator('#sim-view .plot-cursor').count(), 2);
});

await step('FFT に切り替えられる', async () => {
  await page.locator('#sim-view [data-act="fft"]').click();
  assert.match(await page.locator('#sim-view .legend-row').textContent(), /FFT V\(\+5V_SYS\) dB/);
  await page.locator('#sim-view [data-act="fft"]').click();
});

await step('動作点: 表にネットの電圧と部品の電流が出る', async () => {
  await page.locator('#sim-view [data-type="op"]').click();
  await tool('run');
  await page.waitForSelector('#sim-view h4');
  const txt = await page.locator('#sim-view').textContent();
  assert.match(txt, /ネットの電圧/); assert.match(txt, /V\(\+5V_SYS\)/); assert.match(txt, /Q1.*Vgs/);
});

await step('AC: DAC の出力の RC（470Ω・2.2nF）の −3dB が約 154kHz', async () => {
  await page.locator('#sim-view [data-type="ac"]').click();
  await page.locator('[data-an="ac.fstop"]').fill('10M'); await page.locator('[data-an="ac.fstop"]').dispatchEvent('change');
  await page.evaluate(() => window.pocketEDA.mutateProject((p) => { p.sim.probes = ['V(LINE_L)']; }, 'sim'));
  await tool('run');
  await page.waitForSelector('#sim-view .sim-plot');
  const f3 = await page.evaluate(() => {
    const r = window.pocketEDA.state.simView.result(); const i = r.names.indexOf('V(LINE_L)');
    const m = r.ac.re[i].map((x, k) => Math.hypot(x, r.ac.im[i][k]));
    return r.ac.f[m.findIndex((v) => v < Math.SQRT1_2)];
  });
  const fc = 1 / (2 * Math.PI * 470 * 2.2e-9);
  assert.ok(f3 > fc * 0.85 && f3 < fc * 1.3, `${f3} / ${fc}`);
  assert.match(await page.locator('#sim-view').textContent(), /−3dB の周波数/);
});

await step('部品のモデル: Q1 は AO3401A。計算から外すと表に「外す」', async () => {
  await page.locator('#sim-view details.sim-sec >> nth=1').evaluate((d) => { d.open = true; });
  const row = page.locator('#sim-view tr[data-model]', { hasText: 'Q1' });
  assert.match(await row.textContent(), /AO3401A/);
  await row.locator('button').click();
  await dialog({ mode: 'off' });
  await page.waitForFunction(() => Object.values(window.pocketEDA.state.project.sim?.models || {}).some((m) => m.mode === 'off'), null, { timeout: 5000 });
  const id = await page.evaluate(() => Object.keys(window.pocketEDA.state.project.sim.models)[0]);
  assert.equal((await sim()).models[id].mode, 'off');
  await page.locator('#sim-view details.sim-sec >> nth=1').evaluate((d) => { d.open = true; });
  await page.locator('#sim-view tr[data-model]', { hasText: /Q1[\s\S]*外す/ }).waitFor({ timeout: 5000 });
});

await step('SPICE 書き出し: ngspice で読めるネットリスト', async () => {
  const text = await page.evaluate(async () => { const m = await import('./js/sim/circuit.js'); return m.exportSpice(window.pocketEDA.state.project, { version: 'e2e' }); });
  assert.match(text, /^\.ac dec 20 10 10Meg$/m);
  assert.match(text, /^VDAC DAC_OUTL 0 DC 0 AC 1 0$/m);
  assert.match(text, /\* Q1（AO3401A）: シミュレーションから外す/);
  assert.match(text, /^\.end$/m);
});

await step('コンソールエラーなし', async () => { assert.deepEqual(errors, []); });
await finish();
