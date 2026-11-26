// グラフ（SVG）・FFT・測定値
import { formatValue } from './units.js';

export const COLORS = ['#2a7de1', '#e1572a', '#2aa84a', '#a83cc8', '#d4a017', '#17a2b8', '#c8325a', '#6b7a2a'];

/** きりのよい目盛り */
export function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; }
  const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, lo: Math.min(lo, out[0] ?? lo), hi: Math.max(hi, out[out.length - 1] ?? hi) };
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(Math.pow(10, e));
  return out.filter((v) => v >= lo * 0.999 && v <= hi * 1.001);
}

/**
 * @param o { traces: [{ name, x, y, color, right?: true, dash? }], xLog, xUnit, yUnit, y2Unit, xRange: [a, b], cursor, cursor2, width, height, id, showX }
 *  - カーソル A・B はいつも要素を置く（無いときは隠す）。ドラッグ中は moveCursor で位置だけ動かす
 *  - id: 1 画面に複数のグラフを並べるときの clipPath の名前
 * @returns { svg, map }
 */
export function plotSvg(o) {
  const W = o.width || 360, H = o.height || 220, L = 52, R = o.traces.some((t) => t.right) ? 46 : 12, T = 18, B = o.showX === false ? 8 : 28;
  const pw = W - L - R, ph = H - T - B;
  const all = o.traces.flatMap((t) => t.x);
  let x0 = o.xRange ? o.xRange[0] : Math.min(...all), x1 = o.xRange ? o.xRange[1] : Math.max(...all);
  if (!(x1 > x0)) x1 = x0 + 1;
  const inX = (x) => x >= x0 && x <= x1;
  const yr = (right) => {
    const ys = o.traces.filter((t) => !!t.right === right).flatMap((t) => t.y.filter((_, i) => inX(t.x[i]))).filter(Number.isFinite);
    if (!ys.length) return null;
    return niceTicks(Math.min(...ys), Math.max(...ys));
  };
  const yl = yr(false), y2 = yr(true);
  const lx = (x) => (o.xLog ? Math.log10(Math.max(x, 1e-30)) : x);
  const sx = (x) => L + ((lx(x) - lx(x0)) / (lx(x1) - lx(x0))) * pw;
  const syOf = (r) => (y) => T + ph - ((y - r.lo) / (r.hi - r.lo || 1)) * ph;
  const out = [`<svg class="sim-plot" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`];
  out.push(`<rect x="${L}" y="${T}" width="${pw}" height="${ph}" class="plot-bg"/>`);
  // 目盛り
  const xt = o.xLog ? logTicks(x0, x1) : niceTicks(x0, x1, 5).ticks.filter(inX);
  for (const v of xt) { const X = sx(v); out.push(`<line x1="${X}" y1="${T}" x2="${X}" y2="${T + ph}" class="plot-grid"/>${o.showX === false ? '' : `<text x="${X}" y="${H - 10}" class="plot-tick" text-anchor="middle">${formatValue(v, '', 3)}</text>`}`); }
  if (yl) { const sy = syOf(yl); for (const v of yl.ticks) { const Y = sy(v); out.push(`<line x1="${L}" y1="${Y}" x2="${L + pw}" y2="${Y}" class="plot-grid"/><text x="${L - 4}" y="${Y + 3}" class="plot-tick" text-anchor="end">${formatValue(v, '', 3)}</text>`); } }
  if (y2) { const sy = syOf(y2); for (const v of y2.ticks) out.push(`<text x="${L + pw + 4}" y="${sy(v) + 3}" class="plot-tick">${formatValue(v, '', 3)}</text>`); }
  if (o.showX !== false) out.push(`<text x="${L + pw}" y="${H - 1}" class="plot-unit" text-anchor="end">${o.xUnit || ''}</text>`);
  if (o.yUnit) out.push(`<text x="2" y="${T - 6}" class="plot-unit">${o.yUnit}</text>`);
  if (o.y2Unit && y2) out.push(`<text x="${W - 2}" y="${T + 8}" class="plot-unit" text-anchor="end">${o.y2Unit}</text>`);
  // 線（多いときは画面の 1 ドットに 1 点まで間引く。最大・最小は残す）
  const cid = `pc-${o.id || 'p'}`;
  out.push(`<clipPath id="${cid}"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath><g clip-path="url(#${cid})">`);
  o.traces.forEach((t, k) => {
    const r = t.right ? y2 : yl;
    if (!r) return;
    const sy = syOf(r);
    const pts = decimate(t.x, t.y, sx, x0, x1, pw);
    const d = pts.map(([X, y], i) => `${i ? 'L' : 'M'}${X.toFixed(1)} ${sy(y).toFixed(1)}`).join('');
    out.push(`<path d="${d}" fill="none" stroke="${t.color || COLORS[k % COLORS.length]}" stroke-width="1.6"${t.dash ? ' stroke-dasharray="4 3"' : ''}/>`);
  });
  out.push('</g>');
  const map = { L, pw, x0, x1, log: !!o.xLog, W };
  // カーソル（つまみ付き。つまみの文字 A・B）
  for (const [x, cls, label] of [[o.cursor, 'a', 'A'], [o.cursor2, 'b', 'B']]) {
    const vis = x != null && inX(x);
    out.push(`<g class="plot-cur ${cls}" data-cur="${cls}" transform="translate(${vis ? plotPxAt(map, x).toFixed(1) : -99},0)"${vis ? '' : ' style="display:none"'}><line x1="0" y1="${T}" x2="0" y2="${T + ph}" class="plot-cursor ${cls}"/><rect x="-8" y="${T - 15}" width="16" height="14" rx="3" class="plot-cur-tab"/><text x="0" y="${T - 4}" text-anchor="middle" class="plot-cur-label">${label}</text></g>`);
  }
  out.push('</svg>');
  return { svg: out.join(''), map };
}

