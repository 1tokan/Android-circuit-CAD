// PCB レイアウトエディタ（操作・UI）
// データの変更は必ず ctx.edit(fn, label) を通す（PCB用の元に戻す履歴と自動保存に乗せる）
import {
  ensurePcb, toNm, toMm, arrangeInBoard, copperLayers, layerName, fpBox, boardRect, routePath, snapMm, addTrackPath, addVia, addBoardZone, addText, addHole, setOutlineRect,
  hitTest, itemsInRect, moveSelection, rotateSelection, flipSelection, deleteSelection, findItem, boardSizeText, importNetlist,
} from './model.js';
import { computePcbConnectivity, snapTarget } from './connectivity.js';
import { drcRules } from '../check/rules.js';
import { renderPcb } from './render.js';
import { esc } from '../core/util.js';

const $ = (s) => document.querySelector(s);
export const PCB_MODE_TOOLS = ['select', 'route', 'via', 'zone', 'outline', 'text'];
const WIDTHS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1.0];

/**
 * @param ctx { svg, content, vp, getProject, edit(fn,label), ui:{toast, ask, prompt}, isActive(), onSelectionChange(), onToolChange(), getNetlist(), resolveFp(c) }
 */
export function createPcbEditor(ctx) {
  const st = {
    tool: 'select', sel: new Set(), multi: false, layer: 'F.Cu', diagonalFirst: false,
    route: { pts: [], net: null }, drag: null, hover: null, holeMode: false, conn: null,
  };
  const pcb = () => ensurePcb(ctx.getProject());
  const S = () => pcb().settings;
  const tol = (info) => ((info?.pointerType === 'touch') ? 22 : 10) / ctx.vp.scale;
  const grid = () => toMm(S().grid);
  const snapPt = (p) => ({ x: snapMm(p.x, grid()), y: snapMm(p.y, grid()) });
  const edit = (fn, label) => ctx.edit(() => fn(pcb()), label);

  /**
   * ドラッグ量 → 実際の移動量。選択の基準（最初の部品・ビア・文字・穴の位置）が移動後にグリッドに乗るようにする。
   * 最初からグリッドからずれている部品も、動かせばグリッドにそろう。
   */
  function snappedDelta(from, to) {
    const raw = { x: to.x - from.x, y: to.y - from.y };
    const anchorKey = [...st.sel].find((k) => 'fvxh'.includes(k[0]));
    const o = anchorKey && findItem(pcb(), anchorKey);
    if (!o) return { x: snapMm(raw.x, grid()), y: snapMm(raw.y, grid()) };
    const ax = toMm(o.x), ay = toMm(o.y);
    return { x: snapMm(ax + raw.x, grid()) - ax, y: snapMm(ay + raw.y, grid()) - ay };
  }

  // ---------------- 描画 ----------------
  let refillTimer = null;
  function scheduleRefill() {
    clearTimeout(refillTimer);
    refillTimer = setTimeout(() => {
      refillTimer = null;
      if (st.drag || !ctx.isActive()) { if (st.drag) scheduleRefill(); return; }
      st.conn = computePcbConnectivity(pcb(), { rules: drcRules(ctx.getProject()) });
      render();
      ctx.onSelectionChange?.();
    }, 350);
  }
  function render() {
    if (!ctx.isActive()) return;
    let board = pcb();
    const preview = {};
    if (st.drag?.type === 'move' && st.drag.to) {
      board = structuredClone(board);
      const d = snappedDelta(st.drag.from, st.drag.to);
      moveSelection(board, st.sel, d.x, d.y);
    }
    if (st.drag?.type === 'box' && st.drag.to) preview.rect = { a: st.drag.from, b: st.drag.to };
    if (st.tool === 'route') {
      const last = st.route.pts[st.route.pts.length - 1];
      const target = st.drag?.type === 'route' ? st.drag.to : st.hover;
      if (last && target) {
        const t = snapTarget(pcb(), target, 12 / ctx.vp.scale, st.layer);
        preview.route = routePath(last, t || snapPt(target), S().angleMode, st.diagonalFirst);
        preview.layer = st.layer;
        preview.width = toMm(S().trackWidth);
      }
      if (last) preview.routeStart = st.route.pts[0];
      if (!last && st.hover) preview.cursor = snapTarget(pcb(), st.hover, 12 / ctx.vp.scale, st.layer) || snapPt(st.hover);
    }
    const rules = drcRules(ctx.getProject());
    // ベタの塗り直しは重いので、編集直後は前回の塗りを薄く表示し、手が止まってから塗り直す
    st.conn = computePcbConnectivity(pcb(), { rules, allowStaleFill: true });
    if (st.conn.fillStale) scheduleRefill();
    const conn = board === pcb() ? st.conn : computePcbConnectivity(board, { rules, allowStaleFill: true });
    ctx.content.innerHTML = renderPcb(board, { selection: st.sel, conn, activeLayer: st.layer, preview });
    renderCtxBar();
  }

  function renderCtxBar() {
    const bar = $('#ctxbar');
    const chip = (act, label, on = false) => `<button type="button" class="chip${on ? ' on' : ''}" data-pctx="${act}">${esc(label)}</button>`;
    if (!copperLayers(pcb()).includes(st.layer)) st.layer = 'F.Cu'; // 層数を減らしたとき
    const layerChip = chip('layer', `層: ${layerName(st.layer)}`, st.layer !== 'F.Cu');
    const info = `<span class="chip-info">${esc(boardSizeText(pcb()))}・未配線 <b>${st.conn?.unrouted ?? 0}</b>${st.conn?.shorts.length ? ` ・<span class="err">短絡 ${st.conn.shorts.length}</span>` : ''}</span>`;
    const c = [];
    if (st.tool === 'select') {
      if (!pcb().footprints.length) c.push(chip('import', 'ネットリストを読み込む', true));
      else c.push(chip('import', 'ネットリスト再読込'));
      const br = boardRect(pcb());
      const outside = pcb().footprints.filter((f) => { const b = fpBox(f); return b.x1 < br.x0 || b.x0 > br.x1 || b.y1 < br.y0 || b.y0 > br.y1; }).length;
      if (outside) c.push(chip('arrange', `基板内に並べる（${outside}）`, true));
      c.push(chip('multi', st.multi ? '複数選択 ON' : '複数選択', st.multi), layerChip);
      if (st.sel.size) c.push(chip('props', '属性'), chip('rotate', '回転'), chip('flip', '裏返す'), chip('delete', '削除'), chip('clear', '解除'));
      c.push(info);
    } else if (st.tool === 'route') {
      c.push(layerChip, chip('width', `幅 ${toMm(S().trackWidth)}mm`), chip('angle', { 45: '45°', 90: '90°', free: '自由' }[S().angleMode]), chip('posture', st.diagonalFirst ? '斜め→直線' : '直線→斜め'));
      if (st.route.pts.length) c.push(chip('via', 'ビアで層移動'), chip('finish', '配線を終了'));
      c.push(`<span class="chip-info hint">${st.route.pts.length ? `${esc(st.route.net || 'ネットなし')}: 次の点をタップ` : 'パッド・配線端・ビアをタップして開始'}</span>`, info);
    } else if (st.tool === 'via') {
      c.push(`<span class="chip-info hint">タップした位置にビア（外径${toMm(S().viaDiameter)}/穴${toMm(S().viaDrill)}mm）</span>`, info);
    } else if (st.tool === 'zone') {
      c.push(layerChip, `<span class="chip-info hint">基板をタップしてベタ（塗りつぶし）を作成</span>`);
    } else if (st.tool === 'outline') {
      c.push(chip('size', `基板サイズ ${boardSizeText(pcb())}`), chip('hole', st.holeMode ? '取付穴: タップで配置' : '取付穴を追加', st.holeMode));
    } else if (st.tool === 'text') {
      c.push(layerChip, `<span class="chip-info hint">タップした位置にシルク文字（${st.layer === 'F.Cu' ? '表' : '裏'}）</span>`);
    }
    bar.innerHTML = c.join('');
  }

  async function onCtx(a) {
    switch (a) {
      case 'import': await importFromSchematic(); break;
      case 'arrange': {
        let r;
        edit((p) => { r = arrangeInBoard(p); }, '基板内に並べる');
        if (r?.notFit.length) ctx.ui.toast(`${r.moved.length}個を並べました。入りきらない部品: ${r.notFit.join(', ')}（基板を大きくしてください）`, true);
        else if (r) ctx.ui.toast(`${r.moved.length}個を基板内に並べました。位置を整えてから配線してください`);
        break;
      }
      case 'multi': st.multi = !st.multi; break;
      case 'layer': st.layer = nextLayer(); break;
      case 'props': await editProps(); break;
      case 'rotate': case 'flip': case 'delete': action(a); return;
      case 'clear': setSel(new Set(), false); break;
      case 'width': await pickWidth(); break;
      case 'angle': edit((p) => { p.settings.angleMode = { 45: '90', 90: 'free', free: '45' }[p.settings.angleMode]; }, '配線角度'); break;
      case 'posture': st.diagonalFirst = !st.diagonalFirst; break;
      case 'via': routeVia(); break;
      case 'finish': st.route = { pts: [], net: null }; break;
      case 'size': await outlineDialog(); break;
      case 'hole': st.holeMode = !st.holeMode; break;
      default: break;
    }
    render();
  }

  // ---------------- ツール・アクション ----------------
  function setTool(t) {
    if (!PCB_MODE_TOOLS.includes(t)) { action(t); return; }
    st.tool = t;
    st.route = { pts: [], net: null };
    st.drag = null;
    st.holeMode = false;
    if (t !== 'select') setSel(new Set(), false);
    ctx.onToolChange?.(t);
    if (t === 'outline') outlineDialog().then(render);
    render();
  }

  function action(a) {
    if (!st.sel.size) { ctx.ui.toast('先に部品や配線を選択してください'); return; }
    if (a === 'rotate') edit((p) => rotateSelection(p, st.sel), '回転');
    if (a === 'flip') edit((p) => flipSelection(p, st.sel), '裏返し');
    if (a === 'delete') {
      const locked = [...st.sel].some((k) => findItem(pcb(), k)?.locked);
      edit((p) => deleteSelection(p, st.sel), '削除');
      if (locked) ctx.ui.toast('ロック中の部品は削除しませんでした');
      setSel(new Set(), false);
    }
    render();
  }

  function setSel(s, doRender = true) {
    st.sel = s;
    ctx.onSelectionChange?.();
    if (doRender) render();
  }

  // ---------------- ジェスチャー ----------------
  function onTap(p, info) {
    switch (st.tool) {
      case 'select': {
        const k = hitTest(pcb(), p, tol(info), st.layer);
        if (!k) { if (!st.multi && !info.shift && !info.ctrl) setSel(new Set()); return; }
        if (st.multi || info.shift || info.ctrl) { const n = new Set(st.sel); n.has(k) ? n.delete(k) : n.add(k); setSel(n); }
        else setSel(new Set([k]));
        return;
      }
      case 'route': routeClick(p, info); return;
      case 'via': {
        const t = snapTarget(pcb(), p, tol(info), st.layer);
        const at = t && t.kind !== 'pad' ? t : snapPt(p);
        edit((b) => addVia(b, at.x, at.y, t?.net || null), 'ビア');
        render();
        return;
      }
      case 'zone': zoneDialog(); return;
      case 'outline': if (st.holeMode) { const at = snapPt(p); holeAt(at); } return;
      case 'text': textAt(snapPt(p)); return;
      default: break;
    }
  }

  function onLongPress(p, info) {
    if (st.tool !== 'select') { onTap(p, info); return; }
    const k = hitTest(pcb(), p, tol(info), st.layer);
    if (k) { setSel(new Set([k])); editProps(); }
  }

  function onDragStart(p, info) {
    if (st.tool === 'select') {
      const k = hitTest(pcb(), p, tol(info), st.layer);
      if (k && !info.longPress && !k.startsWith('z:')) {
        if (!st.sel.has(k)) setSel(st.multi || info.shift ? new Set([...st.sel, k]) : new Set([k]), false);
        st.drag = { type: 'move', from: p, to: null };
        return true;
      }
      if (info.pointerType !== 'touch' || info.longPress) { st.drag = { type: 'box', from: p, to: p, add: st.multi || info.shift }; return true; }
      return false;
    }
    if (st.tool === 'route') {
      const last = st.route.pts[st.route.pts.length - 1];
      const near = last ? Math.hypot(p.x - last.x, p.y - last.y) <= tol(info) : !!snapTarget(pcb(), p, tol(info), st.layer);
      if (info.pointerType === 'touch' && !info.longPress && !near) return false;
      if (!last) { routeClick(p, info); if (!st.route.pts.length) return false; }
      st.drag = { type: 'route', from: p, to: p };
      return true;
    }
    return false;
  }

  function onDragMove(p) {
    if (!st.drag) return;
    st.drag.to = p;
    render();
  }

  function onDragEnd(p, info) {
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (d.type === 'move') {
      const dd = snappedDelta(d.from, p);
      const moved = edit((b) => moveSelection(b, st.sel, dd.x, dd.y), '移動');
      if (!moved && [...st.sel].some((k) => findItem(pcb(), k)?.locked)) ctx.ui.toast('ロック中の部品は動かせません');
    } else if (d.type === 'box') {
      const found = itemsInRect(pcb(), d.from, p);
      setSel(d.add ? new Set([...st.sel, ...found]) : found, false);
    } else if (d.type === 'route') { routeClick(p, info); return; }
    render();
  }
  function onDragCancel() { st.drag = null; render(); }

  // ---------------- 配線 ----------------
  function routeClick(p, info) {
    const b = pcb();
    const t = snapTarget(b, p, tol(info), st.layer);
    if (!st.route.pts.length) {
      if (!t) { ctx.ui.toast('パッド・配線の端・ビアをタップして配線を始めてください'); return; }
      st.route = { pts: [{ x: t.x, y: t.y }], net: t.net, startKey: t.key };
      render();
      return;
    }
    const last = st.route.pts[st.route.pts.length - 1];
    if (t && t.net && st.route.net && t.net !== st.route.net) {
      ctx.ui.toast(`別のネット（${t.net}）には接続できません。いまの配線は ${st.route.net} です`, true);
      return;
    }
    const at = t ? { x: t.x, y: t.y } : snapPt(p);
    if (Math.hypot(at.x - last.x, at.y - last.y) < 1e-6) { st.route = { pts: [], net: null }; render(); return; }
    const net = st.route.net || t?.net || null;
    edit((bb) => addTrackPath(bb, routePath(last, at, bb.settings.angleMode, st.diagonalFirst), st.layer, bb.settings.trackWidth, net), '配線');
    if (t && t.key !== st.route.startKey) st.route = { pts: [], net: null };
    else st.route = { ...st.route, net, pts: [...st.route.pts, at] };
    render();
  }

  /** 作業層を次へ（表 → 内層1 → … → 裏 → 表） */
  function nextLayer() {
    const cu = copperLayers(pcb());
    return cu[(cu.indexOf(st.layer) + 1) % cu.length];
  }

  async function routeVia() {
    const last = st.route.pts[st.route.pts.length - 1];
    if (!last) return;
    const cu = copperLayers(pcb()).filter((l) => l !== st.layer);
    let to = cu.length === 1 ? cu[0] : null;
    if (!to) {
      // 4・6層: 移る層を選ぶ（ビアは全層を貫通）
      to = await ctx.ui.ask('ビアで移る層', cu.map((l) => `<button type="button" class="btn list-btn" data-key="${l}">${esc(layerName(l))}（${l}）</button>`).join(''), [{ label: 'キャンセル', value: '' }], true);
      if (!to) return;
    }
    edit((b) => addVia(b, last.x, last.y, st.route.net), 'ビア');
    st.layer = to;
    ctx.ui.toast(`ビアを置いて${layerName(to)}に移りました`);
    render();
  }

  async function pickWidth() {
    const btns = WIDTHS.map((w) => `<button type="button" class="btn list-btn" data-key="${w}">${w} mm</button>`).join('');
    const r = await ctx.ui.ask('配線幅', `<p class="note">設計ルールの最小配線幅は ${drcRules(ctx.getProject()).minTrackWidthMm}mm です（DRCで検査）。電源・GNDは太めに。</p>${btns}`, [{ label: '閉じる', value: '' }], true);
    if (r) edit((b) => { b.settings.trackWidth = toNm(Number(r)); }, '配線幅');
  }

  // ---------------- その他のツール ----------------
  function netNames() {
    const s = new Set();
    for (const f of pcb().footprints) Object.values(f.padNets || {}).forEach((n) => s.add(n));
    return [...s].sort((a, b) => (b === 'GND') - (a === 'GND') || a.localeCompare(b));
  }

  async function zoneDialog() {
    const nets = netNames();
    if (!nets.length) { ctx.ui.toast('先にネットリストを読み込んでください', true); return; }
    const html = `<label class="field"><span>ネット</span><select name="net">${nets.map((n) => `<option ${n === 'GND' ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label class="field"><span>層</span><select name="layer">${copperLayers(pcb()).map((l) => `<option value="${l}" ${st.layer === l ? 'selected' : ''}>${esc(layerName(l))} (${l})</option>`).join('')}<option value="both">表と裏</option></select></label>
      <p class="note">基板外形から縁のクリアランス分内側に作り、別ネットの銅・取付穴の周りを抜いて塗ります（同ネットのパッドはサーマルでつなぐ）。4・6層では内層を GND・電源の面にするのが一般的です。</p>`;
    const r = await ctx.ui.ask('ベタ（GNDポリゴン）', `<div class="form">${html}</div>`, [{ label: 'キャンセル', value: '' }, { label: '作成', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    const net = $('#dialog-body [name="net"]').value, layer = $('#dialog-body [name="layer"]').value;
    const edge = drcRules(ctx.getProject()).boardEdgeClearanceMm;
    edit((b) => { for (const l of layer === 'both' ? ['F.Cu', 'B.Cu'] : [layer]) addBoardZone(b, l, net, Math.max(0.5, edge)); }, 'ベタ');
    ctx.ui.toast(`${net} のベタを作成しました`);
    render();
  }

  async function outlineDialog() {
    const o = pcb().outline;
    const r = await ctx.ui.ask('基板外形（長方形）', `<div class="form">
      <label class="field"><span>幅 (mm)</span><input type="text" name="w" inputmode="decimal" value="${toMm(o.w)}"></label>
      <label class="field"><span>高さ (mm)</span><input type="text" name="h" inputmode="decimal" value="${toMm(o.h)}"></label>
      <p class="note">左上が原点 (0,0) です。層数・板厚・色などの製造仕様は「出力」タブで設定します。</p></div>`,
    [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    const w = Number($('#dialog-body [name="w"]').value), h = Number($('#dialog-body [name="h"]').value);
    if (!(w >= 5 && w <= 500 && h >= 5 && h <= 500)) { ctx.ui.toast('幅・高さは 5〜500mm で入力してください', true); return; }
    edit((b) => setOutlineRect(b, w, h), '基板外形');
    ctx.ui.toast(`基板サイズ ${boardSizeText(pcb())}`);
    render();
  }

  async function holeAt(at) {
    const r = await ctx.ui.prompt('取付穴の直径 (mm)', '3.2');
    if (r === null) return;
    const d = Number(r);
    if (!(d >= 0.5 && d <= 10)) { ctx.ui.toast('直径は 0.5〜10mm で入力してください', true); return; }
    edit((b) => addHole(b, at.x, at.y, d), '取付穴');
    render();
  }

  async function textAt(at) {
    const r = await ctx.ui.prompt(`シルク文字（${st.layer === 'F.Cu' ? '表' : '裏'}）`, '');
    if (!r || !r.trim()) return;
    edit((b) => addText(b, at.x, at.y, r.trim(), st.layer === 'F.Cu' ? 'F.SilkS' : 'B.SilkS', 1), '文字');
    render();
  }

  // ---------------- ネットリスト読込 ----------------
  async function importFromSchematic() {
    const nl = await ctx.getNetlist();
    if (!nl) return;
    if (nl.summary.errors) {
      const go = await ctx.ui.ask('ネットリストにエラーがあります', `<p>エラー ${nl.summary.errors}件。メニュー →「ネットリスト」で内容を確認できます。このまま読み込みますか？</p>`, [{ label: 'やめる', value: '' }, { label: '読み込む', value: 'ok' }]);
      if (go !== 'ok') return;
    }
    let rep;
    edit((b) => { rep = importNetlist(b, nl, ctx.resolveFp); }, 'ネットリスト読込');
    const msg = [`追加 ${rep.added.length}`, `更新 ${rep.updated.length}`, `削除 ${rep.removed.length}`].join('・');
    if (rep.noFootprint.length) ctx.ui.toast(`${msg}。フットプリントが無く置けない部品: ${rep.noFootprint.join(', ')}`, true);
    else ctx.ui.toast(`ネットリストを読み込みました（${msg}）`);
    if (rep.added.length) ctx.fitAll?.();
    render();
  }

  // ---------------- 属性 ----------------
  async function editProps() {
    if (st.sel.size !== 1) return;
    const key = [...st.sel][0];
    const o = findItem(pcb(), key);
    if (!o) return;
    const f = (name, label, val, attrs = 'inputmode="decimal"') => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(val)}" ${attrs}></label>`;
    let html = '', title = '';
    const k = key[0];
    if (k === 'f') {
      title = `${o.ref}（${o.fpDef.name}）`;
      html = f('x', 'X (mm)', toMm(o.x)) + f('y', 'Y (mm)', toMm(o.y)) + f('rot', '回転 (°)', o.rot || 0) +
        `<label class="field"><span>実装面</span><select name="side"><option value="top" ${o.side !== 'bottom' ? 'selected' : ''}>表</option><option value="bottom" ${o.side === 'bottom' ? 'selected' : ''}>裏</option></select></label>` +
        `<label class="field check"><input type="checkbox" name="locked" ${o.locked ? 'checked' : ''}> 位置をロック</label>` +
        `<p class="note">値: ${esc(o.value)}${o.lcsc ? `・LCSC ${esc(o.lcsc)}` : ''}${o.fpDef.generated ? '・フットプリントは推定（要確認）' : ''}</p>`;
    } else if (k === 't') {
      title = `配線（${o.net || 'ネットなし'}）`;
      html = f('width', '幅 (mm)', toMm(o.width)) + `<label class="field"><span>層</span><select name="layer">${copperLayers(pcb()).map((l) => `<option value="${l}" ${o.layer === l ? 'selected' : ''}>${esc(layerName(l))}</option>`).join('')}</select></label>`;
    } else if (k === 'v') {
      title = `ビア（${o.net || 'ネットなし'}）`;
      html = f('diameter', '外径 (mm)', toMm(o.diameter)) + f('drill', '穴径 (mm)', toMm(o.drill));
    } else if (k === 'x') {
      title = 'シルク文字';
      html = f('text', '文字', o.text, '') + f('size', '文字高さ (mm)', toMm(o.size)) + f('rot', '回転 (°)', o.rot || 0);
    } else if (k === 'h') {
      title = '取付穴';
      html = f('drill', '直径 (mm)', toMm(o.drill));
    } else if (k === 'z') {
      title = `ベタ（${o.net}・${o.layer === 'F.Cu' ? '表' : '裏'}）`;
      html = f('clearance', '他ネットとのクリアランス (mm)', toMm(o.clearance));
    }
    const r = await ctx.ui.ask(title, `<div class="form">${html}</div>`, [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    const v = (n) => $(`#dialog-body [name="${n}"]`);
    const num = (n, min, max) => { const x = Number(v(n).value); if (!Number.isFinite(x) || x < min || x > max) throw new Error(`${n} の値が範囲外です`); return x; };
    try {
      edit((b) => {
        const x = findItem(b, key);
        if (k === 'f') { x.x = toNm(num('x', -1000, 1000)); x.y = toNm(num('y', -1000, 1000)); x.rot = ((num('rot', -360, 360) % 360) + 360) % 360; x.side = v('side').value; x.locked = v('locked').checked; }
        if (k === 't') { x.width = toNm(num('width', 0.05, 10)); x.layer = v('layer').value; }
        if (k === 'v') { const d = num('diameter', 0.2, 5), h = num('drill', 0.1, 4); if (h >= d) throw new Error('穴径は外径より小さくしてください'); x.diameter = toNm(d); x.drill = toNm(h); }
        if (k === 'x') { x.text = v('text').value; x.size = toNm(num('size', 0.3, 10)); x.rot = ((num('rot', -360, 360) % 360) + 360) % 360; }
        if (k === 'h') x.drill = toNm(num('drill', 0.3, 10));
        if (k === 'z') x.clearance = toNm(num('clearance', 0.1, 5));
      }, '属性');
    } catch (e) { ctx.ui.toast(e.message, true); }
    render();
  }

  function onKey(e) {
    if (!ctx.isActive() || e.target.closest('input, textarea, dialog, select')) return;
    const key = e.key.toLowerCase();
    if (key === 'escape') { st.route = { pts: [], net: null }; st.drag = null; if (st.tool !== 'select') setTool('select'); else setSel(new Set()); }
    else if (key === 'r') action('rotate');
    else if (key === 'f') action('flip');
    else if (key === 'delete' || key === 'backspace') action('delete');
    else if (key === 'x') setTool('route');
    else if (key === 'v') { if (st.tool === 'route' && st.route.pts.length) { routeVia(); render(); } else setTool('via'); }
    else if (key === 'l') { st.layer = nextLayer(); render(); }
    else if (key === 'e' && st.sel.size === 1) editProps();
    else return;
    e.preventDefault();
  }

  $('#ctxbar').addEventListener('click', (e) => { if (!ctx.isActive()) return; const a = e.target.closest('[data-pctx]')?.dataset.pctx; if (a) onCtx(a); });
  ctx.svg.addEventListener('pointerleave', () => { if (ctx.isActive() && st.hover) { st.hover = null; render(); } });
  document.addEventListener('keydown', onKey);

  return {
    state: st,
    vp: ctx.vp,
    gestures: {
      onChange: ctx.onViewChange, onTap, onLongPress, onDragStart, onDragMove, onDragEnd, onDragCancel,
      onHover: (p) => { if (st.tool !== 'select') { st.hover = p; render(); } },
    },
    render, setTool, action, editProps, importFromSchematic,
    resetForProject() { st.sel = new Set(); st.route = { pts: [], net: null }; st.drag = null; st.tool = 'select'; st.layer = 'F.Cu'; },
    /** 最新の接続（ベタも塗り直す） */
    connectivity: () => computePcbConnectivity(pcb(), { rules: drcRules(ctx.getProject()) }),
    /** 画面に出ている接続（ベタは塗り直し待ちのことがある。サイドパネル用） */
    lastConnectivity: () => st.conn || computePcbConnectivity(pcb(), { rules: drcRules(ctx.getProject()), allowStaleFill: true }),
    selectionInfo: () => [...st.sel].map((k) => ({ key: k, item: findItem(pcb(), k) })),
  };
}
