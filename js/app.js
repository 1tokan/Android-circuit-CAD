// Pocket EDA 起動・UIシェル
import {
  createProject, touch, serializeProject, parseProject, asCopy, safeFileName, ProjectFormatError, normalizeProject,
} from './core/project.js';
import * as store from './core/storage.js';
import { AutoSaver } from './core/autosave.js';
import { bus } from './core/events.js';
import { MODULES, WORKSPACES, TOOLS, workspaceStatus } from './modules/registry.js';
import { Viewport, attachGestures } from './ui/viewport.js';
import { createPcbEditor } from './pcb/editor.js';
import { ensurePcb, boardRect, toMm } from './pcb/model.js';
import { History } from './core/history.js';
import { createSchematicEditor } from './schematic/editor.js';
import { createLibrary } from './library/library.js';
import { createPartsView } from './library/view.js';
import { createJlcsearch } from './library/jlcsearch.js';
import { displayValue, partFootprint } from './library/parts.js';
import { getFootprint } from './library/footprints.js';
import { generateNetlist, netlistStatus, formatNetlistText } from './netlist/netlist.js';
import { createCheckView } from './check/view.js';
import { ercStatus } from './check/erc.js';
import { drcStatus } from './check/drc.js';
import { createOutputView } from './output/view.js';
import { createAiView } from './ai/view.js';
import { applySpec, projectFromSpec } from './ai/spec.js';
import { moduleById } from './modules/registry.js';
import { esc } from './core/util.js';

const $ = (s) => document.querySelector(s);
const APP_VERSION = '0.11.0';

const state = {
  project: null,
  workspace: 'schematic',
  vp: new Viewport({ scale: 8 }),
  saver: null,
  history: null,
  editor: null,
  pcbVp: new Viewport({ scale: 12 }),
  pcbHistory: null,
  pcbEditor: null,
  lib: createLibrary(),
  online: createJlcsearch(),
  partsView: null,
  checkView: null,
  outputView: null,
  aiView: null,
  marker: null, // 検査結果の「表示」で示す位置 {ws, x, y}
  assign: null, // 部品データの割り当て先 {key, ref}
};

// ---------------- 保存まわり ----------------
const SAVE_LABEL = { idle: '—', dirty: '未保存', saving: '保存中…', saved: '保存済み', error: '保存失敗' };

function setSaveState(s, err) {
  const el = $('#save-state');
  el.dataset.state = s;
  el.textContent = SAVE_LABEL[s] ?? s;
  if (s === 'error') toast('保存に失敗しました: ' + (err?.message || err), true);
}

async function saveNow() {
  if (!state.project) return;
  await store.saveProject(state.project);
  clearPending(state.project.id, state.project.revision);
  bus.emit('project:saved', { id: state.project.id, revision: state.project.revision });
}

// ---- 緊急退避 ----
// ページを閉じる・再読込する瞬間の IndexedDB 保存は非同期で間に合わないことがある。
// 未保存の変更があれば同期 API の localStorage に退避し、次回起動時に復元する。
const PENDING_KEY = 'pocket-eda:pending';
function writePending() {
  if (!state.project || !state.saver?.dirty) return;
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id: state.project.id, revision: state.project.revision, project: state.project })); }
  catch { /* 容量超過などは諦める（IndexedDB 側の保存は続行） */ }
}
function clearPending(id, revision) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.id === id && p.revision <= revision) localStorage.removeItem(PENDING_KEY);
  } catch { /* 無視 */ }
}
/** 退避分が保存済みより新しければ IndexedDB に書き戻す。復元したプロジェクトIDを返す */
async function recoverPending() {
  let pending;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { pending = null; }
  if (!pending?.project) return null;
  try {
    const saved = await store.loadProject(pending.id);
    if (!saved || pending.revision > saved.revision) {
      const p = normalizeProject(pending.project);
      await store.saveProject(p);
      localStorage.removeItem(PENDING_KEY);
      return p.id;
    }
    localStorage.removeItem(PENDING_KEY);
  } catch (e) { console.warn('退避データを復元できません', e); }
  return null;
}

/** プロジェクトを変更する唯一の入口。全モジュールはこれを使う */
export function mutateProject(fn, reason = 'edit') {
  fn(state.project);
  touch(state.project);
  state.saver.markDirty();
  bus.emit('project:changed', { reason, revision: state.project.revision });
  renderHeader();
  renderUndo();
  if (state.workspace === 'check' && state.checkView && !String(reason).startsWith('check:')) state.checkView.render();
  if (state.workspace === 'output' && state.outputView && !String(reason).startsWith('check:')) state.outputView.render();
}

/** 回路図の編集（元に戻す履歴に積む）。変化が無ければ保存もしない */
function editSchematic(fn, label) {
  let changed = false;
  changed = state.history.record(() => { fn(); }, label);
  if (changed) { mutateProject(() => {}, label); renderSidePanel(); }
  return changed;
}

/** 作業中の画面のエディタと履歴 */
function activeEditor() { return state.workspace === 'pcb' ? state.pcbEditor : state.workspace === 'schematic' ? state.editor : null; }
// 出力タブでの変更（部品の実装向きの補正）は PCB の履歴に積む
function activeHistory() { return ['pcb', 'output'].includes(state.workspace) ? state.pcbHistory : state.workspace === 'schematic' ? state.history : null; }
function activeVp() { return state.workspace === 'pcb' ? state.pcbVp : state.vp; }

/** PCB の編集（PCB用の元に戻す履歴に積む） */
function editPcb(fn, label) {
  let result;
  const changed = state.pcbHistory.record(() => { result = fn(); }, label);
  if (changed) { mutateProject(() => {}, label); renderSidePanel(); }
  return result === undefined ? changed : result;
}

