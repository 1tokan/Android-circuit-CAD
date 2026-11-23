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
const topActivity = () => adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find((l) => /topResumedActivity|mResumedActivity/.test(l)) || '';
const wakefulness = () => (adb('shell', 'dumpsys', 'power').split('\n').find((l) => /mWakefulness=/.test(l)) || '').trim();
const appOnTop = () => topActivity().includes('jp.tokan.pocketeda');
const back = async () => { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(800); };
// エミュレータが重いとキー入力が届くのが遅れる・取りこぼすことがある。
// 期待した変化を最大4秒待ち、変化が無いときだけもう1回押す（変化した後に重ねて押すことはない）
// 保存が終わり、描画などの重い処理が落ち着くまで待つ（エミュレータでは大きな基板の後に数秒かかり、その間のキー入力は遅れて届く）
const waitIdle = async (ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const idle = await evaluate(`new Promise((r) => { const s = window.pocketEDA.state.saver; if (s && (s.dirty || s.saving)) return r(false); (window.requestIdleCallback || setTimeout)(() => r(true), { timeout: 2000 }); })`);
    if (idle) return Date.now() - t0;
    await sleep(300);
  }
  return -1;
};
// 遅いエミュレータでは、起動直後にランチャー（ホーム画面）が「応答なし（ANR）」になり、そのダイアログが前面で
// 戻るボタンを受け取ってしまう（アプリにも共有シートにも届かない）。試験の前に見つけたら閉じる
const anrClosed = [];
const currentFocus = () => (adb('shell', 'dumpsys', 'window', 'windows').split('\n').find((l) => /mCurrentFocus=/.test(l)) || '').trim();
// アプリが前面の Activity なのに、入力のフォーカスが別の窓（再起動したホーム画面など）にあるとき、アプリを前へ出し直す
const refocused = [];
const ensureAppFocus = () => {
  const f = currentFocus();
  if (f.includes('jp.tokan.pocketeda') || !appOnTop()) return;
  refocused.push(f.replace(/^.*mCurrentFocus=/, ''));
  adb('shell', 'am', 'start', '-n', 'jp.tokan.pocketeda/.MainActivity', '--activity-reorder-to-front');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
};
const clearSystemDialogs = () => {
  for (let k = 0; k < 3; k++) {
    const focus = (adb('shell', 'dumpsys', 'window', 'windows').split('\n').find((l) => /mCurrentFocus=/.test(l)) || '').trim();
    const m = /Application Not Responding: ([\w.]+)/.exec(focus);
    if (!m) return;
    anrClosed.push(m[1]);
    adb('shell', 'am', 'force-stop', m[1]);
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  }
};
const backUntil = async (cond) => {
  clearSystemDialogs();
  ensureAppFocus();
  await waitIdle();
  for (let attempt = 0; attempt < 2; attempt++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    for (let i = 0; i < 40; i++) { await sleep(250); if (await evaluate(cond)) return attempt; }
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

let testDId = null;
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
  testDId = r;
  await tapSelector('#ws-nav button[data-ws="pcb"]');
  await tapSelector('#btn-zoom-fit');
  await sleep(1500);
  const t = await evaluate(`(() => { const ed = window.pocketEDA.state.pcbEditor; const n = 10; const s = performance.now(); for (let i = 0; i < n; i++) ed.render(); return Math.round((performance.now() - s) / n * 10) / 10; })()`);
  const ws = await evaluate('window.pocketEDA.state.workspace');
  if (ws !== 'pcb') throw new Error('PCB タブに切り替わらない: ' + ws);
  await shot('02-pcb-testD');
  return { projectId: r, renderMs: t };
});

