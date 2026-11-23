// 第6段階: ベタ塗り・Gerber 出力の実ブラウザE2Eテスト（スマホ）
// 使い方: python3 -m http.server 8765 を起動した状態で node tests/e2e-output.mjs
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL_);
await page.waitForSelector('html[data-ready="1"]');
const ws = (id) => page.locator(`#ws-nav button[data-ws="${id}"]`).click();
const tool = (id) => page.locator(`#toolbar .tool[data-tool="${id}"]`).click();

// テストA を配置・配線し、裏面に GND ベタ
await page.evaluate(async () => {
  const m = await import('./js/schematic/model.js');
  const pm = await import('./js/pcb/model.js');
  const { BUILTIN_PARTS, partFootprint } = await import('./js/library/parts.js');
  const { generateNetlist } = await import('./js/netlist/netlist.js');
  const app = window.pocketEDA;
  const P = (pred) => BUILTIN_PARTS.find(pred);
  const parts = { r: P((p) => p.name.startsWith('抵抗 330Ω')), led: P((p) => p.name === 'LED 赤 0805'), j: P((p) => p.name.startsWith('JST PH 2ピン')) };
  app.mutateProject((p) => { p.name = 'LED Test'; p.library.parts.push(...Object.values(parts)); });
  app.editSchematic(() => {
    const sh = app.state.project.schematic.sheets[0];
    const place = (part, x, y) => m.addComponent(sh, part.kind, x, y, { partId: part.id, value: part.value, footprint: part.footprint, pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames });
    place(parts.j, -10, 0); place(parts.r, 4, -10); place(parts.led, 14, -10);
    m.addComponent(sh, 'gnd', -20, 10).props.net = 'GND';
    m.addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
    m.addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
    m.addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
    m.addLabel(sh, 20, 6, 'GND');
    m.addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  }, 'setup');
  const nl = generateNetlist(app.state.project);
  app.mutateProject((p) => { p.netlist = nl; });
  app.editPcb(() => {
    const b = pm.ensurePcb(app.state.project);
    pm.importNetlist(b, nl, (c) => partFootprint(app.state.project.library.parts.find((q) => q.id === c.partId)));
    pm.setOutlineRect(b, 30, 20);
    const at = (ref, x, y, rot = 0) => { const f = b.footprints.find((q) => q.ref === ref); f.x = pm.toNm(x); f.y = pm.toNm(y); f.rot = rot; };
    at('J1', 6, 10, 90); at('R1', 15, 6); at('D1', 23, 10);
    const pad = (ref, n) => pm.allPads(b).find((p) => p.ref === ref && p.pad.num === n);
    const w = pm.toNm(0.3);
    const j1 = pad('J1', '1'), r1 = pad('R1', '1'), r2 = pad('R1', '2'), d1 = pad('D1', '1'), d2 = pad('D1', '2');
    pm.addTrackPath(b, [j1, { x: j1.x, y: 6 }, r1], 'F.Cu', w, j1.net);
    pm.addTrackPath(b, [r2, { x: d2.x, y: 6 }, d2], 'F.Cu', w, r2.net);
    pm.addBoardZone(b, 'B.Cu', 'GND');
    pm.addVia(b, d1.x - 1.5, d1.y, 'GND');
    pm.addTrackPath(b, [d1, { x: d1.x - 1.5, y: d1.y }], 'F.Cu', w, 'GND');
    pm.addHole(b, 27, 16.5, 3.2);
    pm.addText(b, 15, 17, 'LED v1', 'F.SilkS', 1.2);
  }, 'layout');
});

await step('PCB: ベタは塗りつぶし形状で描かれ、ベタでつながって未配線0', async () => {
  await ws('pcb');
  await page.locator('#btn-zoom-fit').click();
  assert.equal(await page.locator('#pcb-content .zone-fill').count(), 1);
  const c = await page.evaluate(() => window.pocketEDA.state.pcbEditor.connectivity());
  assert.equal(c.unrouted, 0);
  assert.ok(await page.locator('#pcb-content .silk-stroke').count() >= 4, 'シルク文字はストローク');
  assert.equal(await page.locator('#pcb-content text.refdes').count(), 0);
  await page.screenshot({ path: `${OUT}/pcb-zonefill-phone.png` });
});

await step('出力タブ: 「未実装」表示なし、Gerber・BOM・CPL が有効', async () => {
  await ws('output');
  assert.ok(!(await page.locator('#stage-overlay').isVisible()));
  assert.ok(await page.locator('#output-view').isVisible());
  assert.ok(await page.locator('#toolbar .tool[data-tool="gerber"]').isEnabled());
  assert.ok(await page.locator('#toolbar .tool[data-tool="bom"]').isEnabled());
  assert.ok(await page.locator('#toolbar .tool[data-tool="cpl"]').isEnabled());
  assert.match(await page.locator('#output-view').textContent(), /30\.0 × 20\.0 mm/);
  assert.ok(await page.locator('#output-view .plot-preview path').count() >= 1, 'ベタのプレビュー');
  await page.screenshot({ path: `${OUT}/output-phone.png` });
});

