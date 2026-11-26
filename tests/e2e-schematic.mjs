// 第2段階: 回路図エディタの実ブラウザE2Eテスト（スマホのタッチ操作＋タブレットのマウス操作）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-schematic.mjs
import { openApp, URL_, OUT, PIXEL_UA } from './e2e-lib.mjs';
import assert from 'node:assert/strict';



const { browser, ctx, page, errors, step, finish } = await openApp({ timeout: 6000, context: { userAgent: PIXEL_UA }, open: false });
const cdp = await ctx.newCDPSession(page);

await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');
if (process.env.DEBUG) {
  page.on('console', (m) => console.log('   [page]', m.text()));
  await page.evaluate(() => {
    const d = document.querySelector('#dialog');
    d.addEventListener('close', () => console.log('dialog close', document.querySelector('#dialog-title').textContent, JSON.stringify(d.returnValue)));
    const orig = window.pocketEDA.editSchematic;
    window.pocketEDA.state.history.__rec = window.pocketEDA.state.history.record;
    const h = window.pocketEDA.state.history;
    h.record = function (fn, label) { const r = h.__rec.call(h, fn, label); console.log('record', label, r); return r; };
    void orig;
  });
}

// ---- ヘルパー ----
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector('#canvas').getBoundingClientRect();
  const s = window.pocketEDA.state.vp.worldToScreen(x, y);
  return { x: r.left + s.x, y: r.top + s.y };
}, [x, y]);
const tapWorld = async (x, y) => { const p = await toScreen(x, y);
  if (p.x < 0 || p.x > 390 || p.y < 0 || p.y > 844) throw new Error(`画面外をタップしようとした: world(${x},${y})`); await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(60); };
const sheet = () => page.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0]);
const comp = async (ref) => (await sheet()).components.find((c) => c.ref === ref);
const conn = () => page.evaluate(() => window.pocketEDA.state.editor.connectivity());
const netOf = (c, ref, pin) => c.nets.find((n) => n.pins.some((p) => p.ref === ref && p.pin === pin));
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const ctxChip = (act) => page.locator(`#ctxbar [data-ctx="${act}"]`).click();
const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1 })) });
async function touchDrag(from, to, { hold = 0, steps = 8 } = {}) {
  await touch('touchStart', [from]);
  if (hold) await page.waitForTimeout(hold);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}

// ---- テスト ----
await step('部品ボタンで部品一覧が開き、初期対応の全部品が並ぶ', async () => {
  await tool('place');
  await page.waitForSelector('#picker:not([hidden])');
  const labels = await page.locator('#picker-grid .pick span').allTextContents();
  for (const need of ['抵抗', '可変抵抗', 'コンデンサ', '電解コンデンサ', 'インダクタ', 'ダイオード', 'LED', 'ツェナー',
    'NPNトランジスタ', 'Nch MOSFET', 'オペアンプ', 'IC（汎用）', 'コネクタ', 'スイッチ', '電池・電源']) {
    assert.ok(labels.includes(need), need);
  }
});

await step('タップで部品を選び、キャンバスのタップ位置に配置（自動採番 R1）', async () => {
  await page.locator('#picker-grid .pick[data-kind="resistor"]').click();
  await page.waitForSelector('#picker', { state: 'hidden' });
  await tapWorld(-10, -20);
  const r1 = await comp('R1');
  assert.ok(r1, 'R1');
  assert.deepEqual([r1.x, r1.y], [-10, -20]);
  assert.equal(r1.kind, 'resistor');
});

await step('部品一覧からキャンバスへドラッグして配置（LED → D1）', async () => {
  await ctxChip('pick');
  await page.waitForSelector('#picker:not([hidden])');
  const item = await page.locator('#picker-grid .pick[data-kind="led"]').boundingBox();
  const drop = await toScreen(5, -20);
  await touchDrag({ x: item.x + item.width / 2, y: item.y + item.height / 2 }, drop, { steps: 12 });
  const d1 = await comp('D1');
  assert.ok(d1, 'D1 placed');
  assert.ok(Math.abs(d1.x - 5) <= 1 && Math.abs(d1.y - (-20)) <= 1, `at ${d1.x},${d1.y}`);
  assert.ok(await page.locator('#picker').isHidden());
  // 位置をぴったりに揃えておく（以降の座標計算のため）
  await page.evaluate(() => window.pocketEDA.editSchematic(() => {
    const c = window.pocketEDA.state.project.schematic.sheets[0].components.find((x) => x.ref === 'D1');
    c.x = 5; c.y = -20;
  }, 'test'));
});