function decimate(xs, ys, sx, x0, x1, pw) {
  const out = [];
  let col = null, mn = null, mx = null;
  const flush = () => { if (col == null) return; if (mn[1] === mx[1]) out.push(mn); else if (mn[0] <= mx[0]) out.push(mn, mx); else out.push(mx, mn); };
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(ys[i])) continue;
    if (xs[i] < x0 && !(xs[i + 1] >= x0)) continue;
    if (xs[i] > x1 && !(xs[i - 1] <= x1)) continue;
    const X = sx(xs[i]), c = Math.round(X * 2);
    if (c !== col) { flush(); col = c; mn = [X, ys[i]]; mx = [X, ys[i]]; }
    else { if (ys[i] < mn[1]) mn = [X, ys[i]]; if (ys[i] > mx[1]) mx = [X, ys[i]]; }
  }
  flush();
  return out;
}

/** データの x → 画面の x（px。viewBox の座標） */
export function plotPxAt(map, x) {
  const lx = (v) => (map.log ? Math.log10(Math.max(v, 1e-30)) : v);
  return map.L + ((lx(x) - lx(map.x0)) / (lx(map.x1) - lx(map.x0) || 1)) * map.pw;
}

/** 描いたグラフのカーソルだけを動かす（ドラッグ中。SVG を作り直さないのでポインタのつかみが切れない） */
export function moveCursor(svg, map, which, x) {
  const g = svg.querySelector(`[data-cur="${which}"]`);
  if (!g) return;
  const inX = x != null && x >= Math.min(map.x0, map.x1) && x <= Math.max(map.x0, map.x1);
  g.style.display = inX ? '' : 'none';
  if (inX) g.setAttribute('transform', `translate(${plotPxAt(map, x).toFixed(1)},0)`);
}

/** 画面の x（px）→ データの x */
export function plotXAt(map, px) {
  const f = Math.min(1, Math.max(0, (px - map.L) / map.pw));
  if (map.log) return Math.pow(10, Math.log10(map.x0) + f * (Math.log10(map.x1) - Math.log10(map.x0)));
  return map.x0 + f * (map.x1 - map.x0);
}

/** 並んだ x の中で x に最も近い位置の値（線形補間） */
export function valueAt(xs, ys, x) {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo] || 1);
}

/** 区間 [a, b] の測定値（KiCad の測定と同じ種類: 最小・最大・平均・実効値・ピークツーピーク・周波数） */
export function measure(xs, ys, a = -Infinity, b = Infinity) {
  let mn = Infinity, mx = -Infinity, area = 0, area2 = 0, span = 0;
  const ups = [];
  let mid = null;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < a || xs[i] > b) continue;
    mn = Math.min(mn, ys[i]); mx = Math.max(mx, ys[i]);
  }
  mid = (mn + mx) / 2;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1] < a || xs[i] > b) continue;
    const dt = xs[i] - xs[i - 1];
    area += ((ys[i] + ys[i - 1]) / 2) * dt; area2 += ((ys[i] * ys[i] + ys[i - 1] * ys[i - 1]) / 2) * dt; span += dt;
    if (ys[i - 1] < mid && ys[i] >= mid) ups.push(xs[i - 1] + ((mid - ys[i - 1]) / (ys[i] - ys[i - 1])) * dt);
  }
  const freq = ups.length >= 2 ? (ups.length - 1) / (ups[ups.length - 1] - ups[0]) : NaN;
  return { min: mn, max: mx, pp: mx - mn, avg: span ? area / span : NaN, rms: span ? Math.sqrt(area2 / span) : NaN, freq };
}

/**
 * 過渡の波形の FFT（等間隔に取り直し、ハン窓）
 * @returns { f, mag（振幅。正弦波の振幅がそのまま出るように窓の分を補正）, db }
 */
export function fft(xs, ys, { n = 4096, window = 'hann' } = {}) {
  const N = 1 << Math.round(Math.log2(Math.max(64, Math.min(65536, n))));
  const t0 = xs[0], t1 = xs[xs.length - 1], dt = (t1 - t0) / N;
  const re = new Float64Array(N), im = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) {
    const w = window === 'hann' ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N) : 1;
    re[i] = valueAt(xs, ys, t0 + i * dt) * w; wsum += w;
  }
  // 平均（直流）は窓の前に引かない（直流分も表示する）
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const f = [], mag = [], db = [];
  for (let k = 0; k <= N / 2; k++) {
    const a = (Math.hypot(re[k], im[k]) / wsum) * (k === 0 ? 1 : 2);
    f.push(k / (N * dt)); mag.push(a); db.push(20 * Math.log10(Math.max(a, 1e-20)));
  }
  return { f, mag, db, df: 1 / (N * dt), n: N };
}