function undoRedo(kind) {
  const h = activeHistory(), ed = activeEditor();
  if (!h) return;
  const l = kind === 'undo' ? h.undo() : h.redo();
  if (l === null) return;
  mutateProject(() => {}, kind);
  if (ed) { ed.state.sel = new Set(); ed.render(); }
  renderSidePanel();
  toast(`${kind === 'undo' ? '元に戻す' : 'やり直す'}: ${l}`);
}
function undo() { undoRedo('undo'); }
function redo() { undoRedo('redo'); }
function renderUndo() {
  const h = activeHistory();
  $('#btn-undo').disabled = !h?.canUndo();
  $('#btn-redo').disabled = !h?.canRedo();
}

async function openProject(project) {
  if (state.project && state.saver.dirty) await state.saver.flush();
  state.project = project;
  ensurePcb(project);
  state.history.clear();
  state.pcbHistory.clear();
  state.editor.resetForProject();
  state.pcbEditor.resetForProject();
  fitPcb();
  state.saver.dirty = false;
  setSaveState('saved');
  await store.setSetting('lastProjectId', project.id);
  state.saver.setEnabled(project.settings.autosave !== false);
  $('#chk-autosave').checked = project.settings.autosave !== false;
  bus.emit('project:opened', { id: project.id });
  renderAll();
}

async function newProject(name) {
  const p = createProject(name);
  await store.saveProject(p);
  await openProject(p);
  toast(`「${p.name}」を作成しました`);
}

// ---------------- 描画 ----------------
function renderAll() { renderHeader(); renderNav(); renderToolbar(); renderOverlay(); renderModuleStatus(); renderSidePanel(); renderUndo(); renderCanvas(); }

function renderHeader() {
  $('#project-name').textContent = state.project?.name ?? '—';
  document.title = state.project ? `${state.project.name} - Pocket EDA` : 'Pocket EDA';
}

function renderNav() {
  const nav = $('#ws-nav');
  nav.replaceChildren(...WORKSPACES.map((ws) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.ws = ws.id;
    if (ws.id === state.workspace) b.setAttribute('aria-current', 'page');
    const st = workspaceStatus(ws);
    const stLabel = st === 'planned' ? '未実装' : st === 'partial' ? '一部実装' : '';
    b.innerHTML = `<span>${ws.label}</span>${stLabel ? `<span class="badge ${st}">${stLabel}</span>` : ''}`;
    b.setAttribute('aria-label', stLabel ? `${ws.label}（${stLabel}）` : ws.label);
    b.onclick = () => { state.workspace = ws.id; state.marker = null; renderAll(); };
    return b;
  }));
}

function renderToolbar() {
  const tb = $('#toolbar');
  const ws = WORKSPACES.find((w) => w.id === state.workspace);
  const enabled = workspaceStatus(ws) !== 'planned';
  tb.replaceChildren(...(TOOLS[state.workspace] || []).map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool';
    const on = enabled && (!t.module || moduleById(t.module).status !== 'planned');
    b.disabled = !on;
    b.title = on ? t.label : `${t.label}（未実装・第${moduleById(t.module || ws.modules[0]).stage}段階）`;
    b.dataset.tool = t.id;
    if (enabled && activeEditor()?.state.tool === t.id) b.classList.add('on');
    b.innerHTML = `<svg class="ico" viewBox="0 0 24 24"><path d="${t.icon || 'M5 5h14v14H5z'}"/></svg>${t.label}`;
    if (on) b.onclick = () => { onTool(t.id); };
    return b;
  }));
}

function onTool(id) {
  if (state.workspace === 'parts') { state.partsView.action(id); return; }
  if (state.workspace === 'output') {
    if (id === 'gerber') state.outputView.exportZip();
    else { state.outputView.setTab('asm'); state.outputView.exportAssembly(id); }
    return;
  }
  if (state.workspace === 'check') {
    if (id === 'rules') state.checkView.editRules();
    else state.checkView.run(id);
    return;
  }
  const ed = activeEditor();
  if (!ed) return;
  ed.setTool(id);
  renderToolbar();
}

/** PCB の表示を基板と部品が全部入るように合わせる */
function fitPcb() {
  const svg = $('#canvas');
  const { width, height } = svg.getBoundingClientRect();
  if (!width || !state.project) return;
  const pcb = ensurePcb(state.project);
  const r = boardRect(pcb);
  let x0 = r.x0, y0 = r.y0, x1 = r.x1, y1 = r.y1;
  for (const f of pcb.footprints) { const x = toMm(f.x), y = toMm(f.y); x0 = Math.min(x0, x - 3); y0 = Math.min(y0, y - 3); x1 = Math.max(x1, x + 3); y1 = Math.max(y1, y + 3); }
  state.pcbVp.fit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, width, Math.max(100, height - 80), 16);
  state.pcbVp.y -= 60 / state.pcbVp.scale; // 上部のチップ分ずらす
}