await step('配線: R1.2 → D1.A をタップ2回で結び、ピンで自動終了', async () => {
  await tool('wire');
  await tapWorld(-6, -20);   // R1 pin2
  await tapWorld(2, -20);    // D1 pin2 (A)
  const sh = await sheet();
  assert.equal(sh.wires.length, 1);
  const st = await page.evaluate(() => window.pocketEDA.state.editor.state.wire.pts.length);
  assert.equal(st, 0, 'ピンに着いたら配線モード終了');
  const c = await conn();
  assert.equal(netOf(c, 'R1', '2'), netOf(c, 'D1', '2'));
});

await step('配線の分岐（T字）: 既存配線の途中から引き出すと接続、ジャンクション表示', async () => {
  await tapWorld(-2, -20);   // 配線の途中から
  await tapWorld(-2, -12);   // 下へ
  await tapWorld(-2, -12);   // 同じ点をもう一度で終了
  const c = await conn();
  assert.ok(c.junctions.some((j) => j.x === -2 && j.y === -20), 'junction');
  assert.equal(await page.locator('#content .junction').count(), 1);
  assert.equal(netOf(c, 'R1', '2').wires.length, 3, '分岐点で横線が2本に分割＋縦線1本');
});

await step('元に戻す／やり直す', async () => {
  const before = (await sheet()).wires.length;
  await page.locator('#btn-undo').click();
  assert.ok((await sheet()).wires.length < before, '直前の配線（分岐）が消える');
  await page.locator('#btn-redo').click();
  assert.equal((await sheet()).wires.length, before);
  assert.equal(await page.locator('#btn-redo').isDisabled(), true);
});

await step('選択→回転: 配線端がピンに追従して接続を保つ', async () => {
  await tool('select');
  await tapWorld(-10, -20);
  assert.equal(await page.locator('#ctxbar .chip-info').first().textContent(), 'R1');
  await ctxChip('rotate');
  const r1 = await comp('R1');
  assert.equal(r1.rot, 90);
  const c = await conn();
  assert.equal(netOf(c, 'R1', '2'), netOf(c, 'D1', '2'), '回転後も接続');
});

await step('ミラー・ミラーで元の形に戻る', async () => {
  const before = JSON.stringify(await comp('R1'));
  await ctxChip('mirror');
  await ctxChip('mirror');
  assert.equal(JSON.stringify(await comp('R1')), before);
});

await step('部品をドラッグで移動（グリッドに吸着）', async () => {
  const r1 = await comp('R1');
  const from = await toScreen(r1.x, r1.y);
  const to = await toScreen(r1.x - 4, r1.y + 6);
  await touchDrag(from, to);
  const r = await comp('R1');
  assert.deepEqual([r.x, r.y], [r1.x - 4, r1.y + 6]);
  const c = await conn();
  assert.equal(netOf(c, 'R1', '2'), netOf(c, 'D1', '2'), '移動後も配線が追従');
});

await step('ドラッグ中に2本目の指 → 移動を取り消してピンチズーム（誤操作防止）', async () => {
  const r1 = await comp('R1');
  const s0 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  const p = await toScreen(r1.x, r1.y);
  await touch('touchStart', [{ x: p.x, y: p.y, id: 1 }]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ x: p.x + i * 8, y: p.y, id: 1 }]);
  await touch('touchStart', [{ x: p.x + 32, y: p.y, id: 1 }, { x: p.x + 32, y: p.y + 60, id: 2 }]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: p.x + 32, y: p.y - i * 10, id: 1 }, { x: p.x + 32, y: p.y + 60 + i * 10, id: 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
  const r = await comp('R1');
  assert.deepEqual([r.x, r.y], [r1.x, r1.y], '部品は動いていない');
  const s1 = await page.evaluate(() => window.pocketEDA.state.vp.scale);
  assert.ok(s1 > s0, 'ズームした');
  await page.evaluate(() => { const v = window.pocketEDA.state.vp; v.scale = 8; });
  await page.locator('#btn-zoom-fit').click();
});

await step('空白の1本指ドラッグはパン（選択は変わらない）', async () => {
  await tapWorld(-15, 15); // 空白タップで選択解除
  const x0 = await page.evaluate(() => window.pocketEDA.state.vp.x);
  const p = await toScreen(-15, 15);
  await touchDrag(p, { x: p.x + 40, y: p.y });
  const x1 = await page.evaluate(() => window.pocketEDA.state.vp.x);
  assert.ok(x1 < x0, 'panned');
  assert.equal(await page.evaluate(() => window.pocketEDA.state.editor.state.sel.size), 0);
  await page.locator('#btn-zoom-fit').click();
});

