// 第4段階: PCBエディタの実ブラウザE2Eテスト（スマホのタッチ操作＋タブレットのマウス操作）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-pcb.mjs
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await ctx.newCDPSession(page);
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');

// ---- ヘルパー ----
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector('#canvas').getBoundingClientRect();
  const s = window.pocketEDA.state.pcbVp.worldToScreen(x, y);
  return { x: r.left + s.x, y: r.top + s.y };
}, [x, y]);
const tapMm = async (x, y) => {
  const p = await toScreen(x, y);
  if (p.x < 0 || p.x > 390 || p.y < 100 || p.y > 780) throw new Error(`画面外: (${x},${y}) → ${JSON.stringify(p)}`);
  await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(60);
};
const pcb = () => page.evaluate(() => window.pocketEDA.state.project.pcb);
const conn = () => page.evaluate(() => window.pocketEDA.state.pcbEditor.connectivity());
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();
const chip = (a) => page.locator(`#ctxbar [data-pctx="${a}"]`).click();
const padPos = (ref, num) => page.evaluate(async ([ref, num]) => {
  const m = await import('./js/pcb/model.js');
  const p = m.allPads(window.pocketEDA.state.project.pcb).find((q) => q.ref === ref && q.pad.num === num);
  return { x: p.x, y: p.y, net: p.net };
}, [ref, num]);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
async function touchDrag(from, to, steps = 10) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= steps; i++) await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}
const setPos = (ref, x, y) => page.evaluate(([ref, x, y]) => window.pocketEDA.editPcb(() => {
  const f = window.pocketEDA.state.project.pcb.footprints.find((q) => q.ref === ref);
  f.x = Math.round(x * 1e6); f.y = Math.round(y * 1e6);
}, 'test'), [ref, x, y]);

// テストA: JST(電池) - 330Ω - LED - GND を回路図に作る
await page.evaluate(async () => {
  const m = await import('./js/schematic/model.js');
  const { BUILTIN_PARTS } = await import('./js/library/parts.js');
  const app = window.pocketEDA;
  const P = (pred) => BUILTIN_PARTS.find(pred);
  const parts = { r: P((p) => p.name.startsWith('抵抗 330Ω')), led: P((p) => p.name === 'LED 赤 0805'), j: P((p) => p.name.startsWith('JST PH 2ピン')) };
  app.mutateProject((p) => { p.library.parts.push(...Object.values(parts)); });
  app.editSchematic(() => {
    const sh = app.state.project.schematic.sheets[0];
    const place = (part, x, y) => m.addComponent(sh, part.kind, x, y, { partId: part.id, value: part.value, footprint: part.footprint, pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames });
    place(parts.j, -10, 0); place(parts.r, 4, -10); place(parts.led, 14, -10);
    const g = m.addComponent(sh, 'gnd', -20, 10); g.props.net = 'GND';
    m.addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
    m.addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
    m.addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
    m.addLabel(sh, 20, 6, 'GND');
    m.addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  }, 'setup');
});

await step('PCBタブ: 「未実装」表示なし、8ツールが有効、基板サイズ表示', async () => {
  await ws('pcb');
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  assert.equal(await page.locator('#toolbar .tool:not([disabled])').count(), 8);
  assert.match(await page.locator('#ctxbar').textContent(), /50\.0 × 40\.0 mm/);
});

await step('ネットリスト読込: 3部品・パッドにネット・ラッツネスト3本（ネットリストは自動生成）', async () => {
  await chip('import');
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.footprints.length === 3);
  const b = await pcb();
  assert.deepEqual(b.footprints.map((f) => f.ref).sort(), ['D1', 'J1', 'R1']);
  assert.equal(b.footprints.find((f) => f.ref === 'D1').padNets['1'], 'GND');
  assert.equal((await conn()).unrouted, 3);
  assert.equal(await page.locator('#pcb-content .ratsnest line').count(), 3);
  assert.equal(await page.evaluate(() => window.pocketEDA.state.project.netlist?.format), 'pocket-eda-netlist');
  await page.screenshot({ path: `${OUT}/pcb-imported-phone.png` });
});

await step('部品をタッチでドラッグして基板内へ（0.25mmグリッドに吸着）', async () => {
  const f = (await pcb()).footprints.find((q) => q.ref === 'R1');
  const from = await toScreen(f.x / 1e6, f.y / 1e6);
  const to = await toScreen(25, 12);
  await touchDrag(from, to);
  const g = (await pcb()).footprints.find((q) => q.ref === 'R1');
  assert.ok(Math.abs(g.x / 1e6 - 25) < 1 && Math.abs(g.y / 1e6 - 12) < 1, `${g.x / 1e6},${g.y / 1e6}`);
  assert.equal(g.x % 250000, 0, 'グリッド吸着');
  await setPos('R1', 25, 12); await setPos('D1', 38, 12); await setPos('J1', 10, 25);
  await page.evaluate(() => window.pocketEDA.state.pcbEditor.render());
});

