// Pocket EDA 起動・UIシェル
import {
  createProject, touch, serializeProject, parseProject, asCopy, safeFileName, ProjectFormatError,
} from './core/project.js';
import * as store from './core/storage.js';
import { AutoSaver } from './core/autosave.js';
import { bus } from './core/events.js';
import { MODULES, WORKSPACES, TOOLS, workspaceStatus } from './modules/registry.js';
import { Viewport } from './ui/viewport.js';
import { History } from './core/history.js';
import { createSchematicEditor } from './schematic/editor.js';

const $ = (s) => document.querySelector(s);
const APP_VERSION = '0.2.0';

const state = {
  project: null,
  workspace: 'schematic',
  vp: new Viewport({ scale: 8 }),
  saver: null,
  history: null,
  editor: null,
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
  bus.emit('project:saved', { id: state.project.id, revision: state.project.revision });
}

/** プロジェクトを変更する唯一の入口。全モジュールはこれを使う */
export function mutateProject(fn, reason = 'edit') {
  fn(state.project);
  touch(state.project);
  state.saver.markDirty();
  bus.emit('project:changed', { reason, revision: state.project.revision });
  renderHeader();
  renderUndo();
}

/** 回路図の編集（元に戻す履歴に積む）。変化が無ければ保存もしない */
function editSchematic(fn, label) {
  let changed = false;
  changed = state.history.record(() => { fn(); }, label);
  if (changed) { mutateProject(() => {}, label); renderSidePanel(); }
  return changed;
}

function undo() {
  const l = state.history.undo();
  if (l === null) return;
  mutateProject(() => {}, 'undo');
  state.editor.state.sel = new Set();
  state.editor.render();
  renderSidePanel();
  toast(`元に戻す: ${l}`);
}
function redo() {
  const l = state.history.redo();
  if (l === null) return;
  mutateProject(() => {}, 'redo');
  state.editor.state.sel = new Set();
  state.editor.render();
  renderSidePanel();
  toast(`やり直す: ${l}`);
}
function renderUndo() {
  $('#btn-undo').disabled = !state.history?.canUndo();
  $('#btn-redo').disabled = !state.history?.canRedo();
}

async function openProject(project) {
  if (state.project && state.saver.dirty) await state.saver.flush();
  state.project = project;
  state.history.clear();
  state.editor.resetForProject();
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
    b.onclick = () => { state.workspace = ws.id; renderAll(); };
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
    b.disabled = !enabled;
    b.title = enabled ? t.label : `${t.label}（未実装）`;
    b.dataset.tool = t.id;
    if (enabled && state.workspace === 'schematic' && state.editor.state.tool === t.id) b.classList.add('on');
    b.innerHTML = `<svg class="ico" viewBox="0 0 24 24"><path d="${t.icon || 'M5 5h14v14H5z'}"/></svg>${t.label}`;
    if (enabled) b.onclick = () => { onTool(t.id); };
    return b;
  }));
}

function onTool(id) {
  if (state.workspace !== 'schematic') return;
  state.editor.setTool(id);
  renderToolbar();
}

function renderOverlay() {
  const ws = WORKSPACES.find((w) => w.id === state.workspace);
  const mods = ws.modules.map((id) => MODULES.find((m) => m.id === id));
  const planned = mods.filter((m) => m.status === 'planned');
  const ov = $('#stage-overlay');
  $('#ctxbar').hidden = workspaceStatus(ws) === 'planned';
  $('#content').style.display = state.workspace === 'schematic' ? '' : 'none';
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
    li.innerHTML = `<span>${m.name}</span><span class="badge ${m.status}">${label[m.status]}</span>`;
    return li;
  }));
}

