// Android の WebView（Chrome DevTools Protocol）に接続して、アプリを実際の環境で試験する
// - テストA〜E の通し（回路図→…→Gerber/BOM/CPL）と各工程の時間
// - 画面のタッチ操作（タブ切替・ドロワー）と、Android の戻るボタン（adb の KEYCODE_BACK）
// - 製造データの書き出し（Capacitor Filesystem に ZIP が書かれる）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = 'tests/device/out';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const report = { steps: results };
const log = (...a) => console.log(...a);
async function step(name, fn) {
  try { const r = await fn(); results.push({ ok: true, name, ...(r ? { result: r } : {}) }); log('OK  ', name, r ? JSON.stringify(r).slice(0, 300) : ''); }
  catch (e) { results.push({ ok: false, name, error: String(e?.stack || e) }); log('NG  ', name, String(e?.message || e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' });

// ---- CDP 接続 ----
let targets = [];
for (let i = 0; i < 30 && !targets.some((t) => t.type === 'page'); i++) {
  try { targets = await (await fetch('http://localhost:9222/json')).json(); } catch { /* 起動待ち */ }
  await sleep(1000);
}
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('ページが見つかりません', targets); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expr, timeout = 120000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeout).then(() => ({ timeout: true })),
  ]);
  if (r.timeout) throw new Error('タイムアウト: ' + expr.slice(0, 80));
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
}
async function tapSelector(sel) {
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error(`要素がありません: ${sel}`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}
const back = async () => { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(800); };
// エミュレータが重いとキー入力が届くのが遅れる・取りこぼすことがある。
// 期待した変化を最大4秒待ち、変化が無いときだけもう1回押す（変化した後に重ねて押すことはない）
const backUntil = async (cond) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    for (let i = 0; i < 20; i++) { await sleep(200); if (await evaluate(cond)) return attempt; }
  }
  return -1;
};
await send('Runtime.enable');
await send('Page.enable');

// 古い WebView（98 未満）では本体を読み込まず案内を出す。その表示を確かめて終わる
for (let i = 0; i < 60; i++) { if (await evaluate("document.documentElement.dataset.ready === '1' || !!document.documentElement.dataset.unsupported")) break; await sleep(500); }
const unsupported = await evaluate('document.documentElement.dataset.unsupported || null');
if (unsupported) {
  await step(`古い WebView（Chrome ${unsupported}）では更新を案内する`, async () => {
    const t = await evaluate("document.querySelector('#unsupported')?.textContent || ''");
    if (!/WebView/.test(t) || !/更新/.test(t)) throw new Error('案内が出ない: ' + t);
    await shot('01-unsupported-webview');
    report.device = { unsupportedWebView: unsupported, ua: await evaluate('navigator.userAgent') };
    return { chrome: unsupported };
  });
  await step('JavaScript のエラーなし', async () => { if (consoleErrors.length) throw new Error(consoleErrors.join('\n')); });
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  const ng = results.filter((r) => !r.ok);
  log(`\n${results.length - ng.length}/${results.length} passed（古い WebView のため案内の確認のみ）`);
  ws.close();
  process.exit(ng.length ? 1 : 0);
}

await step('起動: アプリ版として読み込まれ、保存先が使える', async () => {
  const info = await evaluate(`({ ready: document.documentElement.dataset.ready, version: window.pocketEDA.version, native: window.pocketEDA.native, ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, plugins: Object.keys(Capacitor.Plugins || {}).filter((k) => ['App', 'Filesystem', 'Share'].includes(k)).sort() })`);
  if (info.ready !== '1' || !info.native) throw new Error(JSON.stringify(info));
  if (info.plugins.join() !== 'App,Filesystem,Share') throw new Error('プラグイン不足: ' + info.plugins);
  report.device = info;
  // Android 15 以降の「端から端まで表示」で、アプリの上端・下端がステータスバーやナビゲーションバーに隠れないこと
  const size = /(\d+)x(\d+)/.exec(adb('shell', 'wm', 'size').split('\n').filter(Boolean).pop());
  const screenH = Math.max(+size[1], +size[2]);
  info.screenH = screenH;
  info.webViewH = Math.round(info.h * info.dpr);
  if (info.webViewH > screenH - 40) throw new Error(`WebView が画面いっぱい（${info.webViewH}/${screenH}px）で、システムバーの下に隠れます`);
  await shot('01-start');
  return info;
});

const scen = fs.readFileSync('tests/scenarios.js', 'utf8');
await step('テストA〜E の通し（WebView 内で実行・各工程の時間）', async () => {
  const out = await evaluate(`(async () => {
    const u = URL.createObjectURL(new Blob([${JSON.stringify(scen)}], { type: 'text/javascript' }));
    const S = await import(u);
    const M = await S.loadModules(location.origin + '/');
    const res = [];
    for (const k of Object.keys(S.SPECS)) res.push(await S.runPipeline(M, k));
    return res;
  })()`, 300000);
  report.scenarios = out;
  const bad = out.filter((r) => r.netlistErrors.length || r.netMismatch.length || r.erc.errors || r.arranged.notFit.length || Object.keys(r.drc.byRule).some((k) => !['error:unrouted', 'warning:footprint_unverified'].includes(k)));
  if (bad.length) throw new Error(JSON.stringify(bad));
  return out.map((r) => ({ key: r.key, ms: r.ms }));
});