await step('ZIPを書き出す: DRCを実行し、Gerber 8 + ドリル 2 の ZIP をダウンロード', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#output-view [data-export]').click()]);
  assert.equal(dl.suggestedFilename(), 'LED_Test-gerber.zip');
  const path = `${OUT}/LED_Test-gerber.zip`;
  await dl.saveAs(path);
  const buf = fs.readFileSync(path);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const n = buf.readUInt16LE(buf.length - 22 + 10);
  assert.equal(n, 10);
  const d = await page.evaluate(() => window.pocketEDA.state.project.checks.drc);
  assert.equal(d.summary.errors, 0, JSON.stringify(d.issues.filter((i) => i.level === 'error')));
  assert.match(await page.locator('#output-view').textContent(), /LED_Test-F_Cu\.gtl/);
});

await step('DRCエラーがあると確認を出し、「やめる」で書き出さない', async () => {
  await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    window.pocketEDA.editPcb(() => { pm.addTrackPath(window.pocketEDA.state.project.pcb, [{ x: 2, y: 2 }, { x: 5, y: 2 }], 'F.Cu', pm.toNm(0.08), 'X'); }, 'bad');
  });
  await tool('gerber');
  await page.locator('#dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#dialog').textContent(), /配線幅/);
  let downloaded = false;
  page.once('download', () => { downloaded = true; });
  await page.locator('#dialog button[value=""]').click();
  await page.waitForTimeout(300);
  assert.equal(downloaded, false);
});

await step('部品実装: BOM 3行・CPL 3行を表示し、CSV を書き出す', async () => {
  await page.evaluate(async () => {
    const pm = await import('./js/pcb/model.js');
    // 前の手順で足した細い配線を消す
    window.pocketEDA.editPcb(() => {
      const b = window.pocketEDA.state.project.pcb;
      b.tracks = b.tracks.filter((t) => t.net !== 'X');
      // 内蔵部品には（未確認の番号を作らないため）LCSC 品番が無いので、試験用に設定
      const set = { J1: 'C173752', R1: 'C17630', D1: 'C84256' };
      for (const f of b.footprints) f.lcsc = set[f.ref];
    }, 'fix');
  });
  await page.locator('#output-view [data-tab="asm"]').click();
  assert.equal(await page.locator('#output-view .tbl').first().locator('tbody tr').count(), 3);
  assert.equal(await page.locator('#output-view .tbl').nth(1).locator('tbody tr').count(), 3);
  assert.match(await page.locator('#output-view').textContent(), /C173752/);
  assert.match(await page.locator('#output-view .check-card').textContent(), /書き出せます/, await page.locator('#output-view .issues').first().textContent());
  await page.screenshot({ path: `${OUT}/output-asm-phone.png`, fullPage: false });
  const [b] = await Promise.all([page.waitForEvent('download'), page.locator('#output-view [data-bom]').click()]);
  if (await page.locator('#dialog[open]').count()) throw new Error('確認ダイアログが出た: ' + await page.locator('#dialog').textContent());
  assert.equal(b.suggestedFilename(), 'LED_Test-BOM.csv');
  const bom = fs.readFileSync(await b.path(), 'utf8');
  assert.ok(bom.startsWith('\uFEFFComment,Designator,Footprint,LCSC Part #'));
  assert.equal(bom.trim().split('\r\n').length, 4);
  const [c] = await Promise.all([page.waitForEvent('download'), tool('cpl')]);
  assert.equal(c.suggestedFilename(), 'LED_Test-CPL.csv');
  const cpl = fs.readFileSync(await c.path(), 'utf8');
  assert.match(cpl, /^\uFEFFDesignator,Mid X,Mid Y,Layer,Rotation\r\n/);
  assert.match(cpl, /R1,15,-6,Top,0\r\n/);
  fs.writeFileSync(`${OUT}/LED_Test-BOM.csv`, bom); fs.writeFileSync(`${OUT}/LED_Test-CPL.csv`, cpl);
});

await step('部品実装: +90 で手動補正すると CPL の回転が変わり、元に戻せる', async () => {
  await page.locator('#output-view [data-rot="R1"][data-d="90"]').click();
  const f = await page.evaluate(() => window.pocketEDA.state.project.pcb.footprints.find((q) => q.ref === 'R1').cplRotOffset);
  assert.equal(f, 90);
  assert.match(await page.locator('#output-view .tbl').nth(1).locator('tbody tr', { hasText: 'R1' }).textContent(), /90°/);
  await page.evaluate(() => window.pocketEDA.undo());
  assert.equal(await page.evaluate(() => window.pocketEDA.state.project.pcb.footprints.find((q) => q.ref === 'R1').cplRotOffset), undefined);
});

await step('KiCad: タブから .kicad_pcb・.kicad_pro・.kicad_dru の ZIP を書き出す', async () => {
  const [k] = await Promise.all([page.waitForEvent('download'), tool('kicad')]);
  assert.equal(k.suggestedFilename(), 'LED_Test-kicad.zip');
  const path = `${OUT}/LED_Test-kicad.zip`;
  await k.saveAs(path);
  const buf = fs.readFileSync(path);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(buf.length - 22 + 10), 3);
  const s = buf.toString('utf8');
  assert.match(s, /LED_Test\/LED_Test\.kicad_pcb/);
  assert.match(s, /\(kicad_pcb \(version 20221018\) \(generator pocket_eda\)/);
  assert.match(await page.locator('#output-view').textContent(), /KiCad で確かめ方|KiCad での確かめ方/);
  await page.screenshot({ path: `${OUT}/output-kicad-phone.png` });
});

await step('コンソールエラーなし', async () => { assert.deepEqual(errors, []); });
await browser.close();
const ng = results.filter((r) => r[0] === 'NG');
console.log(`\n${results.length - ng.length}/${results.length} passed`);
process.exit(ng.length ? 1 : 0);