function renderSidePanel() {
  const el = $('#sel-info');
  if (!state.editor || state.workspace !== 'schematic') { el.innerHTML = ''; return; }
  const d = state.editor.selectionSummary();
  const sh = state.project.schematic.sheets[0];
  const conn = state.editor.connectivity();
  let html = `<h2>回路図</h2><p class="kv">部品 ${sh.components.filter((c) => c.kind !== 'power' && c.kind !== 'gnd').length}・配線 ${sh.wires.length}・ネット ${conn.nets.filter((n) => n.pins.length >= 2 || n.named).length}・未接続ピン ${conn.unconnectedPins.length}</p>`;
  if (d.comps.length === 1 && state.editor.state.sel.size === 1) {
    const c = d.comps[0];
    const row = (k, v) => `<div class="kv"><span>${k}</span><b>${esc(v || '—')}</b></div>`;
    html += `<h2>選択中: ${esc(c.ref)}</h2>` + row('値', c.props.value ?? c.props.net) + row('フットプリント', c.props.footprint) +
      row('LCSC', c.props.lcsc) + row('向き', `${c.rot}°${c.mirror ? '・反転' : ''}`) +
      `<button class="btn small-btn" id="btn-side-props">属性を編集</button>`;
  } else if (state.editor.state.sel.size) {
    html += `<h2>${state.editor.state.sel.size}個選択中</h2>`;
  }
  el.innerHTML = html;
  $('#btn-side-props')?.addEventListener('click', () => state.editor.editProps());
}

function showConnections() {
  const conn = state.editor.connectivity();
  const list = conn.nets.map((n) => `<li><b>${esc(n.name)}</b>${n.conflictingNames ? ` <span class="warn">名前が衝突: ${esc(n.conflictingNames.join(', '))}</span>` : ''}<br><small>${n.pins.map((p) => `${esc(p.ref)}.${esc(p.pin)}`).join(', ') || '（ピンなし）'}</small></li>`).join('');
  const nc = conn.unconnectedPins.filter((p) => !p.isPower).map((p) => `${esc(p.ref)}.${esc(p.pin)}`).join(', ');
  ask('接続一覧（確認用）', `<p class="note">回路図から計算した電気的接続です。製造用ネットリストの出力は第3段階で実装します。</p>` +
    `<ul class="netlist">${list || '<li>ネットはありません</li>'}</ul>` + (nc ? `<p><b>未接続ピン:</b> ${nc}</p>` : ''), [{ label: '閉じる', value: '' }]);
}

function renderCanvas() {
  const svg = $('#canvas');
  const { width, height } = svg.getBoundingClientRect();
  const vp = state.vp;
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
  $('#coords').textContent = `×${vp.scale.toFixed(1)}`;
  state.editor?.render();
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
  const text = serializeProject(state.project);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName(state.project.name)}.pocketeda.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    if (act === 'annotate') { state.editor.reannotate(); toast('部品番号を位置順に振り直しました'); }
    if (act === 'netlist-preview') showConnections();
    if (act === 'about') {
      ask('Pocket EDA', `<p>バージョン ${APP_VERSION}（第2段階: 回路図エディタ）</p><p>データはこの端末のブラウザ内（IndexedDB）に保存されます。端末変更やブラウザのデータ削除に備えて、JSON書き出しでバックアップしてください。</p>`,
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
  $('#btn-zoom-in').onclick = () => { const r = svg.getBoundingClientRect(); state.vp.zoomAt(r.width / 2, r.height / 2, 1.25); renderCanvas(); };
  $('#btn-zoom-out').onclick = () => { const r = svg.getBoundingClientRect(); state.vp.zoomAt(r.width / 2, r.height / 2, 0.8); renderCanvas(); };
  $('#btn-zoom-fit').onclick = () => { centerOrigin(); renderCanvas(); };
  new ResizeObserver(scheduleCanvas).observe(svg);

  // オンライン状態
  window.addEventListener('offline', () => toast('オフラインです（設計作業は続けられます）'));
}

// ---------------- 起動 ----------------
async function boot() {
  state.saver = new AutoSaver(saveNow, { onState: setSaveState });
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

  const lastId = await store.getSetting('lastProjectId');
  let p = lastId ? await store.loadProject(lastId).catch(() => null) : null;
  if (!p) {
    const list = await store.listProjects();
    p = list.length ? await store.loadProject(list[0].id) : null;
  }
  if (p) await openProject(p);
  else await newProject('はじめてのプロジェクト');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
  }
  document.documentElement.dataset.ready = '1';
}

// 開発・テスト用の操作口（コンソールから使える）
window.pocketEDA = { state, mutateProject, editSchematic, undo, redo, store, saveNow: () => state.saver.flush(), version: APP_VERSION };

boot();