await step('長押し＋ドラッグで範囲選択（R1・D1・配線）', async () => {
  const a = await toScreen(-22, -32);
  const b = await toScreen(14, -2);
  await touchDrag(a, b, { hold: 600 });
  const sel = await page.evaluate(() => [...window.pocketEDA.state.editor.state.sel]);
  const sh = await sheet();
  const ids = new Set(sel);
  for (const r of ['R1', 'D1']) assert.ok(ids.has(`c:${sh.components.find((c) => c.ref === r).id}`), r);
  assert.ok(sel.some((k) => k.startsWith('w:')), 'wire');
  await ctxChip('clear');
});

await step('複数選択モード: タップで追加・解除', async () => {
  await ctxChip('multi');
  const r1 = await comp('R1'), d1 = await comp('D1');
  await tapWorld(r1.x, r1.y);
  await tapWorld(d1.x, d1.y);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.editor.state.sel.size), 2);
  await tapWorld(d1.x, d1.y);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.editor.state.sel.size), 1);
  assert.equal(await page.locator('#dialog[open]').count(), 0, '連続タップで属性ダイアログが開かない');
  await ctxChip('multi');
  await ctxChip('clear');
});

await step('GND記号を配置し、LEDのカソードへ配線 → GNDネット', async () => {
  await tool('power');
  await page.locator('#dialog-body [data-key="GND"]').click();
  await tapWorld(8, -10);
  const g = (await sheet()).components.find((c) => c.kind === 'gnd');
  assert.ok(g, 'gnd placed');
  assert.match(g.ref, /^#PWR\d+$/);
  await tool('wire');
  await tapWorld(8, -20); // D1 K
  await tapWorld(8, -10); // GND pin
  const c = await conn();
  assert.equal(netOf(c, 'D1', '1').name, 'GND');
});

await step('ネットラベル: 配線上をタップして名前を付ける', async () => {
  await tool('label');
  await tapWorld(2, -20); // D1 のアノード(ピン2)の先端
  await page.locator('#dlg-input').fill('LED_A');
  await page.locator('#dlg-input').press('Enter');
  await page.waitForFunction(() => window.pocketEDA.state.project.schematic.sheets[0].labels.length === 1);
  const c = await conn();
  assert.equal(netOf(c, 'D1', '2').name, 'LED_A');
});

await step('長押しで属性編集（値・LCSC品番）', async () => {
  await tool('select');
  const r1 = await comp('R1');
  const p = await toScreen(r1.x, r1.y);
  await touch('touchStart', [p]);
  await page.waitForTimeout(600);
  await touch('touchEnd', []);
  await page.waitForSelector('#dialog[open]');
  assert.equal(await page.locator('#dialog-title').textContent(), 'R1 の属性');
  await page.locator('#dialog-body [name="value"]').fill('330');
  await page.locator('#dialog-body [name="lcsc"]').fill('c23138');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.project.schematic.sheets[0].components.find((c) => c.ref === 'R1').props.value === '330');
  const r = await comp('R1');
  assert.equal(r.props.value, '330');
  assert.equal(r.props.lcsc, 'C23138', '大文字化');
  assert.match(await page.locator('#content').innerHTML(), />330</);
});

await step('部品番号の重複は拒否', async () => {
  const r1 = await comp('R1');
  await page.evaluate((id) => { window.pocketEDA.state.editor.state.sel = new Set([`c:${id}`]); }, r1.id);
  await page.evaluate(() => { window.pocketEDA.state.editor.editProps(); }); // ダイアログの完了は待たない
  await page.waitForSelector('#dialog[open]');
  await page.locator('#dialog-body [name="ref"]').fill('D1');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForSelector('#toast.error:not([hidden])');
  assert.equal((await comp('R1')).ref, 'R1');
});

await step('電池を置いて回路を閉じる → 未接続ピンなし', async () => {
  await page.evaluate(() => window.pocketEDA.editSchematic(() => {}, 'noop'));
  await tool('place');
  await page.locator('#picker-grid .pick[data-kind="battery"]').click();
  await tapWorld(-20, -12);           // + (-20,-16), - (-20,-8)
  await tool('wire');
  const pins = (await conn()).unconnectedPins;
  const r1p1 = pins.find((p) => p.ref === 'R1' && p.pin === '1');
  assert.ok(r1p1, 'R1.1 未接続のはず');
  await tapWorld(-20, -16);
  await tapWorld(r1p1.x, r1p1.y);
  await tool('power'); // 前回選んだ GND のまま
  await tapWorld(-20, -4);
  await tool('wire');
  await tapWorld(-20, -8);
  await tapWorld(-20, -4);
  const c = await conn();
  assert.deepEqual(c.unconnectedPins.map((p) => `${p.ref}.${p.pin}`), []);
  assert.equal(netOf(c, 'BT1', '2').name, 'GND');
  assert.equal(netOf(c, 'BT1', '1'), netOf(c, 'R1', '1'));
});