await step('配線: R1.2 → D1.2 をタップで結び、同ネットのパッドで自動終了・ラッツネスト減', async () => {
  await tool('route');
  const a = await padPos('R1', '2'), b = await padPos('D1', '2');
  await tapMm(a.x, a.y);
  await tapMm(b.x, b.y);
  const t = (await pcb()).tracks;
  assert.ok(t.length >= 1);
  assert.ok(t.every((x) => x.net === a.net && x.layer === 'F.Cu'));
  assert.equal(await page.evaluate(() => window.pocketEDA.state.pcbEditor.state.route.pts.length), 0, '自動終了');
  assert.equal((await conn()).unrouted, 2);
});

await step('別ネットのパッドへは配線できない', async () => {
  const a = await padPos('R1', '1'), b = await padPos('D1', '1');
  const n0 = (await pcb()).tracks.length;
  await tapMm(a.x, a.y);
  await tapMm(b.x, b.y);
  assert.match(await page.locator('#toast').textContent(), /別のネット/);
  assert.equal((await pcb()).tracks.length, n0);
  await chip('finish');
});

await step('ビアで裏面に移って配線（J1.1 → R1.1）', async () => {
  const j = await padPos('J1', '1'), r = await padPos('R1', '1');
  await chip('layer'); // 裏面から開始
  await tapMm(j.x, j.y);
  await tapMm(j.x, 18);
  await chip('via');
  assert.equal(await page.evaluate(() => window.pocketEDA.state.pcbEditor.state.layer), 'F.Cu');
  await tapMm(r.x, r.y);
  const b = await pcb();
  assert.equal(b.vias.length, 1);
  assert.ok(b.tracks.some((t) => t.layer === 'B.Cu') && b.tracks.some((t) => t.layer === 'F.Cu' && t.net === j.net));
  assert.equal((await conn()).unrouted, 1);
});

await step('45°配線: 経路の各線分は水平・垂直・45°のみ', async () => {
  const b = await pcb();
  for (const t of b.tracks) {
    const dx = Math.abs(t.b.x - t.a.x), dy = Math.abs(t.b.y - t.a.y);
    assert.ok(dx === 0 || dy === 0 || Math.abs(dx - dy) <= 1, `${dx},${dy}`);
  }
});

await step('ベタ（GND・表）で GND がつながり、未配線0', async () => {
  await tool('zone');
  await tapMm(5, 5);
  await page.waitForSelector('#dialog[open]');
  assert.equal(await page.locator('#dialog-body [name="net"]').inputValue(), 'GND');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.zones.length === 1);
  const c = await conn();
  assert.equal(c.unrouted, 0, JSON.stringify(c.ratsnest) + JSON.stringify((await pcb()).zones.map((z) => [z.layer, z.net])) + JSON.stringify((await pcb()).footprints.map((f) => [f.ref, f.x, f.y, f.side])));
  assert.deepEqual(c.shorts, []);
  await tool('select');
  assert.match(await page.locator('#ctxbar').textContent(), /未配線 0/);
  await page.screenshot({ path: `${OUT}/pcb-routed-phone.png` });
});

await step('元に戻す: PCBの履歴だけが戻り、回路図は変わらない', async () => {
  const sch0 = await page.evaluate(() => JSON.stringify(window.pocketEDA.state.project.schematic));
  await page.locator('#btn-undo').click();
  assert.equal((await pcb()).zones.length, 0);
  assert.equal(await page.evaluate(() => JSON.stringify(window.pocketEDA.state.project.schematic)), sch0);
  await page.locator('#btn-redo').click();
  assert.equal((await pcb()).zones.length, 1);
});

await step('基板外形のサイズ変更と取付穴', async () => {
  await tool('outline');
  await page.waitForSelector('#dialog[open]');
  await page.locator('#dialog-body [name="w"]').fill('60');
  await page.locator('#dialog-body [name="h"]').fill('45');
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.outline.w === 60e6);
  assert.match(await page.locator('#ctxbar').textContent(), /60\.0 × 45\.0 mm/);
  await chip('hole');
  await tapMm(4, 4);
  await page.locator('#dlg-input').fill('3.2');
  await page.locator('#dlg-input').press('Enter');
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.holes.length === 1);
  assert.equal((await pcb()).holes[0].drill, 3.2e6);
});

await step('シルク文字の配置', async () => {
  await tool('text');
  await tapMm(30, 35);
  await page.locator('#dlg-input').fill('Pocket EDA');
  await page.locator('#dlg-input').press('Enter');
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.texts.length === 1);
  assert.equal((await pcb()).texts[0].layer, 'F.SilkS');
});

