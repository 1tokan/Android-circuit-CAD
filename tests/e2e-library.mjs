// 第3段階: 部品ライブラリ・LCSC部品取込・ネットリストの実ブラウザE2Eテスト
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-library.mjs
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
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');

const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector('#canvas').getBoundingClientRect();
  const s = window.pocketEDA.state.vp.worldToScreen(x, y);
  return { x: r.left + s.x, y: r.top + s.y };
}, [x, y]);
const tapWorld = async (x, y) => { const p = await toScreen(x, y); await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(60); };
const sheet = () => page.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0]);
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const closeDialog = () => page.locator('#dialog-actions button[value=""]').first().click();

await step('部品タブ: 内蔵部品が一覧に出て「未実装」表示がない', async () => {
  await ws('parts');
  assert.ok(await page.locator('#parts-view').isVisible());
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  assert.ok(await page.locator('#pv-list .pv-item').count() >= 20);
  assert.match(await page.locator('#pv-count').textContent(), /内蔵25/);
  assert.equal(await page.locator('#toolbar .tool:not([disabled])').count(), 4);
});

await step('検索: 値の表記ゆれ（0.1uF = 100nF）とLCSC品番', async () => {
  await page.locator('#pv-q').fill('0.1uF 0402');
  await page.waitForTimeout(300);
  assert.match(await page.locator('#pv-list .pv-item').first().textContent(), /C1525/);
  await page.locator('#pv-q').fill('C1525');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#pv-list .pv-item').count(), 1);
  await page.screenshot({ path: `${OUT}/parts-phone.png` });
});

await step('詳細: ピン↔パッド対応表、フットプリント図、LCSCリンク', async () => {
  await page.locator('#pv-list .pv-item').first().click();
  await page.waitForSelector('#dialog[open]');
  const body = page.locator('#dialog-body');
  assert.match(await body.textContent(), /ピン↔パッド対応にエラーなし/);
  assert.equal(await body.locator('.fp-preview .pad').count(), 2);
  assert.equal(await body.locator('a[href="https://www.lcsc.com/product-detail/C1525.html"]').count(), 1);
  assert.match(await body.textContent(), /KiCad 公式と照合済み/);
  await page.screenshot({ path: `${OUT}/parts-detail-phone.png` });
});

await step('「回路図に配置」→ タップで配置、部品データ・LCSC品番・フットプリントが入る', async () => {
  await page.locator('#dialog-actions button[value="place"]').click();
  await page.waitForSelector('#ws-nav button[data-ws="schematic"][aria-current="page"]');
  await tapWorld(0, -15);
  const c = (await sheet()).components.at(-1);
  assert.equal(c.kind, 'capacitor');
  assert.equal(c.props.lcsc, 'C1525');
  assert.equal(c.props.footprint, 'C_0402');
  assert.equal(c.props.value, '100n');
  assert.equal(c.props.partId, 'lcsc:C1525');
  const lib = await page.evaluate(() => window.pocketEDA.state.project.library.parts.map((p) => p.id));
  assert.deepEqual(lib, ['lcsc:C1525'], 'プロジェクトに部品データがコピーされる');
});

await step('CSV取込（JLCPCB形式）→ 確認ダイアログ → 一覧に追加', async () => {
  const csv = [
    'LCSC Part,First Category,Second Category,MFR.Part,Package,Solder Joint,Manufacturer,Library Type,Description,Datasheet,Price,Stock',
    'C25804,Resistors,Chip Resistor - Surface Mount,0603WAF1002T5E,0603,2,UNI-ROYAL,Basic,"10kΩ ±1% 100mW 0603 Chip Resistor",,"1-199:0.0005",1000000',
    'C6186,Power Management ICs,Linear Voltage Regulators (LDO),AMS1117-3.3,SOT-223,4,AMS,Basic,"1A 3.3V LDO",,0.06,500',
    'C999999,Embedded,MCU,UNKNOWN-QFN,QFN-56,57,Foo,Extended,"MCU QFN-56",,1.2,10',
  ].join('\n');
  fs.writeFileSync(`${OUT}/jlc.csv`, csv);
  await ws('parts');
  await page.locator('#pv-file').setInputFiles(`${OUT}/jlc.csv`);
  await page.waitForSelector('#dialog[open]');
  const t = await page.locator('#dialog-body').textContent();
  assert.match(t, /3件/);
  assert.match(t, /1件はフットプリントを推定できませんでした/);
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => /取込\/登録3/.test(document.querySelector('#pv-count').textContent));
  await page.locator('#pv-q').fill('C25804');
  await page.waitForTimeout(300);
  const item = await page.locator('#pv-list .pv-item').first().textContent();
  assert.match(item, /Basic/);
  assert.match(item, /在庫 1,000,000/);
});