// ---------------- 部品ライブラリ連携 ----------------
/** 部品データ → 回路図の部品属性 */
function partProps(part) {
  return {
    partId: part.id, value: displayValue(part),
    footprint: partFootprint(part)?.id || (typeof part.footprint === 'object' ? part.footprint.id : part.footprint),
    lcsc: part.lcsc, mpn: part.mpn, manufacturer: part.manufacturer,
    ...(part.symbol?.pinCount ? { pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames || '' } : {}),
  };
}
/** 使った部品データをプロジェクトにコピー（プロジェクト単体で完結させるため） */
function usePartInProject(part) {
  const cur = state.project.library.parts.find((p) => p.id === part.id);
  if (cur && JSON.stringify(cur) === JSON.stringify(part)) return;
  mutateProject((p) => {
    p.library.parts = p.library.parts.filter((x) => x.id !== part.id);
    p.library.parts.push(structuredClone(part));
  }, 'library');
}
function switchWorkspace(id) { state.workspace = id; renderAll(); }

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * 戻る操作（Android の戻るボタン・戻るジェスチャー）。
 * 開いているものを閉じる → 操作中のツールを取り消す → 回路図へ戻る、の順。何もなければ false（アプリを閉じてよい）。
 */
function handleBack() {
  const dlg = $('#dialog');
  if (dlg.open) { dlg.close(''); return true; }
  if (!$('#viewer3d').hidden) { closeOverlay('#viewer3d'); return true; }
  if (!$('#ai-view').hidden) { closeOverlay('#ai-view'); return true; }
  if (!$('#menu').hidden) { $('#menu').hidden = true; return true; }
  if (!$('#drawer').hidden) { closeDrawer(); return true; }
  if (!$('#picker').hidden) { $('#picker').hidden = true; return true; }
  const ed = activeEditor();
  if (ed && (ed.state.tool !== 'select' || ed.state.sel.size)) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    renderToolbar(); renderSidePanel();
    return true;
  }
  if (state.workspace !== 'schematic') { state.marker = null; switchWorkspace('schematic'); return true; }
  return false;
}

/** Android アプリ版（Capacitor）で動いているか */
const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();

/**
 * ファイルの書き出し。ブラウザはダウンロード、Android アプリ版は
 * キャッシュに書いてから共有シート（Googleドライブ・ファイル・メール等へ保存・送信）を開く。
 */
async function download(name, text, type = 'text/plain') {
  const binary = text instanceof Uint8Array;
  if (NATIVE) {
    const { Filesystem, Share } = globalThis.Capacitor.Plugins;
    try {
      const r = binary
        ? await Filesystem.writeFile({ path: name, data: toBase64(text), directory: 'CACHE' }) // encoding 無し = base64 のバイナリ
        : await Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
      await Share.share({ title: name, files: [r.uri], dialogTitle: `${name} を保存・共有` });
    } catch (e) {
      if (!/cancel/i.test(String(e?.message))) toast('書き出せませんでした: ' + (e?.message || e), true);
    }
    return;
  }
  const blob = new Blob([text], { type });
  state.lastDownload = { name, size: blob.size, type }; // テスト・確認用
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- ネットリスト ----------------
async function renderPcbSidePanel(el) {
  const pcb = ensurePcb(state.project);
  const conn = state.pcbEditor.lastConnectivity();
  const row = (k, v) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`;
  let html = `<h2>PCB</h2>` + row('基板サイズ', `${toMm(pcb.outline.w).toFixed(1)} × ${toMm(pcb.outline.h).toFixed(1)} mm`) +
    row('部品', pcb.footprints.length) + row('配線', pcb.tracks.length) + row('ビア', pcb.vias.length) + row('ベタ', pcb.zones.length) +
    row('未配線', conn.unrouted + (conn.fillStale ? '（ベタ塗り直し中）' : '')) + (conn.shorts.length ? `<p class="err">短絡の疑い: ${conn.shorts.map((s) => s.join('/')).map(esc).join('、')}</p>` : '');
  const nls = netlistStatus(state.project);
  const ds = drcStatus(state.project, pcb), dr = state.project.checks?.drc;
  html += `<p class="kv">DRC: ${{ none: '未実行', current: `最新（エラー${dr?.summary.errors ?? 0}・警告${dr?.summary.warnings ?? 0}）`, stale: '<span class="warn">変更後に未実行</span>' }[ds]}</p>`;
  if (pcb.footprints.length && (nls !== 'current' || pcb.netlistHash !== state.project.netlist?.sourceHash)) html += '<p class="warn">回路図が変わっています。ネットリストを再読込してください</p>';
  const sel = state.pcbEditor.selectionInfo();
  if (sel.length === 1 && sel[0].item) {
    const { key, item } = sel[0];
    if (key[0] === 'f') html += `<h2>選択中: ${esc(item.ref)}</h2>` + row('値', item.value) + row('フットプリント', item.fpDef.name) + row('位置', `${toMm(item.x).toFixed(2)}, ${toMm(item.y).toFixed(2)} mm`) + row('回転・面', `${item.rot}°・${item.side === 'bottom' ? '裏' : '表'}`);
    else if (key[0] === 't') html += `<h2>配線</h2>` + row('ネット', item.net || '—') + row('幅', `${toMm(item.width)} mm`) + row('層', item.layer);
    else if (key[0] === 'v') html += `<h2>ビア</h2>` + row('ネット', item.net || '—') + row('外径/穴', `${toMm(item.diameter)} / ${toMm(item.drill)} mm`);
    html += `<button class="btn small-btn" id="btn-side-pprops">属性を編集</button>`;
  } else if (sel.length) html += `<h2>${sel.length}個選択中</h2>`;
  el.innerHTML = html;
  $('#btn-side-pprops')?.addEventListener('click', () => state.pcbEditor.editProps());
}

async function showNetlist() {
  const nl = generateNetlist(state.project);
  mutateProject((p) => { p.netlist = nl; }, 'netlist');
  renderSidePanel();
  const errs = nl.problems.filter((x) => x.level === 'error');
  const warns = nl.problems.filter((x) => x.level === 'warning');
  const list = (arr, cls) => (arr.length ? `<ul class="${cls}">${arr.slice(0, 40).map((x) => `<li>${esc(x.message)}</li>`).join('')}${arr.length > 40 ? `<li>…ほか${arr.length - 40}件</li>` : ''}</ul>` : '');
  const nets = nl.nets.map((n) => `<li><b>${esc(n.name)}</b><br><small>${n.nodes.map((x) => `${esc(x.ref)}-${esc(x.pad)}`).join(', ')}</small></li>`).join('');
  const html = `<p>部品 <b>${nl.summary.components}</b>・ネット <b>${nl.summary.nets}</b>・エラー <b class="${errs.length ? 'err' : ''}">${errs.length}</b>・警告 ${warns.length}</p>` +
    (errs.length ? '<p class="err">エラーを直すまで、PCB には正しく読み込めません。</p>' : '<p class="ok">✓ エラーなし（ノードは「部品番号-パッド番号」）</p>') +
    list(errs, 'errs') + list(warns, 'warns') + `<h4>ネット</h4><ul class="netlist">${nets || '<li>ネットはありません</li>'}</ul>`;
  const r = await ask('ネットリスト', html, [{ label: '閉じる', value: '' }, { label: 'テキスト書出', value: 'txt' }, { label: 'JSON書出', value: 'json', cls: 'primary' }]);
  const base = safeFileName(state.project.name);
  if (r === 'json') download(`${base}.netlist.json`, JSON.stringify(nl, null, 2), 'application/json');
  if (r === 'txt') download(`${base}.netlist.txt`, formatNetlistText(nl));
}

function renderOverlay() {
  const ws = WORKSPACES.find((w) => w.id === state.workspace);
  const mods = ws.modules.map((id) => MODULES.find((m) => m.id === id));
  const planned = mods.filter((m) => m.status === 'planned');
  const ov = $('#stage-overlay');
  $('#ctxbar').hidden = !activeEditor();
  $('#content').style.display = state.workspace === 'schematic' ? '' : 'none';
  $('#pcb-content').style.display = state.workspace === 'pcb' ? '' : 'none';
  const pv = $('#parts-view');
  pv.hidden = state.workspace !== 'parts';
  $('#check-view').hidden = state.workspace !== 'check';
  $('#output-view').hidden = state.workspace !== 'output';
  const noCanvas = ['parts', 'check', 'output'].includes(state.workspace);
  document.querySelector('.zoom-ctl').hidden = noCanvas;
  $('#coords').hidden = noCanvas;
  if (state.workspace === 'parts') state.partsView.render();
  if (state.workspace === 'check') state.checkView.render();
  if (state.workspace === 'output') state.outputView.render();
  // 一部でも実装済みならキャンバスを塞がない（未実装分はサイドパネル・モジュール状況に表示）
  if (workspaceStatus(ws) !== 'planned') { ov.hidden = true; return; }
  ov.hidden = false;
  ov.innerHTML = `<h3>${ws.label}：未実装</h3>` +
    planned.map((m) => `<p>${m.name} は第${m.stage}段階で実装します</p>`).join('') +
    `<p>キャンバスの拡大縮小（ピンチ / ホイール）とパン（ドラッグ）は試せます</p>`;
}

function renderModuleStatus() {
  const label = { ready: '実装済み', partial: '一部', planned: '未実装' };
  $('#module-status').replaceChildren(...MODULES.map((m) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${m.name}${m.note ? `<br><small class="note">${esc(m.note)}</small>` : ''}</span><span class="badge ${m.status}">${label[m.status]}</span>`;
    return li;
  }));
}

