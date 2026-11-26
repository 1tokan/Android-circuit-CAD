// 0.13.3: 部品一覧の組・検索、手書き用に足した部品（交流電源・トランス）、LCSC 品番の近道（3 手・まとめて）
// 使い方: SERVE=route node tests/e2e-parts-quick.mjs
import { openApp, OUT, PIXEL_UA } from './e2e-lib.mjs';
import assert from 'node:assert/strict';

const { page, step, ws, finish } = await openApp({ timeout: 8000, context: { userAgent: PIXEL_UA } });

const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector('#canvas').getBoundingClientRect();
  const s = window.pocketEDA.state.vp.worldToScreen(x, y);
  return { x: r.left + s.x, y: r.top + s.y };
}, [x, y]);
const tapWorld = async (x, y) => { const p = await toScreen(x, y); await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(80); };
const sheet = () => page.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0]);
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const comp = async (ref) => (await sheet()).components.find((c) => c.ref === ref);

// jlcsearch の応答（通信はテスト内で差し替える）。0805・Basic・在庫ありが先頭に並ぶはず
const R = (lcsc, pkg, basic, stock) => ({ lcsc, mfr: `RC${pkg}FR-0710KL`, package: pkg, description: `${pkg} 10kΩ ±1% 125mW Chip Resistor - Surface Mount`, stock, price: 0.001, is_basic: basic, is_preferred: false, category: 'Resistors', subcategory: 'Chip Resistor - Surface Mount', resistance: 10000 });
const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const queries = [];
await page.route('https://jlcsearch.tscircuit.com/**', (route) => {
  queries.push(new URL(route.request().url()).searchParams.get('q'));
  route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ components: [R(1, '0603', true, 9000), R(2, '0805', false, 100), R(3, '0805', true, 5000)] }) });
});

await step('部品の一覧: 組に分かれ、名前で探せる（トランス・交流電源がある）', async () => {
  await ws('schematic');
  await tool('place');
  if (!(await page.locator('#picker').isVisible())) await page.locator('#ctxbar [data-ctx="pick"]').click();
  assert.deepEqual(await page.locator('#picker .pick-h').allTextContents(), ['受動部品', 'ダイオード', 'トランジスタ・IC', '電源・入出力', 'シミュレーション用（基板に載らない）']);
  await page.locator('#picker-q').fill('トランス');
  assert.deepEqual(await page.locator('#picker .pick:visible').evaluateAll((b) => b.map((x) => x.dataset.kind)), ['transformer']);
  await page.screenshot({ path: `${OUT}/picker-search-phone.png` });
  await page.locator('#picker .pick[data-kind="transformer"]').click();
  await tapWorld(0, -20);
  await tool('place');
  if (!(await page.locator('#picker').isVisible())) await page.locator('#ctxbar [data-ctx="pick"]').click();
  await page.locator('#picker-q').fill('交流');
  await page.locator('#picker .pick[data-kind="vac"]').click();
  await tapWorld(-20, -20);
  const s = await sheet();
  assert.deepEqual(s.components.map((c) => [c.ref, c.kind]).sort(), [['T1', 'transformer'], ['V1', 'vac']]);
});

await step('抵抗を 3 つ置く', async () => {
  await tool('place');
  if (!(await page.locator('#picker').isVisible())) await page.locator('#ctxbar [data-ctx="pick"]').click();
  await page.locator('#picker-q').fill('');
  await page.locator('#picker .pick[data-kind="resistor"]').click();
  for (const x of [-12, 0, 12]) await tapWorld(x, 10);
  await tool('select');
  assert.equal((await sheet()).components.filter((c) => c.kind === 'resistor').length, 3);
});

await step('LCSC 品番: 部品を選ぶ →「品番を探す」→ 候補に触れる、の 3 手。同じ値の部品にもまとめて', async () => {
  await tapWorld(0, 10);
  const chip = page.locator('#ctxbar [data-ctx="lcsc"]');
  assert.match(await chip.textContent(), /品番を探す/);
  await chip.click();
  await page.waitForSelector('#dialog[open]');
  await page.waitForSelector('#dialog[open] .qp-row');
  assert.equal(await page.locator('#dialog .qp-q').inputValue(), '10k 0805');
  assert.ok(queries.includes('10k 0805'), queries.join(','));
  // 0805・Basic・在庫ありが先頭（C3）、形の違う 0603 は最後
  const rows = await page.locator('#dialog .qp-row .qp-main b').allTextContents();
  assert.deepEqual(rows, ['C3', 'C2', 'C1']);
  assert.match(await page.locator('#dialog .qp-sibs').locator('xpath=..').textContent(), /R1・R3 にも（2 個）/); // 真ん中の R2 を選んだ
  await page.screenshot({ path: `${OUT}/lcsc-quick-phone.png` });
  await page.locator('#dialog .qp-row').first().click();
  await page.waitForSelector('#dialog[open]', { state: 'detached' });
  // 部品データの保存（IndexedDB）を待ってから割り当てる
  await page.waitForFunction(() => window.pocketEDA.state.project.schematic.sheets[0].components.filter((c) => c.props.lcsc === 'C3').length === 3, null, { timeout: 5000 });
  for (const ref of ['R1', 'R2', 'R3']) {
    const c = await comp(ref);
    assert.equal(c.props.lcsc, 'C3', ref);
    assert.equal(c.props.footprint, 'R_0805', ref);
    assert.equal(c.kind, 'resistor', ref);
  }
  // 元に戻すは 1 回で 3 つとも戻り、やり直すと 3 つとも付く
  await page.evaluate(() => window.pocketEDA.undo());
  assert.equal((await sheet()).components.filter((c) => c.kind === 'resistor' && c.props.lcsc).length, 0);
  await page.evaluate(() => window.pocketEDA.redo());
  assert.equal((await sheet()).components.filter((c) => c.kind === 'resistor' && c.props.lcsc === 'C3').length, 3);
});

await step('品番なしをまとめて: 組ごとに順に（シミュ用の交流電源は数えない）。とばせる', async () => {
  await page.locator('#ctxbar [data-ctx="clear"]').click().catch(() => {});
  const all = page.locator('#ctxbar [data-ctx="lcscAll"]');
  assert.match(await all.textContent(), /品番なし 1 個/); // トランスだけ
  await all.click();
  await page.waitForSelector('#dialog[open]');
  assert.match(await page.locator('#dialog-body').textContent(), /T1（トランス・100V:12V）\s*1\/1 組目/);
  await page.locator('#dialog-actions button[value="skip"]').click();
  await page.waitForSelector('#dialog[open]', { state: 'detached' });
});

await step('シミュ用の交流電源は基板・BOM に載らない（ネットリストの部品に無い）', async () => {
  const nl = await page.evaluate(async () => (await import('./js/netlist/netlist.js')).generateNetlist(window.pocketEDA.state.project));
  assert.ok(!nl.components.some((c) => c.ref === 'V1'));
  assert.deepEqual(nl.simSources.map((s) => s.ref), ['V1']);
  assert.ok(nl.components.some((c) => c.ref === 'T1'));
  await tapWorld(-20, -20);
  const selected = await page.locator('#ctxbar .chip-info').first().textContent();
  assert.equal(selected, 'V1');
  assert.equal(await page.locator('#ctxbar [data-ctx="lcsc"]').count(), 0, 'シミュ用には品番のボタンを出さない');
});

await finish();