await step('取り込んだ部品は再読込後も残る（IndexedDB）', async () => {
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  await ws('parts');
  assert.match(await page.locator('#pv-count').textContent(), /取込\/登録3/);
});

await step('自動保存の待ち時間中に再読込しても変更が失われない（緊急退避）', async () => {
  await page.evaluate(() => {
    window.pocketEDA.state.saver.delay = 60000;
    window.pocketEDA.mutateProject((p) => { p.name = '退避テスト'; });
  });
  const before = await page.evaluate(() => [window.pocketEDA.state.saver.dirty, window.pocketEDA.state.project.schematic.sheets[0].components.length]);
  assert.equal(before[0], true, '未保存の状態で');
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  const after = await page.evaluate(() => [window.pocketEDA.state.project.name, window.pocketEDA.state.project.schematic.sheets[0].components.length]);
  assert.equal(after[0], '退避テスト');
  assert.equal(after[1], before[1], '回路図も残る');
  assert.equal(await page.evaluate(() => localStorage.getItem('pocket-eda:pending')), null, '復元後は退避データを消す');
  await ws('parts');
});

await step('手動登録: ピン対応の誤りは警告して確認', async () => {
  await tool('add');
  await page.waitForSelector('#dialog[open]');
  const f = (n) => page.locator(`#dialog-body [name="${n}"]`);
  await f('name').fill('テスト用 MOSFET');
  await f('kind').selectOption('nmos');
  await f('lcsc').fill('c20917');
  await f('footprint').selectOption('SOT-23');
  await f('pinMap').fill('1:1\n2:1\n3:3');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => document.querySelector('#dialog-title').textContent.includes('エラー'));
  assert.match(await page.locator('#dialog-body').textContent(), /重複/);
  await page.locator('#dialog-actions button[value=""]').click(); // 戻る → 保存しない
  assert.match(await page.locator('#pv-count').textContent(), /取込\/登録3/);
});

await step('手動登録: 正しい内容で保存', async () => {
  await tool('add');
  await page.waitForSelector('#dialog[open]');
  const f = (n) => page.locator(`#dialog-body [name="${n}"]`);
  await f('name').fill('AO3400A 手動');
  await f('kind').selectOption('nmos');
  await f('value').fill('AO3400A');
  await f('lcsc').fill('c20917');
  await f('footprint').selectOption('SOT-23');
  await f('specs').fill('Vds=30V\nId=5.7A');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => /取込\/登録4/.test(document.querySelector('#pv-count').textContent));
  const p = await page.evaluate(() => window.pocketEDA.state.lib.get('lcsc:C20917'));
  assert.equal(p.lcsc, 'C20917');
  assert.equal(p.specs.Vds, '30V');
  assert.equal(p.lcscVerified, false, '手入力の品番は未確認');
});

await step('回路図の部品に「ライブラリから選ぶ」で割り当て', async () => {
  await ws('schematic');
  await tool('place');
  await page.locator('#picker-grid .pick[data-kind="resistor"]').click();
  await tapWorld(-10, 0);
  const r = (await sheet()).components.find((c) => c.kind === 'resistor');
  await tool('select');
  await page.evaluate((id) => { window.pocketEDA.state.editor.state.sel = new Set([`c:${id}`]); window.pocketEDA.state.editor.editProps(); }, r.id);
  await page.waitForSelector('#dialog[open]');
  await page.locator('#dialog-actions button[value="lib"]').click();
  await page.locator('#pv-assign').waitFor({ state: 'visible' });
  assert.match(await page.locator('#pv-assign').textContent(), new RegExp(r.ref));
  await page.locator('#pv-q').fill('C25804');
  await page.waitForTimeout(300);
  await page.locator('#pv-list .pv-item').first().click();
  await page.locator('#dialog-actions button[value="assign"]').click();
  await page.waitForSelector('#ws-nav button[data-ws="schematic"][aria-current="page"]');
  const r2 = (await sheet()).components.find((c) => c.id === r.id);
  assert.equal(r2.props.lcsc, 'C25804');
  assert.equal(r2.props.footprint, 'R_0603');
  assert.equal(r2.props.value, '10k');
});