function renderSidePanel() {
  const el = $('#sel-info');
  if (state.workspace === 'pcb' && state.pcbEditor && state.project) { renderPcbSidePanel(el); return; }
  if (!state.editor || state.workspace !== 'schematic') { el.innerHTML = ''; return; }
  const d = state.editor.selectionSummary();
  const sh = state.project.schematic.sheets[0];
  const conn = state.editor.connectivity();
  let html = `<h2>回路図</h2><p class="kv">部品 ${sh.components.filter((c) => c.kind !== 'power' && c.kind !== 'gnd').length}・配線 ${sh.wires.length}・ネット ${conn.nets.filter((n) => n.pins.length >= 2 || n.named).length}・未接続ピン ${conn.unconnectedPins.length}</p>`;
  const nls = netlistStatus(state.project);
  html += `<p class="kv">ネットリスト: ${{ none: '未生成', current: `最新（エラー${state.project.netlist?.summary.errors ?? 0}）`, stale: '<span class="warn">回路図が変更されています。再生成してください</span>' }[nls]}</p>`;
  const es = ercStatus(state.project), er = state.project.checks?.erc;
  html += `<p class="kv">ERC: ${{ none: '未実行', current: `最新（エラー${er?.summary.errors ?? 0}・警告${er?.summary.warnings ?? 0}）`, stale: '<span class="warn">変更後に未実行</span>' }[es]}</p>`;
  if (d.comps.length === 1 && state.editor.state.sel.size === 1) {
    const c = d.comps[0];
    const row = (k, v) => `<div class="kv"><span>${k}</span><b>${esc(v || '—')}</b></div>`;
    html += `<h2>選択中: ${esc(c.ref)}</h2>` + row('値', c.props.value ?? c.props.net) + row('フットプリント', c.props.footprint) +
      row('LCSC', c.props.lcsc) + row('部品データ', c.props.partId ? (state.project.library.parts.find((p) => p.id === c.props.partId)?.name || '（見つかりません）') : '未割り当て') + row('向き', `${c.rot}°${c.mirror ? '・反転' : ''}`) +
      `<button class="btn small-btn" id="btn-side-props">属性を編集</button>`;
  } else if (state.editor.state.sel.size) {
    html += `<h2>${state.editor.state.sel.size}個選択中</h2>`;
  }
  el.innerHTML = html;
  $('#btn-side-props')?.addEventListener('click', () => state.editor.editProps());
}

