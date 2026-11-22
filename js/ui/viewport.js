// キャンバスの表示変換（パン・ズーム）とジェスチャー判定。
// 1本指: パン（第2段階で「選択ツール時は選択、空白ドラッグでパン」に拡張）
// 2本指: ピンチズーム＋パン。2本目が触れた瞬間に1本指操作をキャンセルし、誤選択を防ぐ。
// マウスホイール: カーソル位置を中心にズーム。

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
 * Pointer Events でパン/ピンチを処理する。
 * onTap(worldPoint) は「動かさずに離した1本指」でだけ呼ぶ（ズーム操作と区別）。
 */
export function attachGestures(el, vp, { onChange = () => {}, onTap = () => {}, tapSlop = 8 } = {}) {
  const pts = new Map();
  let mode = 'idle'; // idle | maybeTap | pan | pinch
  let start = null;
  let pinch = null;

  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) {
      mode = 'maybeTap';
      start = local(e);
    } else if (pts.size === 2) {
      mode = 'pinch'; // 1本指の操作（タップ/パン）はここで破棄
      const [a, b] = [...pts.values()];
      pinch = { dist: dist(a, b), mid: mid(a, b) };
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const cur = local(e);
    pts.set(e.pointerId, cur);
    if (mode === 'maybeTap' && dist(cur, start) > tapSlop) mode = 'pan';
    if (mode === 'pan' && pts.size === 1) {
      vp.panBy(cur.x - prev.x, cur.y - prev.y);
      onChange();
    } else if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b), m = mid(a, b);
      if (pinch.dist > 0) vp.zoomAt(m.x, m.y, d / pinch.dist);
      vp.panBy(m.x - pinch.mid.x, m.y - pinch.mid.y);
      pinch = { dist: d, mid: m };
      onChange();
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (mode === 'maybeTap' && pts.size === 0 && e.type === 'pointerup') {
      onTap(vp.screenToWorld(p.x, p.y));
    }
    if (pts.size === 0) mode = 'idle';
    else if (pts.size === 1 && mode === 'pinch') mode = 'pinchEnding'; // 指を1本離しても残りでパンしない
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    vp.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    onChange();
  }, { passive: false });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
