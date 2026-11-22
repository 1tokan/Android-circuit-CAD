// 「出力」画面: 製造データ（Gerber・ドリル）の確認と書き出し
import { buildPlot, LAYERS } from './plot.js';
import { gerberFiles } from './gerber.js';
import { makeZip } from './zip.js';
import { drcStatus } from '../check/drc.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// プレビューの色（基板を上から見た色に近づける）
const PREVIEW = {
  'Edge.Cuts': { color: '#e8d34a', label: '外形' },
  'B.Cu': { color: '#3b6fd6', label: '裏銅' },
  'F.Cu': { color: '#c83a3a', label: '表銅' },
  'B.Mask': { color: '#6fa8ff', label: '裏レジスト開口' },
  'F.Mask': { color: '#ffb36b', label: '表レジスト開口' },
  'F.Paste': { color: '#b0b0b0', label: '表メタルマスク' },
  'B.Paste': { color: '#8c8c8c', label: '裏メタルマスク' },
  'B.SilkS': { color: '#a8b6ff', label: '裏シルク' },
  'F.SilkS': { color: '#f2f2f2', label: '表シルク' },
  drill: { color: '#000000', label: '穴' },
};
const ORDER = ['B.Cu', 'F.Cu', 'B.Mask', 'F.Mask', 'B.Paste', 'F.Paste', 'B.SilkS', 'F.SilkS', 'drill', 'Edge.Cuts'];

/** アパーチャ → SVG（at を原点とした相対座標） */
function apSvg(ap, at) {
  const t = `transform="translate(${at.x} ${at.y})"`;
  switch (ap.kind) {
    case 'C': return `<circle cx="${at.x}" cy="${at.y}" r="${ap.d / 2}"/>`;
    case 'R': return `<rect x="${at.x - ap.w / 2}" y="${at.y - ap.h / 2}" width="${ap.w}" height="${ap.h}"/>`;
    case 'O': { const r = Math.min(ap.w, ap.h) / 2; return `<rect x="${at.x - ap.w / 2}" y="${at.y - ap.h / 2}" width="${ap.w}" height="${ap.h}" rx="${r}"/>`; }
    case 'OutlineRect': return `<polygon ${t} points="${ap.corners.map((c) => `${c.x},${c.y}`).join(' ')}"/>`;
    case 'RoundRect': {
      const c = ap.corners;
      return `<g ${t}><polygon points="${c.map((q) => `${q.x},${q.y}`).join(' ')}" stroke-width="${ap.r * 2}" stroke-linejoin="round" class="stroke-fill"/></g>`;
    }
    case 'Oval': return `<line ${t} x1="${ap.a.x}" y1="${ap.a.y}" x2="${ap.b.x}" y2="${ap.b.y}" stroke-width="${ap.d}" stroke-linecap="round" class="stroke"/>`;
    default: return '';
  }
}

export function plotLayerSvg(prims, color) {
  const out = [];
  let path = null; // ベタ: 外周（dark）と直後の穴（clear）を1つの evenodd パスにまとめる
  const ring = (r) => 'M' + r.map(([x, y]) => `${x} ${y}`).join('L') + 'Z';
  const flush = () => { if (path) out.push(`<path fill-rule="evenodd" d="${path}"/>`); path = null; };
  for (const p of prims) {
    if (p.t === 'region') {
      if (p.dark) { flush(); path = ring(p.rings); } else if (path) path += ring(p.rings);
      continue;
    }
    flush();
    if (p.t === 'flash') out.push(apSvg(p.ap, p.at));
    else if (p.t === 'line') out.push(`<line x1="${p.a.x}" y1="${p.a.y}" x2="${p.b.x}" y2="${p.b.y}" stroke-width="${p.w}" stroke-linecap="round" class="stroke"/>`);
  }
  flush();
  return `<g fill="${color}" stroke="${color}" style="--c:${color}">${out.join('')}</g>`;
}

/**
 * @param ctx { root, getProject, getPcb, version, toast, ask, download, runDrc, fmtTime }
 */
