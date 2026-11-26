// 回路図の SVG 描画（文字列生成。DOM 操作は呼び出し側）
import { xform, svgTransform, xformRect } from './geom.js';
import { getSymbol, kindInfo } from './symbols.js';
import { sourceShort } from '../sim/waveform.js';
import { labelRect } from './model.js';
import { esc } from '../core/util.js';


function prim(g) {
  switch (g.t) {
    case 'line': return `<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}"/>`;
    case 'rect': return `<rect x="${g.x0}" y="${g.y0}" width="${g.x1 - g.x0}" height="${g.y1 - g.y0}"${g.fill ? ' class="fill"' : ''}/>`;
    case 'circle': return `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}"${g.fill ? ' class="fill"' : ''}/>`;
    case 'path': return `<path d="${g.d}"${g.fill ? ' class="fill"' : ''}/>`;
    default: return '';
  }
}

/** シンボル内の文字（+,−,ピン名など）は回転させず正立で置く */
function symText(g, comp) {
  const p = xform({ x: g.x, y: g.y }, comp);
  let anchor = g.anchor;
  if (anchor !== 'middle') {
    // 左右反転・回転で向きが変わる場合は揃え方向を入れ替える
    const dir = xform({ x: g.x + (anchor === 'start' ? 1 : -1), y: g.y }, comp);
    const dx = dir.x - p.x, dy = dir.y - p.y;
    if (Math.abs(dx) >= Math.abs(dy)) anchor = dx > 0 ? 'start' : 'end';
    // 縦向き: 下から上へ読む向きに回す（-90°で文字の進行方向が画面上向き）
    else return `<text x="${p.x}" y="${p.y}" font-size="${g.size}" text-anchor="${dy < 0 ? 'start' : 'end'}" transform="rotate(-90 ${p.x} ${p.y})">${esc(g.text)}</text>`;
  }
  return `<text x="${p.x}" y="${p.y}" font-size="${g.size}" text-anchor="${anchor}">${esc(g.text)}</text>`;
}

/** 部品番号・値の配置: 横長なら上下、縦長なら右側 */
function fieldText(c, sym) {
  if (sym.isPower) return '';
  const r = xformRect(sym.bbox, c);
  // シミュ用の信号源は SPICE の文でなく「100V 50Hz」のように短く
  const val = kindInfo(c.kind)?.virtual ? sourceShort(c.props?.value, c.kind) : c.props?.value ?? '';
  const dnp = c.props?.dnp ? ' (DNP)' : '';
  // ピン番号を描く部品（IC・コネクタ等）は側面がピンで埋まるので、常に上下に置く
  if (sym.showPinNumbers || r.x1 - r.x0 >= r.y1 - r.y0) {
    const cx = (r.x0 + r.x1) / 2;
    return `<text class="ref" x="${cx}" y="${r.y0 - 0.5}" text-anchor="middle">${esc(c.ref)}${dnp}</text>` +
      `<text class="val" x="${cx}" y="${r.y1 + 1.5}" text-anchor="middle">${esc(val)}</text>`;
  }
  const cy = (r.y0 + r.y1) / 2;
  return `<text class="ref" x="${r.x1 + 0.6}" y="${cy - 0.3}">${esc(c.ref)}${dnp}</text>` +
    `<text class="val" x="${r.x1 + 0.6}" y="${cy + 1.3}">${esc(val)}</text>`;
}

function pinNumbers(c, sym) {
  if (!sym.showPinNumbers) return '';
  return sym.pins.map((p) => {
    // ピン線の中ほどに番号
    const inner = { x: p.x + Math.sign(-p.x) * (Math.abs(p.x) > Math.abs(p.y) ? 1 : 0), y: p.y + Math.sign(-p.y) * (Math.abs(p.y) > Math.abs(p.x) ? 1 : 0) };
    const q = xform(inner, c);
    return `<text class="pinnum" x="${q.x}" y="${q.y - 0.25}" text-anchor="middle">${esc(p.num)}</text>`;
  }).join('');
}