function renderCanvas() {
  const svg = $('#canvas');
  const { width, height } = svg.getBoundingClientRect();
  const vp = activeVp();
  $('#world').setAttribute('transform', `scale(${vp.scale}) translate(${-vp.x} ${-vp.y})`);
  // 見えている範囲だけグリッドを敷く
  const x0 = Math.floor(vp.x / 10) * 10, y0 = Math.floor(vp.y / 10) * 10;
  const w = Math.ceil(width / vp.scale / 10 + 2) * 10, h = Math.ceil(height / vp.scale / 10 + 2) * 10;
  for (const id of ['#grid-minor-rect', '#grid-major-rect']) {
    const r = $(id);
    r.setAttribute('x', x0); r.setAttribute('y', y0); r.setAttribute('width', w); r.setAttribute('height', h);
  }
  // 拡大率が低いと点グリッドが密になりすぎるので隠す
  $('#grid-minor-rect').style.display = vp.scale < 4 ? 'none' : '';
  $('#coords').textContent = state.workspace === 'pcb' ? `${(vp.scale).toFixed(1)} px/mm` : `×${vp.scale.toFixed(1)}`;
  activeEditor()?.render();
  renderMarker();
}

/** Claude で回路を作る */
async function openAi() {
  $('#ai-view').hidden = false;
  await state.aiView.open();
}
function closeOverlay(id) { $(id).hidden = true; $(id).innerHTML = ''; }

/** 回路図の部品が全部入るように表示を合わせる */
function fitSchematic() {
  const sh = state.project.schematic.sheets[0];
  const svg = $('#canvas');
  const { width, height } = svg.getBoundingClientRect();
  if (!sh.components.length || !width) { centerOrigin(); return; }
  const xs = sh.components.map((c) => c.x), ys = sh.components.map((c) => c.y);
  const x0 = Math.min(...xs) - 15, y0 = Math.min(...ys) - 15, x1 = Math.max(...xs) + 15, y1 = Math.max(...ys) + 15;
  state.vp.fit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, width, Math.max(100, height - 80), 16);
  state.vp.y -= 60 / state.vp.scale;
}

/** AI の回路仕様を作図する（replace: 今のプロジェクト、new: 新しいプロジェクト） */
async function applyAiSpec(c, mode) {
  try {
    let report;
    if (mode === 'new') {
      const r = projectFromSpec(c, { library: state.lib.all() });
      r.project.ai = { ...(r.project.ai || {}), history: structuredClone(state.project.ai?.history || []) };
      await store.saveProject(r.project);
      await openProject(r.project);
      report = r.report;
    } else {
      editSchematic(() => { report = applySpec(state.project, c, { library: state.lib.all() }); }, 'Claude の回路を作図');
      mutateProject(() => {}, 'ai');
    }
    closeOverlay('#ai-view');
    switchWorkspace('schematic');
    fitSchematic();
    renderCanvas();
    const erc = state.checkView.run('erc', { quiet: true });
    toast(`${report.placed} 個の部品を作図しました（新しい部品データ ${report.newParts.length}）。ERC: エラー ${erc.summary.errors}・警告 ${erc.summary.warnings}`);
  } catch (e) {
    toast('作図できません: ' + (e.message || e), true);
  }
}

/** 3D 表示（three.js は重いので開くときに読み込む） */
async function open3d() {
  try {
    const { openViewer3d } = await import('./view3d/viewer.js');
    $('#viewer3d').hidden = false;
    await openViewer3d({ root: $('#viewer3d'), project: state.project, pcb: ensurePcb(state.project), onClose: () => closeOverlay('#viewer3d') });
  } catch (e) {
    console.error(e);
    toast('3D 表示を開けませんでした: ' + (e?.message || e), true);
  }
}

/** 検査結果の位置の印（画面上で一定の大きさ） */
function renderMarker() {
  const g = $('#check-marker');
  const m = state.marker;
  if (!m || m.ws !== state.workspace) { g.innerHTML = ''; return; }
  const k = 1 / activeVp().scale;
  const r = 16 * k, t = 26 * k;
  g.innerHTML = `<circle cx="${m.x}" cy="${m.y}" r="${r}" stroke-width="${3 * k}"/><path d="M${m.x - t} ${m.y}h${t - r}M${m.x + r} ${m.y}h${t - r}M${m.x} ${m.y - t}v${t - r}M${m.x} ${m.y + r}v${t - r}" stroke-width="${3 * k}"/>`;
}

/** 検査結果の位置へ移動して印を出す */
function jumpTo(ws, at, message) {
  state.marker = { ws, x: at.x, y: at.y };
  state.workspace = ws;
  renderAll();
  const { width, height } = $('#canvas').getBoundingClientRect();
  const vp = ws === 'pcb' ? state.pcbVp : state.vp;
  vp.scale = Math.max(vp.scale, ws === 'pcb' ? 24 : 12);
  vp.x = at.x - width / 2 / vp.scale;
  vp.y = at.y - (height / 2 - 30) / vp.scale;
  renderCanvas();
  if (message) toast(message);
}

let rafPending = false;
function scheduleCanvas() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderCanvas(); });
}