await step('ネットリスト: 生成→保存、エラーなし、JSON書出の内容', async () => {
  // C1(100n) と R(10k) を直列にして両端をコネクタへ
  await page.evaluate(async () => {
    const m = await import('./js/schematic/model.js');
    const { BUILTIN_PARTS } = await import('./js/library/parts.js');
    const app = window.pocketEDA;
    const hdr = BUILTIN_PARTS.find((p) => p.name.startsWith('ピンヘッダ 1x02'));
    app.editSchematic(() => {
      const sh = app.state.project.schematic.sheets[0];
      const c = sh.components.find((x) => x.kind === 'capacitor');   // (0,-15) ピン (-2,-15),(2,-15)
      const r = sh.components.find((x) => x.kind === 'resistor');    // (-10,0) ピン (-14,0),(-6,0)
      const j = m.addComponent(sh, 'connector', -24, -8, { partId: hdr.id, footprint: hdr.footprint, value: hdr.value, pinCount: 2, pinNames: '' }); // ピン (-28,-9),(-28,-7)
      m.addWirePath(sh, [{ x: -6, y: 0 }, { x: -6, y: -15 }, { x: -2, y: -15 }]);
      m.addWirePath(sh, [{ x: 2, y: -15 }, { x: 6, y: -15 }, { x: 6, y: -22 }, { x: -30, y: -22 }, { x: -30, y: -9 }, { x: -28, y: -9 }]);
      m.addWirePath(sh, [{ x: -14, y: 0 }, { x: -30, y: 0 }, { x: -30, y: -7 }, { x: -28, y: -7 }]);
      void c; void r; void j;
    }, 'test');
    app.state.editor.render();
    // ヘッダの部品データをプロジェクトに登録
    app.mutateProject((p) => { p.library.parts.push(hdr); });
  });
  await page.locator('#btn-menu').click();
  await page.locator('[data-act="netlist"]').click();
  await page.waitForSelector('#dialog[open]');
  const t = await page.locator('#dialog-body').textContent();
  assert.match(t, /部品 3・ネット 3・エラー 0/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#dialog-actions button[value="json"]').click()]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const nl = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(nl.format, 'pocket-eda-netlist');
  const nodes = nl.nets.map((n) => n.nodes.map((x) => `${x.ref}-${x.pad}`).sort().join(' ')).sort();
  assert.deepEqual(nodes, ['C1-1 R1-2', 'C1-2 J1-1', 'J1-2 R1-1']);
  const st = await page.evaluate(() => window.pocketEDA.state.project.netlist.summary);
  assert.equal(st.errors, 0);
});

await step('回路図を変えるとネットリストが「古い」と判定される', async () => {
  const s0 = await page.evaluate(async () => (await import('./js/netlist/netlist.js')).netlistStatus(window.pocketEDA.state.project));
  assert.equal(s0, 'current');
  await page.evaluate(() => window.pocketEDA.editSchematic(() => { window.pocketEDA.state.project.schematic.sheets[0].components[0].props.value = '220n'; }, 'test'));
  const s1 = await page.evaluate(async () => (await import('./js/netlist/netlist.js')).netlistStatus(window.pocketEDA.state.project));
  assert.equal(s1, 'stale');
});

await step('プロジェクト保存→再読込でネットリストと部品データも復元', async () => {
  await page.evaluate(() => window.pocketEDA.saveNow());
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  const p = await page.evaluate(() => window.pocketEDA.state.project);
  assert.equal(p.netlist.format, 'pocket-eda-netlist');
  assert.ok(p.library.parts.some((x) => x.lcsc === 'C25804'));
});

await step('ライブラリのJSON書出', async () => {
  await ws('parts');
  const [dl] = await Promise.all([page.waitForEvent('download'), tool('export')]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(j.format, 'pocket-eda-library');
  assert.equal(j.parts.length, 4);
});

await step('タブレット: 部品画面の表示', async () => {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(URL_);
  await tab.waitForSelector('html[data-ready="1"]');
  await tab.locator('#ws-nav button[data-ws="parts"]').click();
  await tab.locator('#pv-q').fill('LM358');
  await tab.waitForTimeout(300);
  await tab.locator('#pv-list .pv-item').first().click();
  await tab.waitForSelector('#dialog[open]');
  assert.match(await tab.locator('#dialog-body').textContent(), /パッド5 はどのピンにも割り当てられていません/);
  await tab.screenshot({ path: `${OUT}/parts-tablet.png` });
  await tab.close();
});

// ---- オンライン検索（jlcsearch）。通信はテスト内で差し替える ----
const LDO = { lcsc: 6186, mfr: 'AMS1117-3.3', package: 'SOT-223', description: '1A 3.3V Linear Voltage Regulators (LDO) SOT-223', stock: 123456, price: 0.06, is_basic: true, is_preferred: false, category: 'Power Management ICs', subcategory: 'Linear Voltage Regulators (LDO)', datasheet: 'https://example.com/ams1117.pdf' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const seenUrls = [];

await step('オンライン検索: 結果一覧に LCSC品番・Basic・在庫が出る', async () => {
  await page.route('https://jlcsearch.tscircuit.com/**', (route) => { seenUrls.push(route.request().url()); route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ components: [LDO] }) }); });
  await ws('parts');
  await page.locator('#pv-q').fill('AMS1117');
  await page.locator('#pv-online-btn').click();
  await page.waitForSelector('#pv-online-res .pv-item');
  const t = await page.locator('#pv-online-res').textContent();
  assert.match(t, /C6186/);
  assert.match(t, /Basic/);
  assert.match(t, /在庫 123,456/);
  assert.match(seenUrls[0], /\/api\/search\?q=AMS1117&limit=30&full=true$/);
  assert.match(await page.locator('#pv-count').textContent(), /^2件ヒット/, 'ローカル一覧も同じ検索語で絞り込まれる（内蔵とCSV取込のAMS1117）');
  await page.screenshot({ path: `${OUT}/parts-online-phone.png` });
});