export function renderComponent(c, selected = false) {
  const sym = getSymbol(c);
  return `<g class="comp${selected ? ' sel' : ''}${c.props?.dnp ? ' dnp' : ''}" data-key="c:${c.id}">` +
    `<g class="sym" transform="${svgTransform(c)}">${sym.graphics.filter((g) => g.t !== 'text').map(prim).join('')}</g>` +
    sym.graphics.filter((g) => g.t === 'text').map((g) => symText(g, c)).join('') +
    pinNumbers(c, sym) + fieldText(c, sym) + '</g>';
}

export function renderLabel(l, selected = false) {
  const r = labelRect(l);
  const t = l.rot % 180 === 0
    ? `<text x="${l.x + 0.5}" y="${l.y - 0.4}">${esc(l.name)}</text>`
    : `<text x="${l.x - 0.4}" y="${l.y - 0.5}" transform="rotate(-90 ${l.x - 0.4} ${l.y - 0.5})">${esc(l.name)}</text>`;
  return `<g class="label${selected ? ' sel' : ''}" data-key="l:${l.id}"><rect class="hit" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>` +
    `<path d="M${l.x - 0.4} ${l.y}h0.8M${l.x} ${l.y - 0.4}v0.8"/>${t}</g>`;
}

/**
 * シート全体の SVG 文字列
 * @param sheet シート
 * @param opt {selection:Set, conn:connectivityの結果, preview:{wire:[pts], rect:{a,b}, ghost:comp}}
 */
export function renderSheet(sheet, { selection = new Set(), conn = null, preview = {} } = {}) {
  const out = [];
  out.push('<g class="wires">');
  for (const w of sheet.wires) {
    out.push(`<line class="wire${selection.has(`w:${w.id}`) ? ' sel' : ''}" data-key="w:${w.id}" x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}"/>`);
  }
  out.push('</g><g class="comps">');
  for (const c of sheet.components) out.push(renderComponent(c, selection.has(`c:${c.id}`)));
  out.push('</g><g class="labels">');
  for (const l of sheet.labels) out.push(renderLabel(l, selection.has(`l:${l.id}`)));
  out.push('</g>');
  if (conn) {
    out.push('<g class="junctions">');
    for (const j of conn.junctions) out.push(`<circle class="junction" cx="${j.x}" cy="${j.y}" r="0.45"/>`);
    out.push('</g><g class="ncpins">');
    for (const p of conn.unconnectedPins) out.push(`<circle class="nc" cx="${p.x}" cy="${p.y}" r="0.35"/>`);
    out.push('</g>');
  }
  if (preview.ghost) out.push(`<g class="ghost">${renderComponent(preview.ghost)}</g>`);
  if (preview.wire && preview.wire.length > 1) {
    out.push(`<polyline class="wire-preview" points="${preview.wire.map((p) => `${p.x},${p.y}`).join(' ')}"/>`);
  }
  if (preview.wireStart) out.push(`<circle class="wire-start" cx="${preview.wireStart.x}" cy="${preview.wireStart.y}" r="0.5"/>`);
  if (preview.rect) {
    const { a, b } = preview.rect;
    out.push(`<rect class="box-select" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}"/>`);
  }
  if (preview.cursor) out.push(`<path class="cursor" d="M${preview.cursor.x - 1} ${preview.cursor.y}h2M${preview.cursor.x} ${preview.cursor.y - 1}v2"/>`);
  return out.join('');
}

/** 部品一覧に出す小さなプレビュー SVG */
export function symbolPreviewSVG(kind, props) {
  const c = { id: 'pv', kind, ref: '', x: 0, y: 0, rot: 0, mirror: false, props: props || {} };
  const sym = getSymbol(c);
  const b = sym.bbox, pad = 1;
  const vb = `${b.x0 - pad} ${b.y0 - pad} ${b.x1 - b.x0 + pad * 2} ${b.y1 - b.y0 + pad * 2}`;
  return `<svg class="sym-preview" viewBox="${vb}"><g class="sym">${sym.graphics.filter((g) => g.t !== 'text').map(prim).join('')}</g>${sym.graphics.filter((g) => g.t === 'text').map((g) => symText(g, c)).join('')}</svg>`;
}