await step('同梱サンプル「USB DAC アンプ」を画面から開き、ERC/DRC と 3D 表示（時間）', async () => {
  await tapSelector('#btn-projects');
  await sleep(500);
  await tapSelector('#btn-sample');
  await sleep(500);
  await tapSelector('#dialog-actions button[value="usb-dac-amp"]');
  for (let i = 0; i < 40; i++) { if (await evaluate("/USB DAC アンプ/.test(window.pocketEDA.state.project?.name || '')")) break; await sleep(250); }
  const r = await evaluate(`(async () => {
    const p = window.pocketEDA.state.project;
    if (!/USB DAC アンプ/.test(p.name)) throw new Error('サンプルが開かない: ' + p.name);
    const { runErc } = await import('./js/check/erc.js');
    const { runDrc } = await import('./js/check/drc.js');
    const { fillAllZones } = await import('./js/pcb/zonefill.js');
    const { drcRules } = await import('./js/check/rules.js');
    let t = performance.now();
    const e = runErc(p);
    const ercMs = performance.now() - t; t = performance.now();
    fillAllZones(p.pcb, drcRules(p));
    const d = runDrc(p, p.pcb);
    const drcMs = performance.now() - t;
    return { tracks: p.pcb.tracks.length, ercErrors: e.summary.errors, drcErrors: d.summary.errors, unrouted: d.summary.unrouted, ercMs: Math.round(ercMs), drcMs: Math.round(drcMs) };
  })()`);
  if (r.ercErrors || r.drcErrors || r.unrouted) throw new Error('サンプルの検査結果: ' + JSON.stringify(r));
  await tapSelector('#ws-nav button[data-ws="pcb"]');
  await tapSelector('#btn-zoom-fit');
  await sleep(1500);
  await shot('02b-sample-pcb');
  await tapSelector('#ws-nav button[data-ws="output"]');
  await sleep(1000);
  const t0 = Date.now();
  await tapSelector('[data-3d]');
  let ok = false;
  for (let i = 0; i < 60; i++) { if (await evaluate("!!document.querySelector('#viewer3d')?._viewer")) { ok = true; break; } await sleep(250); }
  const open3dMs = Date.now() - t0;
  const gl = await evaluate("(() => { const v = document.querySelector('#viewer3d')._viewer; return v ? { parts: v.stats.parts } : null; })()");
  if (!ok || !gl || gl.parts < 60) throw new Error('3D 表示が開かない: ' + JSON.stringify(gl));
  await sleep(800);
  await shot('02c-sample-3d');
  await evaluate('window.pocketEDA.back()');
  await sleep(500);
  // 書き出した .kicad_pcb を、本物の KiCanvas（kicanvas.org から読み込む KiCad ビューア）で読み直す
  await evaluate("window.pocketEDA.state.outputView.setTab('kicad'); window.__kc = window.pocketEDA.state.outputView.openKicanvas(); true");
  let kc = null;
  for (let i = 0; i < 150; i++) { kc = await evaluate('JSON.parse(JSON.stringify(window.__kc))'); if (kc && kc.stage !== 'loading') break; await sleep(400); }
  await sleep(1500);
  await shot('02d-sample-kicanvas');
  const kcStatus = await evaluate("document.querySelector('.kicanvas-overlay .kicanvas-status')?.textContent || ''");
  await evaluate("document.querySelector('.kicanvas-overlay [data-close]')?.click(); true");
  if (kc.stage === 'neterror') console.log('  KiCanvas: エミュレータからネットに出られないため確認できず');
  else if (kc.stage !== 'loaded' || !kc.compare?.ok) throw new Error('KiCanvas で読み直せない: ' + kcStatus + ' ' + JSON.stringify({ stage: kc.stage, errors: kc.errors, rows: kc.compare?.rows }));
  // 以降の操作の試験は、これまでと同じテストD の基板で行う（サンプルはベタの塗り直しが重く、エミュレータでは数秒かかるため）
  if (testDId) await evaluate(`window.pocketEDA.store.loadProject(${JSON.stringify(testDId)}).then((p) => window.pocketEDA.openProject(p))`);
  await tapSelector('#ws-nav button[data-ws="pcb"]');
  await sleep(1500);
  return { ...r, open3dMs, parts3d: gl.parts, kicanvas: kc.stage === 'loaded' ? `${kc.footprints} fp / ${kc.segments} seg / ${kc.vias} via / ${kc.zones} zone` : kc.stage };
});

await step('Android の戻るボタン: ドロワーを閉じる → 回路図へ戻る', async () => {
  const idleMs = await waitIdle();
  await tapSelector('#btn-projects');
  for (let i = 0; i < 20 && (await evaluate("document.querySelector('#drawer').hidden")); i++) await sleep(250);
  if (await evaluate("document.querySelector('#drawer').hidden")) throw new Error('ドロワーが開かない');
  await shot('03-drawer');
  const r1 = await backUntil("document.querySelector('#drawer').hidden");
  if (r1 < 0) throw new Error('戻るでドロワーが閉じない（' + wakefulness() + '・' + currentFocus() + '）');
  if ((await evaluate('window.pocketEDA.state.workspace')) !== 'pcb') throw new Error('ドロワーを閉じただけで画面が変わった');
  const r2 = await backUntil("window.pocketEDA.state.workspace === 'schematic'");
  if (r2 < 0) throw new Error('戻るで回路図に戻らない: ' + (await evaluate('window.pocketEDA.state.workspace')));
  return { retried: r1 + r2, idleMs, anrClosed, refocused };
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
  // 共有シートを閉じて、アプリが前面に戻るのを確かめる
  clearSystemDialogs();
  for (let i = 0; i < 3 && !appOnTop(); i++) { await back(); await sleep(700); }
  if (!appOnTop()) throw new Error('共有シートが閉じない: ' + topActivity().trim() + '（' + wakefulness() + '）');
  return zip;
});

await step('戻るボタン: 回路図でさらに戻るとアプリが背面へ（終了ではなく保存して最小化）', async () => {
  await evaluate("window.pocketEDA.state.workspace === 'schematic' || (document.querySelector('#ws-nav button[data-ws=\"schematic\"]').click(), true)");
  clearSystemDialogs();
  if (!appOnTop()) throw new Error('試験の前にアプリが前面にない: ' + topActivity().trim());
  await waitIdle();
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  // 保存してから最小化するので、エミュレータでは数秒かかることがある
  let top = '';
  for (let i = 0; i < 20; i++) { await sleep(500); top = topActivity(); if (!top.includes('jp.tokan.pocketeda')) break; }
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
