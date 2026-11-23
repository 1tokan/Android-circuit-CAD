// 「出力」画面: 製造データ（Gerber・ドリル）の確認と書き出し
import { buildPlot } from './plot.js';
import { FAB_OPTIONS, LABELS, COLORS, adaptFab, checkFab, orderSheet, stackupText } from './fabspec.js';
import { layerName } from '../pcb/model.js';
import { gerberFiles } from './gerber.js';
import { makeZip } from './zip.js';
import { drcStatus } from '../check/drc.js';
import { buildAssembly, bomCsv, cplCsv, pcbaService } from './assembly.js';
import { lcscUrl } from '../library/parts.js';
import { esc } from '../core/util.js';


// プレビューの色（基板を上から見た色に近づける）
const PREVIEW = {
  'Edge.Cuts': { color: '#e8d34a', label: '外形' },
  'B.Cu': { color: '#3b6fd6', label: '裏銅' },
  'In4.Cu': { color: '#2fb5c9', label: '内層4' },
  'In3.Cu': { color: '#d98c2b', label: '内層3' },
  'In2.Cu': { color: '#b55bd6', label: '内層2' },
  'In1.Cu': { color: '#3fb67a', label: '内層1' },
  'F.Cu': { color: '#c83a3a', label: '表銅' },
  'B.Mask': { color: '#6fa8ff', label: '裏レジスト開口' },
  'F.Mask': { color: '#ffb36b', label: '表レジスト開口' },
  'F.Paste': { color: '#b0b0b0', label: '表メタルマスク' },
  'B.Paste': { color: '#8c8c8c', label: '裏メタルマスク' },
  'B.SilkS': { color: '#a8b6ff', label: '裏シルク' },
  'F.SilkS': { color: '#f2f2f2', label: '表シルク' },
  drill: { color: '#000000', label: '穴' },
};
const ORDER = ['B.Cu', 'In4.Cu', 'In3.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu', 'B.Mask', 'F.Mask', 'B.Paste', 'F.Paste', 'B.SilkS', 'F.SilkS', 'drill', 'Edge.Cuts'];

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
 * @param ctx { root, getProject, getPcb, version, toast, ask, download, runDrc, fmtTime, mutate, editPcb, open3d }
 */
