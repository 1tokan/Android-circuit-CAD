// シルク文字（ストロークフォント）。画面表示と Gerber で同じ線を使う（見たとおりに製造される）。
// 文字の大きさ size = 大文字の高さ(mm)。線幅は既定で size の 15%（KiCad と同じ考え方）。
import { HERSHEY_SIMPLEX } from '../vendor/hershey-simplex.js';

const UNITS = 21;          // フォントの字高（単位）
const SPACE = 16;          // 空白の送り幅（単位）

/** 出力できる文字か（ASCII の表示文字と空白） */
export const isPlottable = (ch) => ch === ' ' || (ch.charCodeAt(0) >= 33 && ch.charCodeAt(0) <= 126);
export function unsupportedChars(text) {
  return [...new Set([...String(text)].filter((c) => !isPlottable(c)))];
}

function glyph(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 33 && c <= 126) return HERSHEY_SIMPLEX[c - 33];
  return null;
}

/** 文字列の幅(mm)。出力できない文字は「?」として数える */
export function textWidth(text, size) {
  const k = size / UNITS;
  let w = 0;
  for (const ch of String(text)) w += ch === ' ' ? SPACE : (glyph(ch) || glyph('?'))[0];
  return w * k;
}

/**
 * 文字列のストローク（線分の折れ線の配列、mm、基板座標）
 * @param opt { x, y, size, rot(度), mirror(裏面), align: 'center'|'left', valign: 'center'|'baseline' }
 */
export function textStrokes(text, { x, y, size, rot = 0, mirror = false, align = 'center', valign = 'center' }) {
  const k = size / UNITS;
  const w = textWidth(text, size);
  let ox = align === 'center' ? -w / 2 : 0;
  // y: フォントの 1〜22 → 大文字の上端〜ベースライン
  const oy = valign === 'center' ? -size / 2 : -size;
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = [];
  for (const ch of String(text)) {
    if (ch === ' ') { ox += SPACE * k; continue; }
    const g = glyph(ch) || glyph('?');
    for (const st of g[1]) {
      const pts = [];
      for (let i = 0; i < st.length; i += 2) {
        let lx = ox + st[i] * k, ly = oy + (st[i + 1] - 1) * k;
        if (mirror) lx = -lx;
        pts.push({ x: x + lx * c - ly * s, y: y + lx * s + ly * c });
      }
      out.push(pts);
    }
    ox += g[0] * k;
  }
  return out;
}

// JLCPCB の最小線幅 0.153mm を下回らないよう 0.16mm 以上にする
export const SILK_LINE_MM = 0.16;
export const strokeWidthFor = (size) => Math.max(SILK_LINE_MM, Math.round(size * 0.15 * 1000) / 1000);