function centerOrigin() {
  const { width, height } = $('#canvas').getBoundingClientRect();
  state.vp.scale = 8;
  state.vp.x = -width / 2 / 8;
  state.vp.y = -height / 2 / 8;
}

// ---------------- プロジェクト一覧 ----------------
async function openDrawer() {
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  await renderProjectList();
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-backdrop').hidden = true; }

async function renderProjectList() {
  const list = await store.listProjects();
  const ul = $('#project-list');
  if (!list.length) { ul.innerHTML = '<li class="empty">プロジェクトはありません</li>'; return; }
  ul.replaceChildren(...list.map((s) => {
    const li = document.createElement('li');
    if (s.id === state.project?.id) li.className = 'current';
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = `<b></b><small>${fmtTime(s.updatedAt)}・部品${s.componentCount}</small>`;
    open.querySelector('b').textContent = s.name;
    open.onclick = async () => {
      const p = await store.loadProject(s.id);
      if (p) { await openProject(p); closeDrawer(); }
    };
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.setAttribute('aria-label', `${s.name}を削除`);
    del.textContent = '🗑';
    del.onclick = () => confirmDelete(s);
    li.append(open, del);
    return li;
  }));
}

async function confirmDelete(s) {
  const ok = await ask(`「${s.name}」を削除`, '<p>保存履歴も含めて端末から削除します。元に戻せません。</p>',
    [{ label: 'キャンセル', value: '' }, { label: '削除', value: 'del', cls: 'danger' }]);
  if (ok !== 'del') return;
  await store.deleteProject(s.id);
  if (s.id === state.project?.id) {
    const rest = await store.listProjects();
    if (rest.length) await openProject(await store.loadProject(rest[0].id));
    else await newProject('新規プロジェクト');
  }
  await renderProjectList();
  toast('削除しました');
}

// ---------------- 入出力 ----------------
function exportProject() {
  download(`${safeFileName(state.project.name)}.pocketeda.json`, serializeProject(state.project), 'application/json');
  toast('JSONを書き出しました');
}

async function importFile(file) {
  let p;
  try {
    p = parseProject(await file.text());
  } catch (e) {
    toast(e instanceof ProjectFormatError ? e.message : '読み込めませんでした: ' + e.message, true);
    return;
  }
  const existing = await store.loadProject(p.id);
  if (existing) {
    const r = await ask('同じプロジェクトが端末にあります',
      `<p>端末内:「${esc(existing.name)}」(${fmtTime(existing.updatedAt)})<br>読込:「${esc(p.name)}」(${fmtTime(p.updatedAt)})</p>`,
      [{ label: 'キャンセル', value: '' }, { label: 'コピーとして追加', value: 'copy' }, { label: '上書き', value: 'over', cls: 'danger' }]);
    if (!r) return;
    if (r === 'copy') p = asCopy(p);
  }
  await store.saveProject(p);
  await openProject(p);
  closeDrawer();
  toast(`「${p.name}」を読み込みました`);
}

// ---------------- サンプル ----------------
// アプリに同梱した設計例。開くたびに新しいプロジェクトとして追加する（元のサンプルは変わらない）
export const SAMPLES = [
  { id: 'usb-dac-amp', file: './samples/usb-dac-amp.json', name: 'USB DAC アンプ',
    desc: 'USB-C（バスパワー）→ ESP32-S3（USB オーディオ）→ 32bit DAC。3.5mm ヘッドホンと 8Ω スピーカー 2ch。60×20mm・4層・配線済み' },
];

async function openSample(id = null) {
  let s = SAMPLES.find((x) => x.id === id);
  if (!s) {
    const r = await ask('サンプルを開く', `<ul class="plain">${SAMPLES.map((x) => `<li><b>${esc(x.name)}</b><br><span class="note">${esc(x.desc)}</span></li>`).join('')}</ul><p class="note">新しいプロジェクトとして追加します。部品の値・品番は設計例です。発注前に必ずデータシートで確かめてください。</p>`,
      [{ label: 'キャンセル', value: '' }, ...SAMPLES.map((x) => ({ label: `「${x.name}」を開く`, value: x.id, cls: 'primary' }))]);
    s = SAMPLES.find((x) => x.id === r);
    if (!s) return null;
  }
  let p;
  try {
    const res = await fetch(s.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    p = asCopy(parseProject(await res.text()));
    p.name = `${s.name}（サンプル）`;
  } catch (e) {
    toast('サンプルを読み込めませんでした: ' + e.message, true);
    return null;
  }
  await store.saveProject(p);
  await openProject(p);
  closeDrawer();
  toast(`サンプル「${s.name}」を開きました`);
  return p;
}

async function showBackups() {
  const rows = await store.listBackups(state.project.id);
  if (!rows.length) { toast('保存履歴はありません'); return; }
  const body = rows.map((r) => `<button type="button" class="btn list-btn" data-key="${r.key}">${fmtTime(r.savedAt)}（rev ${r.revision}）</button>`).join('');
  const key = await ask('保存履歴から復元', `<p>直近${store.MAX_BACKUPS}回分の保存を保持しています。</p>${body}`, [{ label: '閉じる', value: '' }], true);
  if (!key) return;
  const b = await store.loadBackup(Number(key));
  if (!b) return;
  const rev = state.project.revision;
  state.project = b;
  mutateProject((p) => { p.revision = Math.max(p.revision, rev); }, 'restore');
  await state.saver.flush();
  renderAll();
  toast('復元しました');
}

// ---------------- 汎用UI ----------------
function ask(title, html, buttons, listMode = false) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  $('#dialog-actions').replaceChildren(...buttons.map((b) => {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.cls || '');
    el.value = b.value;
    el.textContent = b.label;
    return el;
  }));
  return new Promise((resolve) => {
    if (listMode) {
      $('#dialog-body').querySelectorAll('[data-key]').forEach((el) => {
        el.onclick = () => { dlg.close(el.dataset.key); };
      });
    }
    dlg.onclose = () => resolve(dlg.returnValue);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

/** 1行入力。Enterキーでも確定できる。キャンセル時は null */
async function promptTextWithValue(title, value) {
  const p = ask(title, `<input type="text" id="dlg-input" maxlength="80" enterkeyhint="done">`,
    [{ label: 'キャンセル', value: '' }, { label: 'OK', value: 'ok', cls: 'primary' }]);
  const inp = $('#dlg-input');
  inp.value = value;
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dialog').close('ok'); } };
  inp.select();
  const r = await p;
  return r === 'ok' ? inp.value : null;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
}

function fmtTime(t) {
  const d = new Date(t);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

// ---------------- イベント配線 ----------------
function bindUI() {
  $('#btn-projects').onclick = openDrawer;
  $('#btn-drawer-close').onclick = closeDrawer;
  $('#drawer-backdrop').onclick = closeDrawer;
  $('#btn-new').onclick = async () => {
    const name = await promptTextWithValue('新規プロジェクト', '新規プロジェクト');
    if (name === null) return;
    await newProject(name);
    closeDrawer();
  };
  $('#btn-import').onclick = () => $('#file-import').click();
  $('#btn-sample').onclick = () => openSample();
  $('#file-import').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  };
  $('#project-name').onclick = async () => {
    const name = await promptTextWithValue('プロジェクト名', state.project.name);
    if (name === null || !name.trim() || name.trim() === state.project.name) return;
    mutateProject((p) => { p.name = name.trim(); }, 'rename');
  };
  const manualSave = async () => {
    state.saver.dirty = true;
    try { await state.saver.flush(); toast('保存しました'); } catch { /* setSaveStateで表示済み */ }
  };
  $('#save-state').onclick = manualSave;

  const menu = $('#menu');
  $('#btn-menu').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    menu.hidden = true;
    if (act === 'save') manualSave();
    if (act === 'export') exportProject();
    if (act === 'duplicate') {
      const c = asCopy(state.project);
      await store.saveProject(c);
      await openProject(c);
      toast('複製しました');
    }
    if (act === 'backups') showBackups();
    if (act === 'ai') openAi();
    if (act === 'annotate') { state.editor.reannotate(); toast('部品番号を位置順に振り直しました'); }
    if (act === 'netlist') showNetlist();
    if (act === 'about') {
      ask('Pocket EDA', `<p>${NATIVE ? 'Androidアプリ版 ' : ''}バージョン ${APP_VERSION}</p><p>データはこの端末のブラウザ内（IndexedDB）に保存されます。端末変更やブラウザのデータ削除に備えて、JSON書き出しでバックアップしてください。</p>`,
        [{ label: '閉じる', value: '' }]);
    }
  });
  $('#chk-autosave').onchange = (e) => {
    const on = e.target.checked;
    mutateProject((p) => { p.settings.autosave = on; }, 'settings');
    state.saver.setEnabled(on);
    if (!on) state.saver.flush().catch(() => {}); // 設定変更自体は保存しておく
  };

  // キャンバス（ジェスチャーは回路図エディタが登録する）
  const svg = $('#canvas');
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, dialog')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });
  $('#btn-zoom-in').onclick = () => { const r = svg.getBoundingClientRect(); activeVp().zoomAt(r.width / 2, r.height / 2, 1.25); renderCanvas(); };
  $('#btn-zoom-out').onclick = () => { const r = svg.getBoundingClientRect(); activeVp().zoomAt(r.width / 2, r.height / 2, 0.8); renderCanvas(); };
  $('#btn-zoom-fit').onclick = () => { if (state.workspace === 'pcb') fitPcb(); else centerOrigin(); renderCanvas(); };
  // ジェスチャーは1か所で登録し、作業中の画面のエディタへ振り分ける
  attachGestures(svg, () => activeVp(), new Proxy({}, {
    get: (_, name) => (name === 'onChange' ? scheduleCanvas : activeEditor()?.gestures?.[name]),
  }));
  new ResizeObserver(scheduleCanvas).observe(svg);

  // Android の戻るボタン: アプリ内で戻れるところまで戻り、それ以上は保存してアプリを背面へ
  const AppPlugin = globalThis.Capacitor?.Plugins?.App;
  if (NATIVE && AppPlugin) {
    AppPlugin.addListener('backButton', async () => {
      if (handleBack()) return;
      try { await state.saver.flush(); } catch { /* 保存失敗は表示済み */ }
      AppPlugin.minimizeApp();
    });
    // 背面に回るときに保存
    AppPlugin.addListener('pause', () => { writePending(); state.saver.flush().catch(() => {}); });
  }

  // オンライン状態
  window.addEventListener('offline', () => toast('オフラインです（設計作業は続けられます）'));
}

// ---------------- 起動 ----------------
async function boot() {
  state.saver = new AutoSaver(saveNow, { onState: setSaveState });
  // 退避は保存(flush)より先に同期で行う
  window.addEventListener('pagehide', writePending);
  window.addEventListener('beforeunload', writePending);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writePending(); });
  state.saver.attachLifecycle(window);
  state.history = new History(
    () => state.project.schematic,
    (s) => { state.project.schematic = s; },
  );
  state.editor = createSchematicEditor({
    svg: $('#canvas'),
    content: $('#content'),
    vp: state.vp,
    getSheet: () => state.project.schematic.sheets[0],
    edit: (fn, label) => editSchematic(fn, label),
    onViewChange: scheduleCanvas,
    isActive: () => !!state.project && state.workspace === 'schematic',
    onSelectionChange: () => renderSidePanel(),
    onToolChange: () => renderToolbar(),
    ui: { toast, ask, prompt: promptTextWithValue },
    partProps,
    onPartUsed: usePartInProject,
    getProjectPart: (id) => state.project.library.parts.find((p) => p.id === id) || state.lib.get(id),
    openLibrary: (target = null) => { state.assign = target; switchWorkspace('parts'); },
    openAi: () => openAi(),
  });
  state.pcbHistory = new History(() => state.project.pcb, (s) => { state.project.pcb = s; });
  state.pcbEditor = createPcbEditor({
    svg: $('#canvas'),
    content: $('#pcb-content'),
    vp: state.pcbVp,
    getProject: () => state.project,
    edit: (fn, label) => editPcb(fn, label),
    onViewChange: scheduleCanvas,
    isActive: () => !!state.project && state.workspace === 'pcb',
    onSelectionChange: () => renderSidePanel(),
    onToolChange: () => renderToolbar(),
    ui: { toast, ask, prompt: promptTextWithValue },
    fitAll: () => { fitPcb(); renderCanvas(); },
    // 回路図からネットリストを用意（古ければ作り直して保存）
    getNetlist: async () => {
      if (netlistStatus(state.project) !== 'current') {
        const nl = generateNetlist(state.project);
        mutateProject((p) => { p.netlist = nl; }, 'netlist');
      }
      return state.project.netlist;
    },
    resolveFp: (c) => {
      const part = c.partId ? state.project.library.parts.find((p) => p.id === c.partId) : null;
      return (part && partFootprint(part)) || getFootprint(c.footprint);
    },
  });
  state.checkView = createCheckView({
    root: $('#check-view'),
    getProject: () => state.project,
    getPcb: () => ensurePcb(state.project),
    mutate: (fn, reason) => { mutateProject(fn, reason); renderNav(); },
    jump: jumpTo,
    ask, toast, fmtTime,
  });
  state.outputView = createOutputView({
    root: $('#output-view'),
    getProject: () => state.project,
    getPcb: () => ensurePcb(state.project),
    version: APP_VERSION,
    toast, ask, download, fmtTime,
    runDrc: () => state.checkView.run('drc', { quiet: true }),
    editPcb: (fn, label) => editPcb(fn, label),
    mutate: (fn, reason) => mutateProject(fn, reason),
    open3d: () => open3d(),
  });
  state.aiView = createAiView({
    root: $('#ai-view'),
    getProject: () => state.project,
    mutate: (fn, reason) => mutateProject(fn, reason),
    applySpec: applyAiSpec,
    ask, toast,
    getSetting: (k, d) => store.getSetting(k, d),
    setSetting: (k, v) => store.setSetting(k, v),
    close: () => closeOverlay('#ai-view'),
  });
  state.partsView = createPartsView({
    root: $('#parts-view'),
    lib: state.lib,
    online: state.online,
    setOnlineBase: async (v) => { state.online.setBase(v); await store.setSetting('jlcsearchBase', v || null); },
    ui: { toast, ask, download },
    assignTarget: () => state.assign,
    cancelAssign: () => { state.assign = null; },
    onPlace: (part) => {
      state.assign = null;
      switchWorkspace('schematic');
      state.editor.setPlacePart(part);
      renderToolbar();
      if (!partFootprint(part)) toast(`${part.name}: フットプリント未設定です（部品画面の「編集」で設定するまでネットリストはエラー）。キャンバスをタップして配置`, true);
      else toast(`${part.name}: キャンバスをタップして配置`);
    },
    onAssign: (part) => {
      const t = state.assign;
      state.assign = null;
      switchWorkspace('schematic');
      const r = state.editor.assignPart(t.key, part);
      if (r) toast(`${r.ref} に「${part.name}」を割り当てました${r.kindChanged ? '（シンボルが変わりました。配線を確認してください）' : ''}`, r.kindChanged);
    },
  });
  bindUI();
  centerOrigin();

  try {
    await store.openDB();
  } catch (e) {
    toast('保存領域を開けません: ' + e.message, true);
    return;
  }
  store.requestPersistence();
  try { await state.lib.load(); } catch (e) { toast('部品ライブラリを読み込めません: ' + e.message, true); }
  const jb = await store.getSetting('jlcsearchBase');
  if (jb) state.online.setBase(jb);

  const recovered = await recoverPending();
  if (recovered) await store.setSetting('lastProjectId', recovered);
  const lastId = await store.getSetting('lastProjectId');
  let p = lastId ? await store.loadProject(lastId).catch(() => null) : null;
  if (!p) {
    const list = await store.listProjects();
    p = list.length ? await store.loadProject(list[0].id) : null;
  }
  if (p) await openProject(p);
  else await newProject('はじめてのプロジェクト');
  if (recovered) toast('前回保存しきれなかった変更を復元しました');

  // Android アプリ版はファイルを内蔵しているので Service Worker は不要
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
  }
  document.documentElement.dataset.ready = '1';
}

// 開発・テスト用の操作口（コンソールから使える）
window.pocketEDA = { state, openSample, jumpTo, back: handleBack, openProject, openAi, open3d, applyAiSpec, native: NATIVE, mutateProject, editSchematic, editPcb, undo, redo, store, showNetlist, saveNow: () => state.saver.flush(), version: APP_VERSION };

boot();
