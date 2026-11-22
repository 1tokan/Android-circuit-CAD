// 回路図エディタ（操作・UI）
// データの変更は必ず ctx.edit(fn, label) を通す（履歴と自動保存に乗せるため）。

import { snapPt } from './geom.js';
import { KINDS, POWER_NETS, kindInfo, clampPinCount } from './symbols.js';
import {
  addComponent, addWirePath, addLabel, routeL, hitTest, itemsInRect, snapTarget, isConnectable,
  moveSelection, rotateSelection, mirrorSelection, deleteSelection, describeSelection, findItem,
  isRefTaken, annotate,
} from './model.js';
import { computeConnectivity } from './connectivity.js';
import { renderSheet, symbolPreviewSVG } from './render.js';
import { attachGestures } from '../ui/viewport.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MODE_TOOLS = ['select', 'place', 'wire', 'label', 'power'];

/**
 * @param ctx {
 *   svg, content, vp, getSheet():sheet, edit(fn,label):bool, onViewChange(), ui:{toast, ask, prompt},
 *   isActive():bool, onSelectionChange()
 * }
 */
export function createSchematicEditor(ctx) {
  const st = {
    tool: 'select',
    sel: new Set(),
    multi: false,
    placeKind: 'resistor',
    placePart: null,   // ライブラリの部品を配置するとき（第3段階）
    placeRot: 0,
    powerNet: 'VCC',
    lastLabel: 'NET1',
    wire: { pts: [], hFirst: true },
    drag: null,        // {type:'move'|'box'|'wire'|'place', from, to}
    hover: null,
    conn: null,
  };

  const tol = (info) => ((info?.pointerType === 'touch') ? 22 : 12) / ctx.vp.scale;
  const sheet = () => ctx.getSheet();
  const edit = (fn, label) => ctx.edit(() => fn(sheet()), label);

  // ---------------- 描画 ----------------
  function render() {
    if (!ctx.isActive()) return;
    let sh = sheet();
    const preview = {};
    if (st.drag?.type === 'move' && st.drag.to) {
      sh = structuredClone(sh);
      moveSelection(sh, st.sel, st.drag.to.x - st.drag.from.x, st.drag.to.y - st.drag.from.y);
    }
    if (st.drag?.type === 'box' && st.drag.to) preview.rect = { a: st.drag.from, b: st.drag.to };
    if (st.tool === 'wire') {
      const last = st.wire.pts[st.wire.pts.length - 1];
      const target = st.drag?.type === 'wire' ? st.drag.to : st.hover;
      if (last && target) preview.wire = routeL(last, targetPoint(target, 12 / ctx.vp.scale), st.wire.hFirst);
      if (last) preview.wireStart = st.wire.pts[0];
      if (!last && st.hover) preview.cursor = targetPoint(st.hover, 12 / ctx.vp.scale);
    }
    if (st.tool === 'place' || st.tool === 'power') {
      const at = st.drag?.type === 'place' ? st.drag.to : st.hover;
      if (at) preview.ghost = ghostComp(snapPt(at));
    }
    st.conn = computeConnectivity(sheet());
    const conn = sh === sheet() ? st.conn : computeConnectivity(sh);
    ctx.content.innerHTML = renderSheet(sh, { selection: st.sel, conn, preview });
    renderCtxBar();
  }

  function ghostComp(p) {
    const kind = st.tool === 'power' ? (st.powerNet === 'GND' ? 'gnd' : 'power') : st.placeKind;
    const info = kindInfo(kind);
    const partProps = st.tool === 'place' && st.placePart ? ctx.partProps(st.placePart) : {};
    return { id: 'ghost', kind, ref: info.prefix + '?', x: p.x, y: p.y, rot: st.placeRot, mirror: false,
      props: { ...info.props, ...(info.power ? { net: st.powerNet } : {}), ...partProps } };
  }

  function targetPoint(p, t) { return snapTarget(sheet(), p, t) || snapPt(p); }

  // ---------------- 状態表示バー（キャンバス上部） ----------------
  function renderCtxBar() {
    const bar = $('#ctxbar');
    const chips = [];
    const chip = (act, label, on = false) => `<button type="button" class="chip${on ? ' on' : ''}" data-ctx="${act}">${esc(label)}</button>`;
    if (st.tool === 'select') {
      chips.push(chip('multi', st.multi ? '複数選択 ON' : '複数選択', st.multi));
      if (st.sel.size) {
        const d = describeSelection(sheet(), st.sel);
        const n = st.sel.size;
        chips.push(`<span class="chip-info">${n === 1 && d.comps.length ? esc(d.comps[0].ref) : `${n}個選択`}</span>`);
        if (n === 1 && (d.comps.length || d.labels)) chips.push(chip('props', '属性'));
        chips.push(chip('rotate', '回転'), chip('mirror', 'ミラー'), chip('delete', '削除'), chip('clear', '解除'));
      } else {
        chips.push('<span class="chip-info hint">タップで選択・長押し＋ドラッグで範囲選択</span>');
      }
    } else if (st.tool === 'place') {
      chips.push(chip('pick', st.placePart ? `部品: ${st.placePart.name} ▼` : `部品: ${kindInfo(st.placeKind).label} ▼`), chip('ghostRot', `向き ${st.placeRot}°`));
      chips.push(chip('library', 'ライブラリ'));
      chips.push('<span class="chip-info hint">タップした位置に配置</span>');
    } else if (st.tool === 'wire') {
      chips.push(chip('bend', st.wire.hFirst ? '曲げ: 横→縦' : '曲げ: 縦→横'));
      if (st.wire.pts.length) chips.push(chip('finish', '配線を終了'));
      chips.push(`<span class="chip-info hint">${st.wire.pts.length ? '次の点をタップ（ピン・配線で自動終了）' : '始点をタップ'}</span>`);
    } else if (st.tool === 'label') {
      chips.push(`<span class="chip-info hint">配線やピンの上をタップしてネット名を付ける</span>`);
    } else if (st.tool === 'power') {
      chips.push(chip('pickPower', `記号: ${st.powerNet} ▼`), chip('ghostRot', `向き ${st.placeRot}°`));
    }
    bar.innerHTML = chips.join('');
  }

  async function onCtx(act) {
    switch (act) {
      case 'multi': st.multi = !st.multi; break;
      case 'props': await editProps(); break;
      case 'rotate': case 'mirror': case 'delete': action(act); return;
      case 'clear': setSel(new Set()); break;
      case 'pick': openPicker(); break;
      case 'library': ctx.openLibrary(); return;
      case 'ghostRot': st.placeRot = (st.placeRot + 90) % 360; break;
      case 'bend': st.wire.hFirst = !st.wire.hFirst; break;
      case 'finish': st.wire.pts = []; break;
      case 'pickPower': await pickPowerNet(); break;
      default: break;
    }
    render();
  }

  // ---------------- ツール・アクション ----------------
  function setTool(t) {
    if (!MODE_TOOLS.includes(t)) { action(t); return; }
    st.tool = t;
    st.wire.pts = [];
    st.drag = null;
    if (t === 'place') openPicker();
    if (t === 'power' && !st.powerChosen) pickPowerNet().then(render);
    if (t !== 'select') setSel(new Set(), false);
    ctx.onToolChange?.(t);
    render();
  }

  function action(a) {
    if (a === 'rotate' && st.tool !== 'select' && !st.sel.size) { st.placeRot = (st.placeRot + 90) % 360; render(); return; }
    if (!st.sel.size) { ctx.ui.toast('先に部品や配線を選択してください'); return; }
    if (a === 'rotate') edit((s) => rotateSelection(s, st.sel), '回転');
    if (a === 'mirror') edit((s) => mirrorSelection(s, st.sel), 'ミラー');
    if (a === 'delete') { edit((s) => deleteSelection(s, st.sel), '削除'); setSel(new Set(), false); }
    render();
  }

  function setSel(s, doRender = true) {
    st.sel = s;
    ctx.onSelectionChange?.();
    if (doRender) render();
  }

  // ---------------- ジェスチャー ----------------
  function onTap(p, info) {
    const sh = sheet();
    switch (st.tool) {
      case 'select': {
        const k = hitTest(sh, p, tol(info));
        if (!k) { if (!st.multi && !info.shift && !info.ctrl) setSel(new Set()); return; }
        if (st.multi || info.shift || info.ctrl) {
          const n = new Set(st.sel);
          n.has(k) ? n.delete(k) : n.add(k);
          setSel(n);
        } else setSel(new Set([k]));
        return;
      }
      case 'place': placeAt(p); return;
      case 'power': placeAt(p); return;
      case 'wire': wireClick(p, info); return;
      case 'label': labelAt(p, info); return;
      default: break;
    }
  }

  function onLongPress(p, info) {
    if (st.tool !== 'select') { onTap(p, info); return; }
    const k = hitTest(sheet(), p, tol(info));
    if (k) { setSel(new Set([k])); editProps(); }
  }

  function onDragStart(p, info) {
    const sh = sheet();
    if (st.tool === 'select') {
      const k = hitTest(sh, p, tol(info));
      if (k && !info.longPress) {
        if (!st.sel.has(k)) setSel(st.multi || info.shift ? new Set([...st.sel, k]) : new Set([k]), false);
        st.drag = { type: 'move', from: snapPt(p), to: null };
        return true;
      }
      // 空白: マウス・ペンは範囲選択、タッチは長押し後のみ範囲選択（通常はパン）
      if (info.pointerType !== 'touch' || info.longPress) {
        st.drag = { type: 'box', from: p, to: p, add: st.multi || info.shift };
        return true;
      }
      return false;
    }
    if (st.tool === 'wire') {
      // タッチ: ピン・配線端・直前の点から引き出したときだけ配線ドラッグ。それ以外はパン
      if (info.pointerType === 'touch' && !info.longPress) {
        const last = st.wire.pts[st.wire.pts.length - 1];
        const nearLast = last && Math.hypot(p.x - last.x, p.y - last.y) <= tol(info);
        if (!nearLast && !(st.wire.pts.length === 0 && snapTarget(sh, p, tol(info)))) return false;
      }
      if (!st.wire.pts.length) st.wire.pts = [targetPoint(p, tol(info))];
      st.drag = { type: 'wire', from: p, to: p };
      return true;
    }
    if (st.tool === 'place' || st.tool === 'power') {
      if (info.pointerType === 'touch' && !info.longPress) return false;
      st.drag = { type: 'place', from: p, to: p };
      return true;
    }
    return false;
  }

  function onDragMove(p) {
    if (!st.drag) return;
    st.drag.to = st.drag.type === 'move' ? snapPt(p) : p;
    render();
  }

  function onDragEnd(p, info) {
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (d.type === 'move') {
      const to = snapPt(p);
      edit((s) => moveSelection(s, st.sel, to.x - d.from.x, to.y - d.from.y), '移動');
    } else if (d.type === 'box') {
      const found = itemsInRect(sheet(), d.from, p);
      setSel(d.add ? new Set([...st.sel, ...found]) : found, false);
    } else if (d.type === 'wire') {
      wireClick(p, info);
      return;
    } else if (d.type === 'place') {
      placeAt(p);
      return;
    }
    render();
  }

  function onDragCancel() { st.drag = null; render(); }

  // ---------------- 各ツールの処理 ----------------
  function placeAt(p) {
    const at = snapPt(p);
    const kind = st.tool === 'power' ? (st.powerNet === 'GND' ? 'gnd' : 'power') : st.placeKind;
    let placed;
    const part = st.tool === 'place' ? st.placePart : null;
    edit((s) => {
      const extra = kind === 'power' || kind === 'gnd' ? { net: st.powerNet } : part ? ctx.partProps(part) : {};
      placed = addComponent(s, kind, at.x, at.y, extra);
      placed.rot = st.placeRot;
    }, '部品配置');
    if (part) ctx.onPartUsed(part);
    ctx.ui.toast(`${placed.ref} を配置しました`);
    render();
  }

  /** 外部（部品一覧からのドラッグ）からの配置 */
  function placeKindAt(kind, p) {
    st.placeKind = kind;
    st.placePart = null;
    st.tool = 'place';
    ctx.onToolChange?.('place');
    placeAt(p);
  }

  function wireClick(p, info) {
    const sh = sheet();
    const target = targetPoint(p, tol(info));
    const pts = st.wire.pts;
    if (!pts.length) { st.wire.pts = [target]; render(); return; }
    const last = pts[pts.length - 1];
    if (last.x === target.x && last.y === target.y) { st.wire.pts = []; render(); return; } // 同じ点で終了
    const endsOnSomething = isConnectable(sh, target);
    edit((s) => addWirePath(s, routeL(last, target, st.wire.hFirst)), '配線');
    if (endsOnSomething) st.wire.pts = [];
    else st.wire.pts = [...pts, target];
    render();
  }

  async function labelAt(p, info) {
    const at = targetPoint(p, tol(info));
    const name = await ctx.ui.prompt('ネットラベル', st.lastLabel);
    if (name === null || !name.trim()) return;
    st.lastLabel = nextLabelName(name.trim());
    edit((s) => addLabel(s, at.x, at.y, name), 'ラベル');
    if (!isConnectable(sheet(), at)) ctx.ui.toast('ラベルが配線・ピンに接していません', true);
    render();
  }

  function nextLabelName(n) {
    const m = n.match(/^(.*?)(\d+)$/);
    return m ? `${m[1]}${Number(m[2]) + 1}` : n;
  }

  async function pickPowerNet() {
    const btns = POWER_NETS.map((n) => `<button type="button" class="btn list-btn" data-key="${n}">${n}</button>`).join('') +
      '<button type="button" class="btn list-btn" data-key="__custom">その他（名前を入力）</button>';
    let r = await ctx.ui.ask('電源記号', btns, [{ label: '閉じる', value: '' }], true);
    if (!r) return;
    if (r === '__custom') {
      r = await ctx.ui.prompt('電源ネット名', '+3V3');
      if (!r || !r.trim()) return;
      r = r.trim();
    }
    st.powerNet = r;
    st.powerChosen = true;
    if (st.tool !== 'power') { st.tool = 'power'; ctx.onToolChange?.('power'); }
  }

  // ---------------- 部品一覧（下からのシート） ----------------
  function openPicker() {
    const pk = $('#picker');
    const grid = $('#picker-grid');
    if (!grid.childElementCount) {
      grid.innerHTML = KINDS.filter((k) => !k.power).map((k) =>
        `<button type="button" class="pick" data-kind="${k.kind}">${symbolPreviewSVG(k.kind, k.props)}<span>${esc(k.label)}</span></button>`).join('');
      grid.querySelectorAll('.pick').forEach(bindPickItem);
    }
    grid.querySelectorAll('.pick').forEach((b) => b.classList.toggle('on', b.dataset.kind === st.placeKind));
    pk.hidden = false;
  }
  function closePicker() { $('#picker').hidden = true; }

  /** タップ: 配置する部品に選ぶ / ドラッグ: キャンバスに落とした位置へ配置 */
  function bindPickItem(btn) {
    let start = null, ghost = null;
    btn.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, id: e.pointerId }; btn.setPointerCapture(e.pointerId); });
    btn.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.innerHTML = btn.innerHTML;
        document.body.append(ghost);
        $('#picker').classList.add('dragging');
      }
      if (ghost) { ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`; }
    });
    const finish = (e, ok) => {
      if (!start || e.pointerId !== start.id) return;
      const kind = btn.dataset.kind;
      if (ghost) {
        ghost.remove(); ghost = null;
        $('#picker').classList.remove('dragging');
        const r = ctx.svg.getBoundingClientRect();
        const pr = $('#picker').getBoundingClientRect();
        const inCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        const inPicker = e.clientX >= pr.left && e.clientX <= pr.right && e.clientY >= pr.top && e.clientY <= pr.bottom;
        if (ok && inCanvas && !inPicker) {
          closePicker();
          placeKindAt(kind, ctx.vp.screenToWorld(e.clientX - r.left, e.clientY - r.top));
        }
      } else if (ok) {
        st.placeKind = kind;
        st.placePart = null;
        st.tool = 'place';
        ctx.onToolChange?.('place');
        closePicker();
        ctx.ui.toast(`${kindInfo(kind).label}: キャンバスをタップして配置`);
        render();
      }
      start = null;
    };
    btn.addEventListener('pointerup', (e) => finish(e, true));
    btn.addEventListener('pointercancel', (e) => finish(e, false));
  }

  // ---------------- 属性編集 ----------------
  async function editProps() {
    if (st.sel.size !== 1) return;
    const k = [...st.sel][0];
    const item = findItem(sheet(), k);
    if (!item) return;
    if (k.startsWith('l:')) {
      const name = await ctx.ui.prompt('ネットラベル名', item.name);
      if (name && name.trim()) edit((s) => { findItem(s, k).name = name.trim(); }, 'ラベル名');
      render();
      return;
    }
    if (!k.startsWith('c:')) return;
    const c = item;
    const info = kindInfo(c.kind);
    const f = (name, label, val, attrs = '') => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(val)}" ${attrs}></label>`;
    let html;
    if (info.power) {
      html = f('net', 'ネット名', c.props.net);
    } else {
      html = f('ref', '部品番号', c.ref, 'autocapitalize="characters"') + f('value', '値・型番', c.props.value) +
        f('footprint', 'フットプリント', c.props.footprint) + f('lcsc', 'LCSC品番', c.props.lcsc, 'placeholder="例: C17414"') +
        f('mpn', 'メーカー型番', c.props.mpn) + f('manufacturer', 'メーカー', c.props.manufacturer);
      if (c.kind === 'ic' || c.kind === 'connector') {
        html += f('pinCount', 'ピン数', c.props.pinCount, 'inputmode="numeric"') +
          f('pinNames', 'ピン名（カンマ区切り、1番から）', c.props.pinNames, 'placeholder="例: VCC,GND,SDA,SCL"');
      }
      html += `<label class="field check"><input type="checkbox" name="dnp" ${c.props.dnp ? 'checked' : ''}> 実装しない（BOM/CPLから除外）</label>`;
      const part = c.props.partId ? ctx.getProjectPart(c.props.partId) : null;
      html += part
        ? `<p class="note">部品データ: <b>${esc(part.name)}</b>${part.lcsc ? `（${esc(part.lcsc)}）` : ''}。フットプリントとピン↔パッド対応は部品データのものを使います。</p>`
        : '<p class="note">部品データ未割り当て。「ライブラリから選ぶ」でLCSC品番・フットプリント・ピン対応をまとめて設定できます。</p>';
    }
    const r = await ctx.ui.ask(`${c.ref} の属性`, `<div class="form">${html}</div>`,
      [{ label: 'キャンセル', value: '' }, ...(info.power ? [] : [{ label: 'ライブラリから選ぶ', value: 'lib' }]), ...(c.props.partId ? [{ label: '部品データを外す', value: 'unlink' }] : []), { label: '保存', value: 'ok', cls: 'primary' }]);
    if (r === 'lib') { ctx.openLibrary({ key: k, ref: c.ref }); return; }
    if (r === 'unlink') { edit((s) => { delete findItem(s, k).props.partId; }, '部品データを外す'); render(); return; }
    if (r !== 'ok') return;
    const v = (n) => $(`#dialog-body [name="${n}"]`);
    if (info.power) {
      const net = v('net').value.trim();
      if (!net) return;
      edit((s) => {
        const x = findItem(s, k);
        x.props.net = net;
        if (net === 'GND' && x.kind === 'power') x.kind = 'gnd';
        if (net !== 'GND' && x.kind === 'gnd' && !/GND|VSS/i.test(net)) x.kind = 'power';
      }, '属性');
      render();
      return;
    }
    const ref = v('ref').value.trim().toUpperCase();
    if (!/^[A-Z#]+\d+$/.test(ref)) { ctx.ui.toast('部品番号は「英字＋数字」で入力してください（例: R1）', true); return; }
    if (isRefTaken(sheet(), ref, c.id)) { ctx.ui.toast(`${ref} は既に使われています`, true); return; }
    edit((s) => {
      const x = findItem(s, k);
      x.ref = ref;
      for (const n of ['value', 'footprint', 'lcsc', 'mpn', 'manufacturer']) x.props[n] = v(n).value.trim();
      x.props.lcsc = x.props.lcsc.toUpperCase();
      x.props.dnp = v('dnp').checked;
      if (x.kind === 'ic' || x.kind === 'connector') {
        x.props.pinCount = x.kind === 'ic' ? clampPinCount(v('pinCount').value, 2, 128, true) : clampPinCount(v('pinCount').value, 1, 64);
        x.props.pinNames = v('pinNames').value.trim();
      }
    }, '属性');
    if (c.props.lcsc && !/^C\d+$/.test(c.props.lcsc)) ctx.ui.toast('LCSC品番は「C＋数字」の形式です（例: C17414）', true);
    render();
  }

  function reannotate() {
    edit((s) => annotate(s), '部品番号の振り直し');
    render();
  }

  // ---------------- キーボード（タブレット＋キーボード用） ----------------
  function onKey(e) {
    if (!ctx.isActive() || e.target.closest('input, textarea, dialog')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { st.wire.pts = []; st.drag = null; if (st.tool !== 'select') setTool('select'); else setSel(new Set()); }
    else if (k === 'r') action('rotate');
    else if (k === 'm' || k === 'x') action('mirror');
    else if (k === 'delete' || k === 'backspace') action('delete');
    else if (k === 'w') setTool('wire');
    else if (k === 'l') setTool('label');
    else if (k === 'p') setTool('place');
    else if (k === 's' && !e.ctrlKey && !e.metaKey) setTool('select');
    else if (k === 'e' && st.sel.size === 1) editProps();
    else return;
    e.preventDefault();
  }

  // ---------------- 初期化 ----------------
  attachGestures(ctx.svg, ctx.vp, {
    onChange: ctx.onViewChange,
    onTap, onLongPress, onDragStart, onDragMove, onDragEnd, onDragCancel,
    onHover: (p) => { if (st.tool !== 'select') { st.hover = p; render(); } },
  });
  ctx.svg.addEventListener('pointerleave', () => { if (st.hover) { st.hover = null; render(); } });
  // ダブルクリックで属性: マウス・ペンのみ（タッチの連続タップは複数選択の追加・解除と衝突するため。タッチは長押し）
  let lastPointerType = 'mouse';
  ctx.svg.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType; }, true);
  ctx.svg.addEventListener('dblclick', (e) => {
    if (st.tool !== 'select' || st.multi || lastPointerType === 'touch') return;
    const r = ctx.svg.getBoundingClientRect();
    const k = hitTest(sheet(), ctx.vp.screenToWorld(e.clientX - r.left, e.clientY - r.top), 12 / ctx.vp.scale);
    if (k) { setSel(new Set([k])); editProps(); }
  });
  $('#ctxbar').addEventListener('click', (e) => { const a = e.target.closest('[data-ctx]')?.dataset.ctx; if (a) onCtx(a); });
  $('#picker-close').addEventListener('click', closePicker);
  document.addEventListener('keydown', onKey);

  /** ライブラリの部品を配置モードにする */
  function setPlacePart(part) {
    st.placePart = part;
    st.placeKind = part.kind;
    st.tool = 'place';
    st.placeRot = 0;
    setSel(new Set(), false);
    ctx.onToolChange?.('place');
    render();
  }

  /** 回路図の部品にライブラリの部品データを割り当てる（シンボル種別が違えば種別も変える） */
  function assignPart(key, part) {
    const c = findItem(sheet(), key);
    if (!c) return null;
    const kindChanged = c.kind !== part.kind;
    edit((s) => {
      const x = findItem(s, key);
      x.kind = part.kind;
      Object.assign(x.props, ctx.partProps(part));
      if (!part.symbol?.pinCount) { delete x.props.pinCount; delete x.props.pinNames; }
    }, '部品データ割り当て');
    ctx.onPartUsed(part);
    setSel(new Set([key]), false);
    render();
    return { ref: c.ref, kindChanged };
  }

  return {
    state: st,
    render,
    setPlacePart,
    assignPart,
    setTool,
    action,
    editProps,
    reannotate,
    resetForProject() { st.sel = new Set(); st.wire.pts = []; st.drag = null; st.tool = 'select'; closePicker(); },
    selectionSummary: () => describeSelection(sheet(), st.sel),
    connectivity: () => computeConnectivity(sheet()),
  };
}