export function createOutputView(ctx) {
  const st = { show: new Set(['Edge.Cuts', 'B.Cu', 'F.Cu', 'F.SilkS', 'drill']), tentVias: true, last: null };
  let memo = { key: null, plot: null };

  function getPlot() {
    const p = ctx.getProject(), pcb = ctx.getPcb();
    const key = JSON.stringify([p.revision, st.tentVias]);
    if (memo.key !== key) memo = { key, plot: buildPlot(p, pcb, { tentVias: st.tentVias }) };
    return memo.plot;
  }

  function preview(plot) {
    const b = plot.board;
    const pad = 1.5;
    const vb = `${b.x0 - pad} ${b.y0 - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
    const g = [];
    g.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.w}" height="${b.h}" fill="#0d3b22"/>`);
    for (const id of ORDER) {
      if (!st.show.has(id)) continue;
      if (id === 'drill') {
        g.push(`<g fill="#000">${[...plot.drills.pth, ...plot.drills.npth].map((h) => `<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}"/>`).join('')}</g>`);
        continue;
      }
      g.push(`<g class="pl ${id.replace('.', '-')}" opacity="${/Mask/.test(id) ? 0.55 : 0.9}">${plotLayerSvg(plot.layers[id], PREVIEW[id].color)}</g>`);
    }
    return `<svg class="plot-preview" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="製造データのプレビュー">${g.join('')}</svg>`;
  }

  function render() {
    const p = ctx.getProject();
    if (!p) { ctx.root.innerHTML = ''; return; }
    const pcb = ctx.getPcb();
    const plot = getPlot();
    const ds = drcStatus(p, pcb), dr = p.checks?.drc;
    const drcLine = ds === 'none' ? '<span class="warn">DRC 未実行</span>'
      : ds === 'stale' ? '<span class="warn">DRC は変更前の結果です</span>'
      : dr.summary.errors ? `<span class="err">DRC エラー ${dr.summary.errors} 件</span>` : '<span class="ok">DRC エラーなし</span>';
    const holes = plot.drills.pth.length + plot.drills.npth.length;
    const minDrill = Math.min(...[...plot.drills.pth, ...plot.drills.npth].map((h) => h.d), Infinity);
    const minTrack = Math.min(...pcb.tracks.map((t) => t.width / 1e6), Infinity);
    const chips = ORDER.map((id) => `<button class="chip${st.show.has(id) ? ' on' : ''}" data-layer="${id}"><i style="background:${PREVIEW[id].color}"></i>${PREVIEW[id].label}</button>`).join('');
    const files = st.last ? `<details open><summary>前回書き出したファイル（${st.last.files.length}）</summary><ul class="files">${st.last.files.map((f) => `<li><span>${esc(f.name)}</span><small>${(f.content.length / 1024).toFixed(1)} KB</small></li>`).join('')}</ul><p class="note">${esc(ctx.fmtTime(st.last.at))}・ZIP ${(st.last.size / 1024).toFixed(1)} KB</p></details>` : '';
    ctx.root.innerHTML = `<div class="check-wrap out-wrap">
      <div class="check-card on">
        <div class="check-card-head"><b>Gerber・ドリル（JLCPCB 向け）</b>${drcLine}</div>
        <small>基板 ${plot.board.w.toFixed(1)} × ${plot.board.h.toFixed(1)} mm・2層・部品 ${pcb.footprints.length}・穴 ${holes}${minDrill < Infinity ? `（最小 φ${minDrill.toFixed(2)}）` : ''}${minTrack < Infinity ? `・最小配線幅 ${minTrack.toFixed(3)} mm` : ''}</small>
        <label class="opt"><input type="checkbox" id="opt-tent" ${st.tentVias ? 'checked' : ''}> ビアをレジストで覆う（テンティング）</label>
        <div class="check-card-actions"><button class="btn primary" data-export>ZIPを書き出す</button>${ds !== 'current' ? '<button class="btn" data-drc>DRCを実行</button>' : ''}</div>
      </div>
      <h3>プレビュー（書き出す図形そのもの・上から見た向き）</h3>
      <div class="chips">${chips}</div>
      ${preview(plot)}
      ${plot.notes.length ? `<ul class="uncovered">${plot.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${files}
      <details><summary>JLCPCB への注文</summary>
        <ol class="howto"><li>「ZIPを書き出す」で保存</li><li>JLCPCB の見積もりページ（jlcpcb.com）で「Add gerber file」から ZIP をアップロード</li><li>表示された基板の画像と寸法・層数（2層）・板厚を確認して注文</li></ol>
        <p class="note">部品実装（PCBA）用の BOM・CPL は第7段階で作ります。</p>
      </details>
      <details><summary>出力するファイル</summary><ul class="cover">${LAYERS.map((l) => `<li><span>.${l.ext}</span>${esc(l.name)}</li>`).join('')}<li><span>.drl</span>メッキ穴（PTH）・非メッキ穴（NPTH）のドリル（Excellon）</li></ul>
        <p class="note">Gerber は RS-274X（X2属性つき）・mm・4.6形式。Y は上向き（基板座標を反転）。</p></details>
    </div>`;
    ctx.root.querySelectorAll('[data-layer]').forEach((b) => { b.onclick = () => { const id = b.dataset.layer; st.show.has(id) ? st.show.delete(id) : st.show.add(id); render(); }; });
    ctx.root.querySelector('#opt-tent').onchange = (e) => { st.tentVias = e.target.checked; render(); };
    ctx.root.querySelector('[data-export]').onclick = () => exportZip();
    ctx.root.querySelector('[data-drc]')?.addEventListener('click', () => { ctx.runDrc(); render(); });
  }

  async function exportZip() {
    const p = ctx.getProject(), pcb = ctx.getPcb();
    if (!pcb.footprints.length) { ctx.toast('PCB に部品がありません', true); return null; }
    // 書き出す直前の状態で DRC をやり直す
    const r = ctx.runDrc();
    if (r.summary.errors) {
      const list = r.issues.filter((i) => i.level === 'error').slice(0, 6).map((i) => `<li>${esc(i.message)}</li>`).join('');
      const ok = await ctx.ask('DRC エラーがあります', `<p class="err">エラーが ${r.summary.errors} 件あります。このまま製造すると不良になるおそれがあります。</p><ul class="errs">${list}</ul>`,
        [{ label: 'やめる', value: '' }, { label: 'それでも書き出す', value: 'ok', cls: 'danger' }]);
      if (ok !== 'ok') return null;
    }
    memo.key = null;
    const plot = getPlot();
    const files = gerberFiles(plot, { project: p.name, version: ctx.version });
    const zip = makeZip(files);
    const name = `${String(p.name).replace(/[\\/:*?"<>|\s]+/g, '_') || 'board'}-gerber.zip`;
    await ctx.download(name, zip, 'application/zip');
    st.last = { files, size: zip.length, at: Date.now() };
    render();
    ctx.toast(`${name} を書き出しました（${files.length} ファイル）`);
    return { files, zip };
  }

  return { render, exportZip, getPlot };
}
