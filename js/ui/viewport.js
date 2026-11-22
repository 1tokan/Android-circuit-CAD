// キャンバスの表示変換（パン・ズーム）とジェスチャー判定。
// ジェスチャーの詳細は attachGestures のコメント参照。

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 40;

export class Viewport {
  constructor({ x = 0, y = 0, scale = 1 } = {}) {
    this.x = x;       // ワールド座標で表示左上
    this.y = y;
    this.scale = scale; // 1ワールド単位あたりのpx
  }
  screenToWorld(sx, sy) { return { x: this.x + sx / this.scale, y: this.y + sy / this.scale }; }
  worldToScreen(wx, wy) { return { x: (wx - this.x) * this.scale, y: (wy - this.y) * this.scale }; }

  /** スクリーン座標(sx,sy)を固定点として倍率を factor 倍 */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    this.x = before.x - sx / this.scale;
    this.y = before.y - sy / this.scale;
  }
  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
  }
  /** ワールド矩形が画面に収まるように */
  fit(rect, width, height, margin = 24) {
    const s = Math.min((width - margin * 2) / rect.w, (height - margin * 2) / rect.h);
    this.scale = clamp(s, MIN_SCALE, MAX_SCALE);
    this.x = rect.x + rect.w / 2 - width / 2 / this.scale;
    this.y = rect.y + rect.h / 2 - height / 2 / this.scale;
  }
  toJSON() { return { x: this.x, y: this.y, scale: this.scale }; }
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/**
 * Pointer Events のジェスチャー判定。
 *  - 1本指/マウスで動かさずに離す → onTap
 *  - 動かし始め → onDragStart(world, info) が true を返せばドラッグ（部品移動・範囲選択・配線）、
 *    false ならパン。マウス中ボタン・右ボタンは常にパン
 *  - タッチで長押し(450ms)してから動かす → onDragStart(..., {longPress:true})（範囲選択用）
 *    長押しして動かさずに離す → onLongPress
 *  - 2本目の指が触れたら1本指の操作をキャンセル(onDragCancel)してピンチズームに切替（誤操作防止）
 *  - マウスのボタンなし移動 → onHover
 */
export function attachGestures(el, vpOrGetter, h = {}) {
  // vp と処理は呼び出しのたびに解決する（作業領域ごとに別の表示・別のエディタへ振り分けるため）
  const vpGet = typeof vpOrGetter === 'function' ? vpOrGetter : () => vpOrGetter;
  const noop = () => {};
  const call = (name, ...a) => (typeof h[name] === 'function' ? h[name](...a) : (name === 'onDragStart' ? false : noop()));
  const H = new Proxy({}, { get: (_, name) => (...a) => call(name, ...a) });
  let vp = vpGet();
  const tapSlop = h.tapSlop ?? 8;
  const pts = new Map();
  let mode = 'idle'; // idle | maybeTap | longPressed | pan | drag | pinch | pinchEnding
  let start = null, startInfo = null, pinch = null, lpTimer = null;

  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const world = (p) => vp.screenToWorld(p.x, p.y);
  const info = (e, extra = {}) => ({ pointerType: e.pointerType, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, button: e.button, ...extra });
  const clearLP = () => { clearTimeout(lpTimer); lpTimer = null; };

  el.addEventListener('pointerdown', (e) => {
    vp = vpGet();
    el.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      start = p;
      startInfo = info(e);
      if (e.pointerType === 'mouse' && e.button !== 0) { mode = 'pan'; return; }
      mode = 'maybeTap';
      if (e.pointerType === 'touch') {
        lpTimer = setTimeout(() => {
          if (mode === 'maybeTap') { mode = 'longPressed'; navigator.vibrate?.(15); }
        }, 450);
      }
    } else if (pts.size === 2) {
      clearLP();
      if (mode === 'drag') H.onDragCancel();
      mode = 'pinch';
      const [a, b] = [...pts.values()];
      pinch = { dist: dist(a, b), mid: mid(a, b) };
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) {
      vp = vpGet();
      if (e.pointerType === 'mouse' && e.buttons === 0) H.onHover(world(local(e)), info(e));
      return;
    }
    const prev = pts.get(e.pointerId);
    const cur = local(e);
    pts.set(e.pointerId, cur);
    if ((mode === 'maybeTap' || mode === 'longPressed') && dist(cur, start) > tapSlop) {
      const lp = mode === 'longPressed';
      clearLP();
      mode = H.onDragStart(world(start), { ...startInfo, longPress: lp }) ? 'drag' : 'pan';
      if (mode === 'pan') { vp.panBy(cur.x - start.x, cur.y - start.y); H.onChange(); }
      else H.onDragMove(world(cur), info(e));
      return;
    }
    if (mode === 'drag') H.onDragMove(world(cur), info(e));
    else if (mode === 'pan' && pts.size === 1) { vp.panBy(cur.x - prev.x, cur.y - prev.y); H.onChange(); }
    else if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b), m = mid(a, b);
      if (pinch.dist > 0) vp.zoomAt(m.x, m.y, d / pinch.dist);
      vp.panBy(m.x - pinch.mid.x, m.y - pinch.mid.y);
      pinch = { dist: d, mid: m };
      H.onChange();
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    clearLP();
    const up = e.type === 'pointerup';
    if (pts.size === 0) {
      if (mode === 'maybeTap' && up) H.onTap(world(p), info(e));
      else if (mode === 'longPressed' && up) H.onLongPress(world(p), info(e));
      else if (mode === 'drag') { if (up) H.onDragEnd(world(p), info(e)); else H.onDragCancel(); }
      mode = 'idle';
    } else if (mode === 'pinch') mode = 'pinchEnding'; // 指を1本離しても残りでパンしない
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    vp = vpGet();
    const p = local(e);
    vp.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    H.onChange();
  }, { passive: false });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