await step('長押しで属性: 位置・回転・ロック', async () => {
  await tool('select');
  const f = (await pcb()).footprints.find((q) => q.ref === 'D1');
  const p = await toScreen(f.x / 1e6, f.y / 1e6);
  await touch('touchStart', [p]); await page.waitForTimeout(600); await touch('touchEnd', []);
  await page.waitForSelector('#dialog[open]');
  assert.match(await page.locator('#dialog-title').textContent(), /D1/);
  await page.locator('#dialog-body [name="rot"]').fill('45');
  await page.locator('#dialog-body [name="locked"]').check();
  await page.locator('#dialog-actions button[value="ok"]').click();
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.footprints.find((q) => q.ref === 'D1').rot === 45);
  const g = (await pcb()).footprints.find((q) => q.ref === 'D1');
  assert.equal(g.locked, true);
  // ロック中はドラッグしても動かない
  const q = await toScreen(g.x / 1e6, g.y / 1e6);
  await touchDrag(q, { x: q.x + 40, y: q.y });
  assert.equal((await pcb()).footprints.find((z) => z.ref === 'D1').x, g.x);
});

await step('回路図を変えると再読込を促し、再読込で部品の位置は保たれる', async () => {
  await page.evaluate(() => window.pocketEDA.editSchematic(() => {
    const c = window.pocketEDA.state.project.schematic.sheets[0].components.find((x) => x.ref === 'R1');
    c.props.value = '470';
  }, 'test'));
  await page.evaluate(() => window.pocketEDA.state.pcbEditor.render());
  const before = (await pcb()).footprints.find((q) => q.ref === 'R1');
  await chip('import');
  await page.waitForFunction(() => window.pocketEDA.state.project.pcb.footprints.find((q) => q.ref === 'R1').value === '470');
  const after = (await pcb()).footprints.find((q) => q.ref === 'R1');
  assert.equal(after.x, before.x); assert.equal(after.y, before.y);
});

await step('保存→再読込でPCBが復元', async () => {
  const b0 = await pcb();
  await page.evaluate(() => window.pocketEDA.saveNow());
  await page.reload();
  await page.waitForSelector('html[data-ready="1"]');
  const b1 = await page.evaluate(() => window.pocketEDA.state.project.pcb);
  assert.equal(b1.tracks.length, b0.tracks.length);
  assert.equal(b1.vias.length, 1); assert.equal(b1.zones.length, 1); assert.equal(b1.holes.length, 1);
  assert.equal(b1.footprints.length, 3);
  await ws('pcb');
  assert.equal(await page.evaluate(() => window.pocketEDA.state.pcbEditor.connectivity().unrouted), 0);
});

await step('タブレット: マウスで範囲選択→Rキーで回転→Ctrl+Zで戻す', async () => {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  tab.on('pageerror', (e) => errors.push(e.message));
  await tab.goto(URL_);
  await tab.waitForSelector('html[data-ready="1"]');
  await tab.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    const fps = await import('./js/library/footprints.js');
    window.pocketEDA.editPcb(() => {
      const b = pm.ensurePcb(window.pocketEDA.state.project);
      const mk = (ref, id, x, y) => b.footprints.push({ id: 'f_' + ref, ref, value: '', fpDef: JSON.parse(JSON.stringify(fps.getFootprint(id))), x: x * 1e6, y: y * 1e6, rot: 0, side: 'top', padNets: { 1: 'A', 2: 'B' } });
      mk('R1', 'R_0805', 15, 15); mk('C1', 'C_0805', 25, 15); mk('U1', 'SOIC-8', 35, 22);
    }, 'setup');
  });
  await tab.locator('#ws-nav button[data-ws="pcb"]').click();
  await tab.locator('#btn-zoom-fit').click();
  const scr = (x, y) => tab.evaluate(([x, y]) => { const r = document.querySelector('#canvas').getBoundingClientRect(); const s = window.pocketEDA.state.pcbVp.worldToScreen(x, y); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
  const a = await scr(8, 9), b = await scr(31, 20);
  await tab.mouse.move(a.x, a.y); await tab.mouse.down(); await tab.mouse.move(b.x, b.y, { steps: 6 }); await tab.mouse.up();
  assert.equal(await tab.evaluate(() => window.pocketEDA.state.pcbEditor.state.sel.size), 2);
  await tab.keyboard.press('r');
  assert.ok(await tab.evaluate(() => window.pocketEDA.state.project.pcb.footprints.filter((f) => f.rot === 90).length === 2));
  await tab.keyboard.press('Control+z');
  assert.ok(await tab.evaluate(() => window.pocketEDA.state.project.pcb.footprints.every((f) => f.rot === 0)));
  assert.match(await tab.locator('#sel-info').textContent(), /基板サイズ/);
  await tab.screenshot({ path: `${OUT}/pcb-tablet.png` });
  await tab.close();
});

await step('コンソールエラーなし', async () => { assert.deepEqual(errors, []); });

await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} passed`);
process.exit(ng.length ? 1 : 0);