export function createOutputView(ctx) {
  const st = { show: new Set(['Edge.Cuts', 'B.Cu', 'F.Cu', 'F.SilkS', 'drill']), last: null, boards: 5, tab: 'gerber' };
  let memo = { key: null, plot: null };

  function getPlot() {
    const p = ctx.getProject(), pcb = ctx.getPcb();
    const key = String(p.revision);
    if (memo.key !== key) memo = { key, plot: buildPlot(p, pcb) };
    return memo.plot;
  }

  function preview(plot) {
    const b = plot.board;
    const pad = 1.5;
    const vb = `${b.x0 - pad} ${b.y0 - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
    const g = [];
    g.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.w}" height="${b.h}" fill="#0d3b22"/>`);
    for (const id of ORDER) {
      if (!st.show.has(id) || (!plot.layers[id] && id !== 'drill')) continue;
      if (id === 'drill') {
        g.push(`<g fill="#000" stroke="#000">${[...plot.drills.pth, ...plot.drills.npth].map((h) => h.slot ? `<path d="M${h.slot.a.x} ${h.slot.a.y}L${h.slot.b.x} ${h.slot.b.y}" stroke-width="${h.d}" stroke-linecap="round"/>` : `<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}" stroke="none"/>`).join('')}</g>`);
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
    const nL = pcb.settings?.layers || 2;
    const fab = p.board.fab;
    const fabIssues = checkFab(fab, nL);
    const sheet = orderSheet({ layers: nL, fab, board: plot.board, files: plot.layerDefs.map((l) => '.' + l.ext.toUpperCase()), holes, minTrack: minTrack < Infinity ? minTrack : 0, minDrill: minDrill < Infinity ? minDrill : 0, smdParts: pcb.footprints.filter((f) => !f.dnp).length, pcba: pcbaService(p, pcb, pcb.footprints.filter((f) => !f.dnp).map((f) => ({ layer: f.side === 'bottom' ? 'Bottom' : 'Top' }))) });
    const chips = ORDER.filter((id) => id === 'drill' || plot.layers[id]).map((id) => `<button class="chip${st.show.has(id) ? ' on' : ''}" data-layer="${id}"><i style="background:${PREVIEW[id].color}"></i>${PREVIEW[id].label}</button>`).join('');
    const files = st.last ? `<details open><summary>前回書き出したファイル（${st.last.files.length}）</summary><ul class="files">${st.last.files.map((f) => `<li><span>${esc(f.name)}</span><small>${(f.content.length / 1024).toFixed(1)} KB</small></li>`).join('')}</ul><p class="note">${esc(ctx.fmtTime(st.last.at))}・ZIP ${(st.last.size / 1024).toFixed(1)} KB</p></details>` : '';
    const tabs = `<div class="chips seg">${[['gerber', '基板（Gerber）'], ['asm', '部品実装（BOM・CPL）']].map(([k, l]) => `<button class="chip${st.tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>`;
    if (st.tab === 'asm') { ctx.root.innerHTML = `<div class="check-wrap out-wrap">${tabs}${assemblyHtml()}</div>`; bindCommon(); bindAssembly(); return; }
    ctx.root.innerHTML = `<div class="check-wrap out-wrap">${tabs}
      <div class="check-card on">
        <div class="check-card-head"><b>Gerber・ドリル（JLCPCB 向け）</b>${drcLine}</div>
        <small>基板 ${plot.board.w.toFixed(1)} × ${plot.board.h.toFixed(1)} mm・${nL}層・部品 ${pcb.footprints.length}・穴 ${holes}${minDrill < Infinity ? `（最小 φ${minDrill.toFixed(2)}）` : ''}${minTrack < Infinity ? `・最小配線幅 ${minTrack.toFixed(3)} mm` : ''}</small>
        <div class="check-card-actions"><button class="btn primary" data-export>ZIPを書き出す</button><button class="btn" data-3d>3Dで見る</button>${ds !== 'current' ? '<button class="btn" data-drc>DRCを実行</button>' : ''}</div>
      </div>
      ${fabHtml(nL, fab, fabIssues)}
      <h3>プレビュー（書き出す図形そのもの・上から見た向き）</h3>
      <div class="chips">${chips}</div>
      ${preview(plot)}
      ${plot.notes.length ? `<ul class="uncovered">${plot.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${files}
      <details><summary>JLCPCB への注文</summary>
        <ol class="howto"><li>「ZIPを書き出す」で保存</li><li>JLCPCB の見積もりページ（jlcpcb.com）で「Add gerber file」から ZIP をアップロード</li><li>表示された基板の画像と寸法を確認し、下の一覧のとおりに注文フォームを選ぶ${nL >= 4 ? '（4・6層は内層の順序 G1→L2… の確認を求められることがあります）' : ''}</li></ol>
        <pre class="order-sheet">${esc(sheet.text)}</pre><button class="btn small-btn" data-copy-sheet>一覧をコピー</button>
        <p class="note">部品実装（PCBA）を頼むときは、下の「部品実装」で BOM・CPL を書き出し、注文画面の「PCB Assembly」で BOM と CPL をアップロードします。</p>
      </details>
      <details><summary>出力するファイル</summary><ul class="cover">${plot.layerDefs.map((l) => `<li><span>.${l.ext}</span>${esc(l.name)}</li>`).join('')}<li><span>.drl</span>メッキ穴（PTH）・非メッキ穴（NPTH）のドリル（Excellon）</li></ul>
        <p class="note">Gerber は RS-274X（X2属性つき）・mm・4.6形式。Y は上向き（基板座標を反転）。</p></details>
    </div>`;
    bindCommon();
    ctx.root.querySelectorAll('[data-layer]').forEach((b) => { b.onclick = () => { const id = b.dataset.layer; st.show.has(id) ? st.show.delete(id) : st.show.add(id); render(); }; });
    bindFab(nL);
    ctx.root.querySelector('[data-3d]').onclick = () => ctx.open3d();
    ctx.root.querySelector('[data-copy-sheet]').onclick = async () => { try { await navigator.clipboard.writeText(sheet.text); ctx.toast('コピーしました'); } catch { ctx.toast('コピーできませんでした', true); } };
    ctx.root.querySelector('[data-export]').onclick = () => exportZip();
    ctx.root.querySelector('[data-drc]')?.addEventListener('click', () => { ctx.runDrc(); render(); });
  }

  function sel(name, values, cur, label = (v) => v) {
    return `<select name="${name}">${values.map((v) => `<option value="${v ?? ''}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label(v))}</option>`).join('')}</select>`;
  }

  /** 製造仕様（層数は PCB の設定、ほかは board.fab） */
  function fabHtml(nL, fab, issues) {
    const row = (l, html) => `<label class="field"><span>${l}</span>${html}</label>`;
    return `<details class="fab" open><summary>製造仕様（JLCPCB の注文フォームの項目）</summary>
      <div class="fab-grid">
        ${row('層数', sel('layers', FAB_OPTIONS.layers, nL, (v) => `${v}層`))}
        ${row('板厚', sel('thicknessMm', FAB_OPTIONS.thicknessMm[nL], fab.thicknessMm, (v) => `${v} mm`))}
        ${nL >= 4 ? row('積層構成', sel('stackup', FAB_OPTIONS.stackup[nL], fab.stackup)) : ''}
        ${row('外層銅厚', sel('outerCopperOz', FAB_OPTIONS.outerCopperOz, fab.outerCopperOz, (v) => `${v} oz`))}
        ${nL >= 4 ? row('内層銅厚', sel('innerCopperOz', FAB_OPTIONS.innerCopperOz, fab.innerCopperOz, (v) => `${v} oz`)) : ''}
        ${row('レジスト色', sel('maskColor', FAB_OPTIONS.maskColor, fab.maskColor, (v) => LABELS.maskColor[v]))}
        ${row('シルク色', sel('silkColor', FAB_OPTIONS.silkColor, fab.silkColor, (v) => LABELS.silkColor[v]))}
        ${row('表面処理', sel('finish', FAB_OPTIONS.finish, fab.finish, (v) => LABELS.finish[v]))}
        ${row('ビアの処理', sel('viaProcess', FAB_OPTIONS.viaProcess, fab.viaProcess, (v) => LABELS.viaProcess[v]))}
      </div>
      <p class="note"><i class="swatch" style="background:${COLORS.mask[fab.maskColor]}"></i> ${esc(stackupText(nL, fab))}</p>
      ${issues.length ? `<ul class="issues">${issues.map((x) => `<li class="issue ${x.level}"><span class="lv">${x.level === 'error' ? '✕' : '!'}</span><span class="msg">${esc(x.message)}</span></li>`).join('')}</ul>` : ''}
      ${nL >= 4 ? `<p class="note">内層: ${Array.from({ length: nL - 2 }, (_, i) => `In${i + 1}.Cu = ${layerName(`In${i + 1}.Cu`)}（L${i + 2}・.G${i + 1}）`).join('、')}。設計ルールは ${nL} 層の値（最小配線幅・間隔 0.09mm、ビア穴 0.2mm／外径 0.45mm）になります</p>` : ''}
    </details>`;
  }

  function bindFab(nL) {
    ctx.root.querySelectorAll('.fab select').forEach((el) => {
      el.onchange = () => {
        const name = el.name;
        const raw = el.value;
        const v = raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
        if (name === 'layers') {
          // 層数は PCB の設定（元に戻せる）。製造仕様もその層数で選べる値に合わせる
          ctx.editPcb(() => { ctx.getPcb().settings.layers = v; }, `${v}層に変更`);
          ctx.mutate((q) => { q.board.fab = adaptFab(q.board.fab, v); }, 'fab');
          if (v < nL) {
            const inner = ctx.getPcb().tracks.filter((t) => /^In/.test(t.layer) && Number(t.layer[2]) > v - 2).length + ctx.getPcb().zones.filter((z) => /^In/.test(z.layer) && Number(z.layer[2]) > v - 2).length;
            if (inner) ctx.toast(`使えなくなった内層に配線・ベタが ${inner} 個あります（DRC で表示）`, true);
          }
        } else {
          ctx.mutate((q) => { q.board.fab = adaptFab({ ...q.board.fab, [name]: v }, nL); }, 'fab');
        }
        render();
      };
    });
  }

  function bindCommon() {
    ctx.root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { st.tab = b.dataset.tab; render(); }; });
  }

  function assembly() {
    return buildAssembly(ctx.getProject(), ctx.getPcb(), { boards: st.boards });
  }

  function assemblyHtml() {
    const a = assembly();
    const errs = a.problems.filter((x) => x.level === 'error'), warns = a.problems.filter((x) => x.level === 'warning'), infos = a.problems.filter((x) => x.level === 'info');
    const list = (arr, cls) => (arr.length ? `<ul class="issues">${arr.map((x) => `<li class="issue ${x.level}"><span class="lv">${x.level === 'error' ? '✕' : x.level === 'info' ? 'i' : '!'}</span><span class="msg">${esc(x.message)}</span></li>`).join('')}</ul>` : '');
    const type = { basic: 'Basic', preferred: 'Preferred', extended: 'Extended', unknown: '—' };
    const bomRows = a.bom.map((r) => `<tr><td>${esc(r.comment)}</td><td>${esc(r.designators.join(', '))}</td><td>${esc(r.footprint)}</td><td>${r.lcsc ? `<a href="${esc(lcscUrl(r.lcsc))}" target="_blank" rel="noopener">${esc(r.lcsc)}</a>` : '<b class="err">なし</b>'}</td><td>${type[r.jlcType] || '—'}</td><td class="num">${r.qty}</td><td class="num">${r.unitUsd != null ? '$' + r.unitUsd.toFixed(4) : '—'}</td></tr>`).join('');
    const cplRows = a.cpl.map((c) => `<tr><td>${esc(c.designator)}</td><td class="num">${c.x.toFixed(3)}</td><td class="num">${c.y.toFixed(3)}</td><td>${c.layer === 'Top' ? '表' : '裏'}</td><td class="num"><b>${+c.rotation.toFixed(2)}°</b><br><small>${+c.base.toFixed(2)}${c.pkgOffset ? ` + ${c.pkgOffset}` : ''}${c.manualOffset ? ` + ${c.manualOffset}` : ''}</small></td><td><button class="btn small-btn" data-rot="${esc(c.designator)}" data-d="-90">−90</button><button class="btn small-btn" data-rot="${esc(c.designator)}" data-d="90">+90</button></td></tr>`).join('');
    return `<div class="check-card on">
        <div class="check-card-head"><b>部品実装（JLCPCB PCBA 向け）</b>${errs.length ? `<span class="err">要修正 ${errs.length}</span>` : '<span class="ok">書き出せます</span>'}</div>
        <div class="asm-service" data-service="${a.summary.service.type}">注文の種類: <b>${a.summary.service.type === 'economic' ? 'エコノミー PCBA' : `標準 PCBA（${a.summary.service.sides === 'double' ? '両面' : '片面'}）`}</b></div>
        <small>実装する部品 ${a.summary.parts} 個・${a.summary.lines} 種類${a.summary.partsUsd != null ? `・部品代の目安 $${a.summary.partsUsd.toFixed(2)}（${a.summary.boards} 枚分・価格のある ${a.summary.pricedLines} 種類のみ。送料・実装費は別）` : ''}</small>
        <label class="opt">枚数 <input type="number" id="asm-boards" min="1" max="10000" value="${st.boards}" inputmode="numeric" style="width:90px"></label>
        <div class="check-card-actions"><button class="btn primary" data-bom>BOMを書き出す</button><button class="btn primary" data-cpl>CPLを書き出す</button></div>
      </div>
      ${list(errs)}${list(warns)}${list(infos)}
      <h3>BOM（${a.bom.length} 行）</h3>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Comment</th><th>Designator</th><th>Footprint</th><th>LCSC</th><th>区分</th><th>数</th><th>単価</th></tr></thead><tbody>${bomRows || '<tr><td colspan="7">部品がありません</td></tr>'}</tbody></table></div>
      <h3>CPL（${a.cpl.length} 行）</h3>
      <p class="note">座標は mm・Y 上向き（Gerber と同じ原点）。回転は反時計回りが正で「PCBでの向き ＋ パッケージ補正 ＋ 手動補正」。JLCPCB の注文画面のプレビューで向きがずれていたら、その部品の ±90 で直してから書き出し直してください。</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Designator</th><th>Mid X</th><th>Mid Y</th><th>面</th><th>Rotation</th><th>補正</th></tr></thead><tbody>${cplRows || '<tr><td colspan="6">部品がありません</td></tr>'}</tbody></table></div>`;
  }

  function bindAssembly() {
    ctx.root.querySelector('#asm-boards').onchange = (e) => { st.boards = Math.max(1, Math.min(10000, Math.round(Number(e.target.value) || 1))); render(); };
    ctx.root.querySelector('[data-bom]').onclick = () => exportAssembly('bom');
    ctx.root.querySelector('[data-cpl]').onclick = () => exportAssembly('cpl');
    ctx.root.querySelectorAll('[data-rot]').forEach((b) => {
      b.onclick = () => {
        const ref = b.dataset.rot, d = Number(b.dataset.d);
        ctx.editPcb(() => {
          const f = ctx.getPcb().footprints.find((q) => q.ref === ref);
          const v = (((Number(f.cplRotOffset) || 0) + d) % 360 + 360) % 360;
          if (v) f.cplRotOffset = v; else delete f.cplRotOffset;
        }, `${ref} の実装向きの補正`);
        render();
      };
    });
  }

  async function exportAssembly(kind) {
    const p = ctx.getProject();
    const a = assembly();
    if (!a.cpl.length) { ctx.toast('PCB に部品がありません', true); return null; }
    const errs = a.problems.filter((x) => x.level === 'error');
    if (errs.length) {
      const ok = await ctx.ask('このままでは実装できない部品があります', `<ul class="errs">${errs.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul>`,
        [{ label: 'やめる', value: '' }, { label: 'それでも書き出す', value: 'ok', cls: 'danger' }]);
      if (ok !== 'ok') return null;
    }
    const base = String(p.name).replace(/[\\/:*?"<>|\s]+/g, '_') || 'board';
    const name = `${base}-${kind === 'bom' ? 'BOM' : 'CPL'}.csv`;
    const text = kind === 'bom' ? bomCsv(a) : cplCsv(a);
    await ctx.download(name, text, 'text/csv');
    ctx.toast(`${name} を書き出しました`);
    return { name, text };
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

  return { render, exportZip, exportAssembly, getPlot, setTab(t) { st.tab = t; render(); } };
}