await step('削除', async () => {
  await tool('select');
  const n0 = (await sheet()).components.length;
  const d1 = await comp('D1');
  await tapWorld(d1.x, d1.y + 1); // ラベル LED_A と重ならない位置
  assert.equal(await page.locator('#ctxbar .chip-info').first().textContent(), 'D1');
  await tool('delete');
  assert.equal((await sheet()).components.length, n0 - 1);
  await page.locator('#btn-undo').click();
  assert.equal((await sheet()).components.length, n0);
});

await step('スクリーンショット（スマホ縦）', async () => {
  await ctxChip('clear').catch(() => {});
  await page.locator('#btn-zoom-fit').click();
  await page.evaluate(() => { const v = window.pocketEDA.state.vp; v.zoomAt(195, 300, 1.3); window.pocketEDA.state.editor.render(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/schematic-phone.png` });
});

await step('保存→再読込で回路図と接続が復元', async () => {
  const before = await conn();
  await page.evaluate(() => window.pocketEDA.saveNow());
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  const after = await conn();
  assert.deepEqual(after.nets.map((n) => [n.name, n.pins.map((p) => p.ref + '.' + p.pin)]),
    before.nets.map((n) => [n.name, n.pins.map((p) => p.ref + '.' + p.pin)]));
  assert.ok(await page.locator('#content .comp').count() >= 5);
});

await step('ネットリストダイアログ（GND・LED_A のネットを含む）', async () => {
  await page.locator('#btn-menu').click();
  await page.locator('[data-act="netlist"]').click();
  await page.waitForSelector('#dialog[open]');
  const t = await page.locator('#dialog-body').textContent();
  assert.match(t, /GND/);
  assert.match(t, /LED_A/);
  await page.locator('#dialog-actions button[value=""]').click();
});

await step('タブレット: マウスで空白ドラッグ＝範囲選択、Rキーで回転、Ctrl+Zで戻す', async () => {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(URL_);
  await tab.waitForSelector('html[data-ready="1"]');
  // 別コンテキスト（保存領域が別）なので、ここで小さな回路を作る
  await tab.evaluate(async () => {
    const m = await import('./js/schematic/model.js');
    window.pocketEDA.editSchematic(() => {
      const sh = window.pocketEDA.state.project.schematic.sheets[0];
      m.addComponent(sh, 'resistor', -10, -20);
      m.addComponent(sh, 'led', 5, -20);
      m.addComponent(sh, 'capacitor', -10, 0);
      m.addComponent(sh, 'opamp', 15, 0);
      m.addComponent(sh, 'gnd', 8, -10);
      m.addWirePath(sh, [{ x: -6, y: -20 }, { x: 2, y: -20 }]);
      m.addWirePath(sh, [{ x: 8, y: -20 }, { x: 8, y: -10 }]);
    }, 'setup');
    window.pocketEDA.state.editor.render();
  });
  const scr = (x, y) => tab.evaluate(([x, y]) => {
    const r = document.querySelector('#canvas').getBoundingClientRect();
    const s = window.pocketEDA.state.vp.worldToScreen(x, y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
  const a = await scr(-40, -32), b = await scr(30, 10);
  await tab.mouse.move(a.x, a.y); await tab.mouse.down(); await tab.mouse.move(b.x, b.y, { steps: 6 }); await tab.mouse.up();
  const n = await tab.evaluate(() => window.pocketEDA.state.editor.state.sel.size);
  assert.ok(n >= 6, `selected ${n}`);
  const d1 = await tab.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0].components.find((c) => c.ref === 'D1'));
  const p = await scr(d1.x, d1.y);
  await tab.mouse.click(p.x, p.y);
  assert.match(await tab.locator('#sel-info').textContent(), /選択中: D1/, 'サイドパネルに選択中の部品');
  await tab.keyboard.press('r');
  assert.equal(await tab.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0].components.find((c) => c.ref === 'D1').rot), 90);
  await tab.keyboard.press('Control+z');
  assert.equal(await tab.evaluate(() => window.pocketEDA.state.project.schematic.sheets[0].components.find((c) => c.ref === 'D1').rot), 0);
  await tab.screenshot({ path: `${OUT}/schematic-tablet.png` });
  await tab.close();
});

await step('コンソールエラーなし', async () => { assert.deepEqual(errors, []); });

await finish();
