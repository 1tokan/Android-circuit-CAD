// PCB の SVG 描画（単位 mm）
import { toMm, boardRect } from './model.js';
import { silkSegments, pin1Mark, silkTexts } from './shapes.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mm = (q) => ({ x: toMm(q.x), y: toMm(q.y) });

function padShape(p, cls) {
  const rx = p.shape === 'circle' || p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : p.shape === 'roundrect' ? Math.min(p.w, p.h) * 0.25 : 0;
  return `<rect class="${cls}" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${rx}"/>`;
}

function fpTransform(f) {
  return `translate(${toMm(f.x)} ${toMm(f.y)}) rotate(${f.rot || 0})${f.side === 'bottom' ? ' scale(-1 1)' : ''}`;
}

/** フットプリント1個（指定した面の要素だけ） */
function footprintLayer(f, layer, selected) {
  const side = f.side === 'bottom' ? 'B' : 'F';
  const out = [];
  if (layer === 'Cu') {
    for (const p of f.fpDef.pads) {
      const cls = p.type === 'tht' ? 'pad tht' : `pad ${side === 'F' ? 'fcu' : 'bcu'}`;
      out.push(padShape(p, cls));
      if (p.type === 'tht') out.push(`<circle class="drill" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}"/>`);
    }
  } else if (layer === 'Silk') {
    // 本体の外形線はパッドの周囲で切ってある（パッドにシルクを載せない）
    const segs = silkSegments(f.fpDef);
    if (segs.length) out.push(`<path class="silk" d="${segs.map((q) => `M${q.a.x} ${q.a.y}L${q.b.x} ${q.b.y}`).join('')}"/>`);
    const m = pin1Mark(f.fpDef);
    if (m) out.push(`<circle class="silk-dot" cx="${m.x}" cy="${m.y}" r="0.2"/>`);
  }
  return `<g class="fp ${side === 'B' ? 'bottom' : 'top'}${selected ? ' sel' : ''}" transform="${fpTransform(f)}">${out.join('')}</g>`;
}

/**
 * @param opt { selection:Set, conn, activeLayer, show:{ratsnest, fcu, bcu, silk}, preview:{route:[pts], layer, width, rect:{a,b}, cursor} }
 */
export function renderPcb(pcb, { selection = new Set(), conn = null, activeLayer = 'F.Cu', show = {}, preview = {} } = {}) {
  const S = { ratsnest: true, fcu: true, bcu: true, silk: true, ...show };
  const out = [];
  const r = boardRect(pcb);
  // 基板（背景と外形）
  out.push(`<rect class="board" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>`);
  const layerGroup = (cu, isActive) => {
    const g = [];
    for (const z of pcb.zones.filter((z) => z.layer === cu)) {
      const cls = `${cu === 'F.Cu' ? 'fcu' : 'bcu'}${selection.has(`z:${z.id}`) ? ' sel' : ''}`;
      const f = conn?.fills?.get(z.id);
      if (f) g.push(`<path class="zone-fill ${cls}${conn.fillStale ? ' stale' : ''}" fill-rule="evenodd" d="${f.polygons.map((poly) => poly.map((ring) => 'M' + ring.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('')).join('')}"/>`);
      g.push(`<polygon class="zone ${cls}${f ? ' outline-only' : ''}" points="${z.polygon.map((q) => `${toMm(q.x)},${toMm(q.y)}`).join(' ')}"/>`);
    }
    for (const t of pcb.tracks.filter((t) => t.layer === cu)) {
      const a = mm(t.a), b = mm(t.b);
      g.push(`<line class="track ${cu === 'F.Cu' ? 'fcu' : 'bcu'}${selection.has(`t:${t.id}`) ? ' sel' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${toMm(t.width)}"/>`);
    }
    return `<g class="cu-layer${isActive ? ' active' : ''}">${g.join('')}</g>`;
  };
  // 作業層を上に描く
  const order = activeLayer === 'B.Cu' ? ['F.Cu', 'B.Cu'] : ['B.Cu', 'F.Cu'];
  for (const cu of order) if ((cu === 'F.Cu' && S.fcu) || (cu === 'B.Cu' && S.bcu)) out.push(layerGroup(cu, cu === activeLayer));
  // パッド（面の違うものを先に）
  const fps = [...pcb.footprints].sort((a, b) => ((a.side === 'bottom') === (activeLayer === 'B.Cu') ? 1 : 0) - ((b.side === 'bottom') === (activeLayer === 'B.Cu') ? 1 : 0));
  out.push('<g class="pads">' + fps.map((f) => footprintLayer(f, 'Cu', selection.has(`f:${f.id}`))).join('') + '</g>');
  // ビア・穴
  out.push('<g class="vias">' + pcb.vias.map((v) => `<circle class="via${selection.has(`v:${v.id}`) ? ' sel' : ''}" cx="${toMm(v.x)}" cy="${toMm(v.y)}" r="${toMm(v.diameter) / 2}"/><circle class="drill" cx="${toMm(v.x)}" cy="${toMm(v.y)}" r="${toMm(v.drill) / 2}"/>`).join('') + '</g>');
  out.push('<g class="holes">' + pcb.holes.map((h) => `<circle class="hole${selection.has(`h:${h.id}`) ? ' sel' : ''}" cx="${toMm(h.x)}" cy="${toMm(h.y)}" r="${toMm(h.drill) / 2}"/>`).join('') + '</g>');
  // シルク
  if (S.silk) {
    out.push('<g class="silk-layer">' + fps.map((f) => footprintLayer(f, 'Silk', selection.has(`f:${f.id}`))).join(''));
    // 文字は Gerber と同じストロークフォントで描く（見たとおりに製造される）
    for (const t of silkTexts(pcb)) {
      const sel = selection.has(t.kind === 'refdes' ? `f:${t.id}` : `x:${t.id}`);
      const d = t.strokes.map((st) => 'M' + st.map((p) => `${+p.x.toFixed(4)} ${+p.y.toFixed(4)}`).join('L')).join('');
      out.push(`<path class="silk-stroke ${t.layer === 'B.SilkS' ? 'bottom' : ''}${sel ? ' sel' : ''}" stroke-width="${t.width}" d="${d}"/>`);
    }
    out.push('</g>');
  }
  out.push(`<rect class="edge" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>`);
  // ラッツネスト
  if (S.ratsnest && conn) {
    out.push('<g class="ratsnest">' + conn.ratsnest.map((l) => `<line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}"/>`).join('') + '</g>');
  }
  // プレビュー
  if (preview.route && preview.route.length > 1) {
    out.push(`<polyline class="route-preview ${preview.layer === 'B.Cu' ? 'bcu' : 'fcu'}" points="${preview.route.map((p) => `${p.x},${p.y}`).join(' ')}" stroke-width="${preview.width}"/>`);
  }
  if (preview.routeStart) out.push(`<circle class="route-start" cx="${preview.routeStart.x}" cy="${preview.routeStart.y}" r="0.25"/>`);
  if (preview.rect) {
    const { a, b } = preview.rect;
    out.push(`<rect class="box-select" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}"/>`);
  }
  if (preview.cursor) out.push(`<path class="cursor" d="M${preview.cursor.x - 0.6} ${preview.cursor.y}h1.2M${preview.cursor.x} ${preview.cursor.y - 0.6}v1.2"/>`);
  return out.join('');
}
