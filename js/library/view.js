// 「部品」作業領域の画面: 検索・詳細・取込・手動登録・編集・削除
import { KINDS, kindInfo } from '../schematic/symbols.js';
import { listFootprints, getFootprint, padNumbers } from './footprints.js';
import {
  JLC_TYPES, normalizePart, partSymbol, effectivePinMap, checkPinMap, lcscUrl, jlcUrl, unitPrice, displayValue,
  partFootprint, guessFootprint,
} from './parts.js';
import { importCSV, importJSON, exportLibraryJSON } from './importer.js';
import { symbolPreviewSVG } from '../schematic/render.js';
import { esc } from '../core/util.js';

const $ = (s, el = document) => el.querySelector(s);
const PART_KINDS = KINDS.filter((k) => !k.power);

/**
 * @param ctx { root, lib, ui:{toast, ask, download}, onPlace(part), onAssign(part), assignTarget():{ref}|null }
 */
export function createPartsView(ctx) {
  const st = { q: '', kind: '', jlcType: '', inStock: false, detail: null, limit: 100 };
  const root = ctx.root;

  root.innerHTML = `
    <div class="pv-search">
      <input type="search" id="pv-q" placeholder="名称・型番・LCSC品番・値（例: 10k 0603, C1525）" enterkeyhint="search" autocomplete="off">
      <div class="pv-filters">
        <select id="pv-kind" aria-label="種別"><option value="">全種別</option>${PART_KINDS.map((k) => `<option value="${k.kind}">${esc(k.label)}</option>`).join('')}</select>
        <select id="pv-jlc" aria-label="JLCPCB区分"><option value="">全区分</option>${Object.entries(JLC_TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <label class="pv-chk"><input type="checkbox" id="pv-stock"> 在庫あり</label>
      </div>
      <div class="pv-assign" id="pv-assign" hidden></div>
      <div class="pv-online">
        <button type="button" class="btn" id="pv-online-btn">オンライン検索（jlcsearch）</button>
        <button type="button" class="chip" id="pv-online-cfg" aria-label="オンライン検索の設定">設定</button>
      </div>
      <div class="pv-count" id="pv-count"></div>
    </div>
    <section class="pv-online-res" id="pv-online-res" hidden></section>
    <ul class="pv-list" id="pv-list"></ul>
    <input type="file" id="pv-file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" hidden>`;

  const listEl = $('#pv-list', root);
  let timer;
  $('#pv-q', root).addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { st.q = e.target.value; st.limit = 100; renderList(); }, 150); });
  $('#pv-kind', root).onchange = (e) => { st.kind = e.target.value; renderList(); };
  $('#pv-jlc', root).onchange = (e) => { st.jlcType = e.target.value; renderList(); };
  $('#pv-stock', root).onchange = (e) => { st.inStock = e.target.checked; renderList(); };
  $('#pv-file', root).onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); };
  $('#pv-online-btn', root).onclick = () => onlineSearch();
  $('#pv-online-cfg', root).onclick = () => onlineSettings();
  $('#pv-online-res', root).addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { $('#pv-online-res', root).hidden = true; return; }
    const li = e.target.closest('[data-idx]');
    if (li && !e.target.closest('a')) showDetail(st.online[Number(li.dataset.idx)], { online: true });
  });
  listEl.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { st.limit += 200; renderList(); return; }
    const li = e.target.closest('[data-id]');
    if (li && !e.target.closest('a')) showDetail(li.dataset.id);
  });

  function render() {
    const t = ctx.assignTarget();
    const a = $('#pv-assign', root);
    a.hidden = !t;
    if (t) a.innerHTML = `<b>${esc(t.ref)}</b> に割り当てる部品を選んでください <button type="button" class="chip" id="pv-assign-cancel">やめる</button>`;
    $('#pv-assign-cancel', root)?.addEventListener('click', () => { ctx.cancelAssign(); render(); });
    renderList();
  }

  function priceText(p) {
    const u = unitPrice(p, 1);
    return u === null ? '' : `$${u < 0.01 ? u.toFixed(4) : u.toFixed(3)}`;
  }

  function badge(p) {
    const t = p.jlc.type;
    return `<span class="badge jlc-${t}">${esc(JLC_TYPES[t])}</span>`;
  }

  function fpBadge(p) {
    const fp = partFootprint(p);
    if (!fp) return '<span class="badge planned">フットプリント未設定</span>';
    return fp.generated ? '<span class="badge">FP推定</span>' : '';
  }

  function lcscBadge(p) {
    if (!p.lcsc) return '<span class="badge planned">LCSCなし</span>';
    return `<span class="badge ${p.lcscVerified ? 'ready' : 'planned'}">${esc(p.lcsc)}${p.lcscVerified ? '' : ' 要確認'}</span>`;
  }

  function renderList() {
    const r = ctx.lib.search(st.q, { kind: st.kind, jlcType: st.jlcType, inStockOnly: st.inStock }, st.limit);
    const c = ctx.lib.counts();
    $('#pv-count', root).textContent = `${r.total}件ヒット（内蔵${c.builtin}・取込/登録${c.user}）`;
    listEl.innerHTML = r.items.map((p) => `
      <li class="pv-item" data-id="${esc(p.id)}">
        <div class="pv-row1"><b>${esc(p.name)}</b>${p.source === 'builtin' ? '<span class="badge">内蔵</span>' : ''}</div>
        <div class="pv-row2">${esc([p.manufacturer, p.mpn].filter(Boolean).join(' · ') || kindInfo(p.kind).label)}</div>
        <div class="pv-row3">${lcscBadge(p)} ${badge(p)} <span>${esc(p.package || '-')}</span>${p.kind === 'ic' ? `<span>${partSymbol(p).pins.length}ピン</span>` : ''}${fpBadge(p)}
          ${priceText(p) ? `<span>${priceText(p)}</span>` : ''}${p.stock !== null ? `<span>在庫 ${p.stock.toLocaleString()}</span>` : ''}
          ${p.datasheet ? `<a href="${esc(p.datasheet)}" target="_blank" rel="noopener">データシート</a>` : ''}</div>
      </li>`).join('') + (r.total > r.items.length ? `<li class="pv-more"><button type="button" class="btn" data-more>さらに表示（残り${r.total - r.items.length}件）</button></li>` : '')
      + (!r.total ? '<li class="pv-empty">該当する部品がありません。CSV/JSONの取込か手動登録で追加できます。</li>' : '');
  }

  // ---------------- 詳細 ----------------
  function footprintSVG(fp) {
    if (!fp) return '<p class="note">フットプリントが見つかりません</p>';
    const c = fp.courtyard;
    const pad = 0.6;
    const vb = `${c.x0 - pad} ${c.y0 - pad} ${c.x1 - c.x0 + pad * 2} ${c.y1 - c.y0 + pad * 2}`;
    const pads = fp.pads.map((p) => {
      const shape = p.shape === 'circle' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2}"/>`
        : `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : p.shape === 'roundrect' ? Math.min(p.w, p.h) * 0.25 : 0}"/>`;
      const hole = p.type === 'tht' ? `<circle class="hole" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}"/>` : '';
      const fs = Math.max(0.3, Math.min(p.w, p.h) * 0.55);
      return `<g class="pad">${shape}${hole}<text x="${p.x}" y="${p.y}" font-size="${fs}" dy="${fs * 0.35}">${esc(p.num)}</text></g>`;
    }).join('');
    return `<svg class="fp-preview" viewBox="${vb}"><rect class="court" x="${c.x0}" y="${c.y0}" width="${c.x1 - c.x0}" height="${c.y1 - c.y0}"/>${pads}<path class="origin" d="M-0.4 0H0.4M0 -0.4V0.4"/></svg>`;
  }

  function pinTable(p) {
    const sym = partSymbol(p);
    const fp = partFootprint(p);
    const pm = effectivePinMap(sym, fp, p.pinMap);
    const chk = checkPinMap(sym, fp, pm);
    const rows = sym.pins.map((pin) => `<tr><td>${esc(pin.num)}</td><td>${esc(pin.name === '~' ? '' : pin.name)}</td><td>${esc(pinTypeLabel(pin.type))}</td><td>${pm.nc.has(pin.num) ? '（未使用）' : esc((pm.map[pin.num] || []).join(', ') || '—')}</td></tr>`).join('');
    return `<table class="pin-table"><thead><tr><th>ピン</th><th>名称</th><th>電気的属性</th><th>パッド</th></tr></thead><tbody>${rows}</tbody></table>` +
      (chk.errors.length ? `<ul class="errs">${chk.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="ok">✓ ピン↔パッド対応にエラーなし</p>') +
      (chk.warnings.length ? `<ul class="warns">${chk.warnings.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
  }

  function pinTypeLabel(t) {
    return { passive: 'パッシブ', input: '入力', output: '出力', bidirectional: '双方向', power_in: '電源入力', power_out: '電源出力', open_collector: 'オープンコレクタ', nc: '未接続' }[t] || t;
  }

  async function showDetail(idOrPart, { online = false } = {}) {
    const p = typeof idOrPart === 'string' ? ctx.lib.get(idOrPart) : idOrPart;
    if (!p) return;
    const saved = online ? ctx.lib.get(p.id) : p;
    const fp = partFootprint(p);
    const builtin = !online && ctx.lib.isBuiltin(p.id);
    const t = ctx.assignTarget();
    const kv = (k, v) => (v === '' || v === null || v === undefined ? '' : `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`);
    const links = [
      lcscUrl(p.lcsc) && `<a class="btn" href="${lcscUrl(p.lcsc)}" target="_blank" rel="noopener">LCSCで開く</a>`,
      jlcUrl(p.lcsc) && `<a class="btn" href="${jlcUrl(p.lcsc)}" target="_blank" rel="noopener">JLCPCBで開く</a>`,
      p.datasheet && `<a class="btn" href="${esc(p.datasheet)}" target="_blank" rel="noopener">データシート</a>`,
    ].filter(Boolean).join('');
    const html = `<div class="pv-detail">
      ${kv('種別', esc(kindInfo(p.kind).label))}${kv('値', esc(displayValue(p)))}${kv('メーカー', esc(p.manufacturer))}${kv('メーカー型番', esc(p.mpn))}
      ${kv('LCSC品番', p.lcsc ? `${esc(p.lcsc)} ${p.lcscVerified ? '<span class="badge ready">確認済み</span>' : '<span class="badge planned">要確認</span>'}` : '')}
      ${kv('JLCPCB区分', esc(JLC_TYPES[p.jlc.type]))}${kv('パッケージ', esc(p.package))}
      ${kv('価格(1個)', esc(unitPrice(p, 1) === null ? '' : `$${unitPrice(p, 1)}`))}${kv('在庫', p.stock === null ? '' : esc(p.stock.toLocaleString()))}
      ${kv('情報の日付', esc(p.updatedAt ? String(p.updatedAt).slice(0, 10) : ''))}
      ${Object.entries(p.specs).map(([k, v]) => kv(k, esc(v))).join('')}
      ${p.description ? `<p class="note">${esc(p.description)}</p>` : ''}
      <div class="pv-links">${links}</div>
      <h4>シンボルとフットプリント（${esc(fp?.name || p.footprint || '未設定')}${fp?.generated ? ' <span class="badge planned">パッケージ名から自動生成・要確認</span>' : fp && !fp.verified ? ' <span class="badge planned">寸法未照合</span>' : ''}）</h4>
      ${fp?.generated ? `<p class="note">${esc(fp.desc)}。標準寸法からの推定なので、発注前にデータシートの推奨ランドパターンと照合してください。</p>` : ''}
      <div class="pv-previews">${symbolPreviewSVG(p.kind, { pinCount: p.symbol.pinCount, pinNames: p.symbol.pinNames })}${footprintSVG(fp)}</div>
      <h4>ピン ↔ パッド対応</h4>${pinTable(p)}
      ${online ? `<p class="note">jlcsearch（非公式のコミュニティAPI）から取得した情報です。価格・在庫は${esc(String(p.updatedAt).slice(0, 16).replace('T', ' '))}時点。${saved && saved.source !== 'jlcsearch' ? '保存済みの部品なので、保存すると価格・在庫・区分だけを更新します（種別・フットプリント・ピン対応は今のまま）。' : 'シンボル種別とフットプリントは推定なので、保存後に「編集」で確認してください。'}</p>` : ''}
    </div>`;
    if (online) {
      const t2 = ctx.assignTarget();
      const r = await ctx.ui.ask(p.name, html, [
        { label: '閉じる', value: '' }, { label: saved ? '保存済み（更新）' : 'ライブラリに保存', value: 'save' },
        t2 ? { label: `保存して ${t2.ref} に割り当て`, value: 'assign', cls: 'primary' } : { label: '保存して回路図に配置', value: 'place', cls: 'primary' },
      ]);
      if (!r) return;
      // 保存済みの部品は、利用者が決めた内容（種別・フットプリント・ピン対応・名称など）を残し、
      // 価格・在庫・区分・データシート・日付だけをオンラインの情報で更新する
      const merged = saved && saved.source !== 'jlcsearch'
        ? { ...saved, price: p.price, stock: p.stock, jlc: p.jlc, datasheet: p.datasheet || saved.datasheet, updatedAt: p.updatedAt, lcscVerified: true, manufacturer: saved.manufacturer || p.manufacturer }
        : p;
      const [stored] = await ctx.lib.upsert([merged]);
      renderList();
      renderOnline();
      if (r === 'save') ctx.ui.toast(`「${stored.name}」をライブラリに保存しました`);
      if (r === 'place') ctx.onPlace(stored);
      if (r === 'assign') ctx.onAssign(stored);
      return;
    }
    const buttons = [{ label: '閉じる', value: '' }];
    if (!builtin) buttons.push({ label: '削除', value: 'del', cls: 'danger' });
    buttons.push({ label: builtin ? 'コピーして編集' : '編集', value: 'edit' });
    if (p.lcsc && !p.lcscVerified) buttons.push({ label: 'LCSC品番を確認済みにする', value: 'verify' });
    buttons.push(t ? { label: `${t.ref} に割り当て`, value: 'assign', cls: 'primary' } : { label: '回路図に配置', value: 'place', cls: 'primary' });
    const r = await ctx.ui.ask(p.name, html, buttons);
    if (r === 'place') ctx.onPlace(p);
    else if (r === 'assign') ctx.onAssign(p);
    else if (r === 'edit') editPart(builtin ? { ...p, id: '', source: 'user', name: `${p.name}（コピー）` } : p);
    else if (r === 'verify') {
      const ok = await ctx.ui.ask('LCSC品番の確認', `<p>LCSCまたはJLCPCBのページで、<b>${esc(p.lcsc)}</b> が「${esc(p.mpn || p.name)}」（${esc(p.package)}）であることを確認しましたか？</p>`,
        [{ label: 'いいえ', value: '' }, { label: '確認した', value: 'ok', cls: 'primary' }]);
      if (ok === 'ok') { await ctx.lib.upsert([{ ...p, lcscVerified: true, source: builtin ? 'user' : p.source }]); ctx.ui.toast('確認済みにしました'); renderList(); }
    } else if (r === 'del') {
      const ok = await ctx.ui.ask('部品を削除', `<p>「${esc(p.name)}」をライブラリから削除します。配置済みの回路図には部品データのコピーが残ります。</p>`, [{ label: 'キャンセル', value: '' }, { label: '削除', value: 'del', cls: 'danger' }]);
      if (ok === 'del') { await ctx.lib.remove([p.id]); ctx.ui.toast('削除しました'); renderList(); }
    }
  }

  // ---------------- 手動登録・編集 ----------------
  async function editPart(p = null) {
    const v = p || { name: '', kind: 'resistor', value: '', manufacturer: '', mpn: '', lcsc: '', package: '', footprint: 'R_0805', datasheet: '', jlc: { type: 'unknown' }, price: [], stock: null, specs: {}, symbol: {}, pinMap: null };
    const fpId = typeof v.footprint === 'object' ? '__custom' : v.footprint;
    const f = (name, label, val, attrs = '') => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
    const html = `<div class="form">
      ${f('name', '部品名称 *', v.name)}
      <label class="field"><span>シンボル種別 *</span><select name="kind">${PART_KINDS.map((k) => `<option value="${k.kind}" ${k.kind === v.kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></label>
      ${f('value', '値（回路図に表示）', v.value, 'placeholder="例: 10k, 100n, AMS1117-3.3"')}
      ${f('manufacturer', 'メーカー', v.manufacturer)}${f('mpn', 'メーカー型番', v.mpn)}
      ${f('lcsc', 'LCSC品番', v.lcsc, 'placeholder="例: C1525" autocapitalize="characters"')}
      ${f('package', 'パッケージ', v.package)}
      <label class="field"><span>フットプリント</span><select name="footprint"><option value="">（未設定）</option><option value="__auto">パッケージ名から自動生成</option>${typeof fpId === 'string' && fpId.startsWith('PKG:') ? `<option value="${esc(fpId)}" selected>${esc(getFootprint(fpId)?.name || fpId)}（自動生成）</option>` : ''}${listFootprints().map((x) => `<option value="${x.id}" ${x.id === fpId ? 'selected' : ''}>${esc(x.id)}</option>`).join('')}<option value="__custom" ${fpId === '__custom' ? 'selected' : ''}>独自定義（JSON）</option></select></label>
      <label class="field"><span>独自フットプリント（JSON、上で「独自定義」を選んだとき）</span><textarea name="fpjson" rows="3" placeholder='{"id":"MY_FP","pads":[{"num":"1","x":-1,"y":0,"w":1,"h":1}]}'>${esc(typeof v.footprint === 'object' ? JSON.stringify(v.footprint) : '')}</textarea></label>
      ${f('pinCount', 'ピン数（IC・コネクタ）', v.symbol?.pinCount ?? '', 'inputmode="numeric"')}
      ${f('pinNames', 'ピン名（カンマ区切り、1番から）', v.symbol?.pinNames ?? '')}
      <label class="field"><span>ピン→パッド対応（省略時は同じ番号。1行に「ピン:パッド,パッド」、パッドなしは「4:」）</span><textarea name="pinMap" rows="3" placeholder="1:1&#10;2:2,4">${esc(v.pinMap ? Object.entries(v.pinMap).map(([k, a]) => `${k}:${a.join(',')}`).join('\n') : '')}</textarea></label>
      ${f('datasheet', 'データシートURL', v.datasheet, 'inputmode="url"')}
      <label class="field"><span>JLCPCB区分</span><select name="jlcType">${Object.entries(JLC_TYPES).map(([k, l]) => `<option value="${k}" ${k === v.jlc.type ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${f('price', '価格（USD/1個）', v.price?.[0]?.usd ?? '', 'inputmode="decimal"')}${f('stock', '在庫数', v.stock ?? '', 'inputmode="numeric"')}
      <label class="field"><span>電気的仕様（1行に「項目=値」）</span><textarea name="specs" rows="3" placeholder="耐圧=16V&#10;許容差=±10%">${esc(Object.entries(v.specs || {}).map(([k, x]) => `${k}=${x}`).join('\n'))}</textarea></label>
    </div>`;
    const r = await ctx.ui.ask(p?.id ? '部品の編集' : '部品の登録', html, [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    const g = (n) => $(`#dialog-body [name="${n}"]`).value.trim();
    try {
      let footprint = g('footprint');
      if (footprint === '__auto') {
        footprint = guessFootprint(g('kind'), g('package'));
        if (!footprint) throw new Error(`パッケージ名「${g('package')}」からはフットプリントを生成できません。一覧から選ぶか独自定義してください`);
      }
      if (footprint === '__custom') {
        try { footprint = JSON.parse(g('fpjson')); } catch (e) { throw new Error('独自フットプリントのJSONが読めません: ' + e.message); }
      }
      let pinMap = null;
      if (g('pinMap')) {
        pinMap = {};
        for (const line of g('pinMap').split('\n').map((s) => s.trim()).filter(Boolean)) {
          const m = line.match(/^([^:]+):(.*)$/);
          if (!m) throw new Error(`ピン→パッド対応の書式が不正です: ${line}`);
          pinMap[m[1].trim()] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      const specs = {};
      for (const line of g('specs').split('\n').map((s) => s.trim()).filter(Boolean)) {
        const i = line.indexOf('=');
        if (i > 0) specs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const kind = g('kind');
      const part = normalizePart({
        ...(p?.id ? { id: p.id } : {}), source: p?.source && p.source !== 'builtin' ? p.source : 'user',
        name: g('name'), kind, value: g('value'), manufacturer: g('manufacturer'), mpn: g('mpn'), lcsc: g('lcsc'), package: g('package'),
        footprint, pinMap, datasheet: g('datasheet'), jlc: { type: g('jlcType') }, specs,
        symbol: { kind, ...(g('pinCount') ? { pinCount: Number(g('pinCount')) } : {}), ...(g('pinNames') ? { pinNames: g('pinNames') } : {}) },
        price: g('price') ? [{ qty: 1, usd: Number(g('price')) }] : [], stock: g('stock') === '' ? null : Number(g('stock')),
        updatedAt: new Date().toISOString(), lcscVerified: p?.lcsc === g('lcsc').toUpperCase() ? !!p?.lcscVerified : false,
      });
      const fp = partFootprint(part);
      if (fp) {
        const chk = checkPinMap(partSymbol(part), fp, effectivePinMap(partSymbol(part), fp, part.pinMap));
        if (chk.errors.length) {
          const go = await ctx.ui.ask('ピン↔パッド対応にエラーがあります', `<ul class="errs">${chk.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul><p>このまま保存しますか？（ネットリスト生成時にもエラーになります）</p>`, [{ label: '戻る', value: '' }, { label: '保存する', value: 'ok' }]);
          if (go !== 'ok') return;
        }
      }
      await ctx.lib.upsert([part]);
      ctx.ui.toast(`「${part.name}」を保存しました`);
      renderList();
    } catch (e) {
      ctx.ui.toast(e.message, true);
    }
  }

  // ---------------- オンライン検索（jlcsearch） ----------------
  st.online = [];
  st.onlineState = null; // null | 'loading' | {error} | 'done'

  function renderOnline() {
    const el = $('#pv-online-res', root);
    if (!st.onlineState) { el.hidden = true; return; }
    el.hidden = false;
    const head = `<div class="pv-online-head"><b>オンライン検索</b><span class="note">jlcsearch・非公式</span><button type="button" class="chip" data-close>閉じる</button></div>`;
    if (st.onlineState === 'loading') { el.innerHTML = head + '<p class="note">検索中…</p>'; return; }
    if (st.onlineState.error) {
      const e = st.onlineState.error;
      el.innerHTML = head + `<p class="err">${esc(e.message)}</p>` +
        (e.kind === 'network' ? '<p class="note">jlcsearch にブラウザから直接つながらない場合は、「設定」で中継URL（自分の Cloudflare Workers など、docs/jlcsearch-relay.md 参照）を指定できます。内蔵部品とCSV取込はこのまま使えます。</p>' : '');
      return;
    }
    if (!st.online.length) { el.innerHTML = head + '<p class="note">見つかりませんでした。型番やLCSC品番、「10k 0603」のような値で試してください。</p>'; return; }
    el.innerHTML = head + `<ul class="pv-list">${st.online.map((p, i) => `
      <li class="pv-item online" data-idx="${i}">
        <div class="pv-row1"><b>${esc(p.name)}</b>${ctx.lib.get(p.id) ? '<span class="badge ready">保存済み</span>' : ''}</div>
        <div class="pv-row2">${esc([p.manufacturer, p.mpn].filter(Boolean).join(' · ') || p.description)}</div>
        <div class="pv-row3">${lcscBadge(p)} ${badge(p)} <span>${esc(p.package || '-')}</span>${p.kind === 'ic' ? `<span>${partSymbol(p).pins.length}ピン</span>` : ''}${fpBadge(p)}
          ${priceText(p) ? `<span>${priceText(p)}</span>` : ''}${p.stock !== null ? `<span>在庫 ${p.stock.toLocaleString()}</span>` : ''}</div>
      </li>`).join('')}</ul>`;
  }

  async function onlineSearch() {
    const q = $('#pv-q', root).value.trim();
    if (!q) { ctx.ui.toast('検索語（型番・LCSC品番・値など）を入力してください'); $('#pv-q', root).focus(); return; }
    // 入力直後に押された場合も、ローカル一覧を同じ検索語にそろえる
    clearTimeout(timer);
    st.q = q;
    renderList();
    st.onlineState = 'loading';
    renderOnline();
    try {
      const r = await ctx.online.search(q, { limit: 30 });
      st.online = r.parts;
      st.onlineState = 'done';
    } catch (e) {
      st.online = [];
      st.onlineState = { error: e };
    }
    renderOnline();
  }

  async function onlineSettings() {
    const cur = ctx.online.base;
    const r = await ctx.ui.ask('オンライン検索の設定', `<p class="note">通常は変更不要です。ブラウザから jlcsearch に直接つながらない場合だけ、中継URLを指定します。</p>
      <label class="field"><span>接続先URL</span><input type="text" name="base" value="${esc(cur)}" inputmode="url"></label>`,
    [{ label: 'キャンセル', value: '' }, { label: '既定に戻す', value: 'reset' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    if (!r) return;
    const v = r === 'reset' ? '' : $('#dialog-body [name="base"]').value.trim();
    if (v && !/^https:\/\/[^\s]+$/.test(v)) { ctx.ui.toast('https:// で始まるURLを指定してください', true); return; }
    await ctx.setOnlineBase(v);
    ctx.ui.toast(`接続先: ${ctx.online.base}`);
  }

  // ---------------- 取込・書き出し ----------------
  async function importFile(file) {
    let res;
    try {
      const text = await file.text();
      res = /\.json$/i.test(file.name) || text.trim().startsWith('[') || text.trim().startsWith('{') ? importJSON(text) : importCSV(text, { source: `import:${file.name}` });
    } catch (e) { ctx.ui.toast(e.message, true); return; }
    if (!res.parts.length) { ctx.ui.toast(`取り込める部品がありません（スキップ${res.skipped.length}行）`, true); return; }
    const cols = res.columns ? `<p class="note">列の対応: ${Object.entries(res.columns).map(([k, v]) => `${esc(k)}←「${esc(v)}」`).join('、')}</p>` : '';
    const sk = res.skipped.length ? `<p>スキップ ${res.skipped.length}行:</p><ul class="warns">${res.skipped.slice(0, 8).map((s) => `<li>${s.line}行目: ${esc(s.reason)}</li>`).join('')}${res.skipped.length > 8 ? '<li>…</li>' : ''}</ul>` : '';
    const noFp = res.parts.filter((p) => !partFootprint(p)).length;
    const ok = await ctx.ui.ask('部品の取込', `<p><b>${res.parts.length}件</b>を取り込みます（同じLCSC品番は上書き）。</p>${noFp ? `<p class="warn">うち${noFp}件はフットプリントを推定できませんでした。詳細画面の「編集」で設定してください。</p>` : ''}${cols}${sk}`,
      [{ label: 'キャンセル', value: '' }, { label: '取り込む', value: 'ok', cls: 'primary' }]);
    if (ok !== 'ok') return;
    await ctx.lib.upsert(res.parts);
    ctx.ui.toast(`${res.parts.length}件取り込みました`);
    renderList();
  }

  function exportLib() {
    const parts = ctx.lib.userParts();
    if (!parts.length) { ctx.ui.toast('書き出す部品（取込・登録したもの）がありません'); return; }
    ctx.ui.download(`pocket-eda-library-${new Date().toISOString().slice(0, 10)}.json`, exportLibraryJSON(parts), 'application/json');
  }

  return {
    render,
    action(id) {
      if (id === 'search') { $('#pv-q', root).focus(); }
      if (id === 'import') $('#pv-file', root).click();
      if (id === 'add') editPart();
      if (id === 'export') exportLib();
    },
    showDetail,
    editPart,
    pinTable,
  };
}