await step('テストD を開いて PCB を表示（描画時間）', async () => {
  const r = await evaluate(`(async () => {
    const u = URL.createObjectURL(new Blob([${JSON.stringify(scen)}], { type: 'text/javascript' }));
    const S = await import(u);
    const M = await S.loadModules(location.origin + '/');
    const prj = S.buildProject(M, S.SPECS.D);
    prj.netlist = M.netlist.generateNetlist(prj);
    const pcb = M.pcb.ensurePcb(prj);
    M.pcb.importNetlist(pcb, prj.netlist, (c) => { const p = prj.library.parts.find((q) => q.id === c.partId); return (p && M.parts.partFootprint(p)) || M.fps.getFootprint(c.footprint); });
    M.pcb.setOutlineRect(pcb, 50, 40);
    M.pcb.arrangeInBoard(pcb);
    M.pcb.addBoardZone(pcb, 'B.Cu', 'GND');
    await window.pocketEDA.store.saveProject(prj);
    await window.pocketEDA.openProject(prj);
    return prj.id;
  })()`);
  await tapSelector('#ws-nav button[data-ws="pcb"]');
  await tapSelector('#btn-zoom-fit');
  await sleep(1500);
  const t = await evaluate(`(() => { const ed = window.pocketEDA.state.pcbEditor; const n = 10; const s = performance.now(); for (let i = 0; i < n; i++) ed.render(); return Math.round((performance.now() - s) / n * 10) / 10; })()`);
  const ws = await evaluate('window.pocketEDA.state.workspace');
  if (ws !== 'pcb') throw new Error('PCB タブに切り替わらない: ' + ws);
  await shot('02-pcb-testD');
  return { projectId: r, renderMs: t };
});

await step('Android の戻るボタン: ドロワーを閉じる → 回路図へ戻る', async () => {
  await tapSelector('#btn-projects');
  if (await evaluate("document.querySelector('#drawer').hidden")) throw new Error('ドロワーが開かない');
  await shot('03-drawer');
  const r1 = await backUntil("document.querySelector('#drawer').hidden");
  if (r1 < 0) throw new Error('戻るでドロワーが閉じない');
  if ((await evaluate('window.pocketEDA.state.workspace')) !== 'pcb') throw new Error('ドロワーを閉じただけで画面が変わった');
  const r2 = await backUntil("window.pocketEDA.state.workspace === 'schematic'");
  if (r2 < 0) throw new Error('戻るで回路図に戻らない: ' + (await evaluate('window.pocketEDA.state.workspace')));
  return { retried: r1 + r2 };
});

await step('Gerber ZIP を書き出す（Filesystem に保存して共有画面を開く）', async () => {
  await tapSelector('#ws-nav button[data-ws="output"]');
  await sleep(800);
  await shot('04-output');
  // DRC エラー（未配線）の確認ダイアログが出るので「それでも書き出す」
  evaluate('window.pocketEDA.state.outputView.exportZip()').catch(() => {});
  await sleep(1500);
  if (await evaluate("document.querySelector('#dialog').open")) await tapSelector('#dialog button[value="ok"]');
  await sleep(3000);
  adb('exec-out', 'screencap', '-p'); // 共有シートが出ているはず
  fs.writeFileSync(`${OUT}/05-share.png`, execFileSync('adb', ['exec-out', 'screencap', '-p']));
  const files = await evaluate(`Capacitor.Plugins.Filesystem.readdir({ path: '', directory: 'CACHE' }).then((r) => r.files.map((f) => ({ name: f.name, size: f.size })))`);
  const zip = files.find((f) => /-gerber\.zip$/.test(f.name));
  if (!zip || zip.size < 1000) throw new Error('ZIP が書かれていない: ' + JSON.stringify(files));
  await back(); // 共有シートを閉じる
  return zip;
});

await step('戻るボタン: 回路図でさらに戻るとアプリが背面へ（終了ではなく保存して最小化）', async () => {
  await evaluate("window.pocketEDA.state.workspace === 'schematic' || (document.querySelector('#ws-nav button[data-ws=\"schematic\"]').click(), true)");
  await back();
  await sleep(1500);
  const top = adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find((l) => /mResumedActivity|topResumedActivity/.test(l)) || '';
  if (top.includes('jp.tokan.pocketeda')) throw new Error('アプリが前面のまま: ' + top.trim());
  adb('shell', 'am', 'start', '-n', 'jp.tokan.pocketeda/.MainActivity');
  await sleep(2500);
  const v = await evaluate("document.documentElement.dataset.ready");
  return { resumedTop: top.trim(), readyAfterResume: v };
});

await step('JavaScript のエラーなし', async () => { if (consoleErrors.length) throw new Error(consoleErrors.join('\n')); });

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const ng = results.filter((r) => !r.ok);
log(`\n${results.length - ng.length}/${results.length} passed`);
ws.close();
process.exit(ng.length ? 1 : 0);