await step('オンライン検索: 詳細→「保存して回路図に配置」でライブラリ保存と配置', async () => {
  await page.locator('#pv-online-res .pv-item').first().click();
  await page.waitForSelector('#dialog[open]');
  const body = await page.locator('#dialog-body').textContent();
  assert.match(body, /jlcsearch/);
  assert.match(body, /保存済みの部品なので/, 'CSVで取込済みの C6186');
  await page.screenshot({ path: `${OUT}/parts-online-detail-phone.png` });
  await page.locator('#dialog-actions button[value="place"]').click();
  await page.waitForSelector('#ws-nav button[data-ws="schematic"][aria-current="page"]');
  await tapWorld(20, 10);
  const c = (await sheet()).components.at(-1);
  assert.equal(c.props.lcsc, 'C6186');
  assert.equal(c.props.footprint, 'SOT-223-3_TabPin2');
  const saved = await page.evaluate(() => window.pocketEDA.state.lib.get('lcsc:C6186'));
  assert.equal(saved.stock, 123456, '在庫はオンラインの値に更新');
  assert.equal(saved.source, 'import:jlc.csv', '取込元はそのまま（種別・フットプリントを保持）');
  assert.equal(saved.datasheet, 'https://example.com/ams1117.pdf');
});

await step('オンライン検索: ESP32-S3 がICとして呼び出せる（57ピン・フットプリントは自動生成）', async () => {
  const ESP = { lcsc: 2913192, mfr: 'ESP32-S3', package: 'QFN-56-EP(7x7)', is_basic: false, is_preferred: false, description: '-40℃~+105℃ 2.4GHz 21dBm 340mA 3V~3.6V 88mA SPI、USB、UART', stock: 525, price: 2.8747 };
  await page.unroute('https://jlcsearch.tscircuit.com/**');
  await page.route('https://jlcsearch.tscircuit.com/**', (route) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ components: [ESP] }) }));
  await ws('parts');
  await page.locator('#pv-q').fill('ESP32-S3');
  await page.locator('#pv-online-btn').click();
  await page.waitForSelector('#pv-online-res .pv-item');
  const t = await page.locator('#pv-online-res').textContent();
  assert.match(t, /57ピン/);
  assert.match(t, /FP推定/);
  assert.doesNotMatch(t, /フットプリント未設定/);
  await page.locator('#pv-online-res .pv-item').first().click();
  await page.waitForSelector('#dialog[open]');
  const body = await page.locator('#dialog-body').textContent();
  assert.match(body, /IC（汎用）/);
  assert.match(body, /パッケージ名から自動生成・要確認/);
  assert.equal(await page.locator('#dialog-body .fp-preview .pad').count(), 57, 'フットプリント図に57パッド');
  assert.match(body, /ピン↔パッド対応にエラーなし/);
  await page.locator('#dialog-body .fp-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/fp-generated-phone.png` });
  await page.locator('#dialog-actions button[value="place"]').click();
  await page.waitForSelector('#ws-nav button[data-ws="schematic"][aria-current="page"]');
  await tapWorld(0, 30);
  const c = (await sheet()).components.at(-1);
  assert.equal(c.kind, 'ic');
  assert.equal(c.props.pinCount, 57);
  assert.equal(c.props.lcsc, 'C2913192');
  assert.equal(c.props.footprint, 'PKG:ic:QFN-56-EP(7x7)');
  assert.equal(await page.locator(`#content [data-key="c:${c.id}"] .pinnum`).count(), 57, '57本のピン番号が描かれる');
  await page.screenshot({ path: `${OUT}/ic-esp32-phone.png` });
});

await step('オンライン検索: つながらないときはエラーと代替手段を表示（ローカル検索はそのまま）', async () => {
  await page.unroute('https://jlcsearch.tscircuit.com/**');
  await page.route('https://jlcsearch.tscircuit.com/**', (route) => route.abort('failed'));
  await ws('parts');
  await page.locator('#pv-q').fill('SS34');
  await page.locator('#pv-online-btn').click();
  await page.waitForSelector('#pv-online-res .err');
  const t = await page.locator('#pv-online-res').textContent();
  assert.match(t, /接続できません/);
  assert.match(t, /中継URL/);
  assert.ok(await page.locator('#pv-list .pv-item').count() >= 1, 'ローカル検索結果は出ている');
});

await step('オンライン検索: 設定で中継URLに切り替え（再読込後も維持）', async () => {
  const relayUrls = [];
  await page.route('https://relay.example.workers.dev/**', (route) => { relayUrls.push(route.request().url()); route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ components: [LDO] }) }); });
  await page.locator('#pv-online-cfg').click();
  await page.waitForSelector('#dialog[open]');
  await page.locator('#dialog-body [name="base"]').fill('https://relay.example.workers.dev');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.online.base === 'https://relay.example.workers.dev');
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  assert.equal(await page.evaluate(() => window.pocketEDA.state.online.base), 'https://relay.example.workers.dev');
  await ws('parts');
  await page.locator('#pv-q').fill('C6186');
  await page.locator('#pv-online-btn').click();
  await page.waitForSelector('#pv-online-res .pv-item');
  assert.match(relayUrls[0], /^https:\/\/relay\.example\.workers\.dev\/components\/list\.json\?search=C6186&full=true$/);
  assert.match(await page.locator('#pv-online-res').textContent(), /保存済み/);
});

await step('コンソールエラーなし（通信遮断テストの読み込み失敗ログは除く）', async () => {
  assert.deepEqual(errors.filter((e) => !/net::ERR_FAILED|Failed to load resource/.test(e)), []);
});

await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} passed`);
process.exit(ng.length ? 1 : 0);
