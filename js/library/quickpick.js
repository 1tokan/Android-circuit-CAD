// 回路図の部品に LCSC 品番を割り当てる近道（0.13.3）
//  - 部品の種別・値・形（フットプリント）から検索語を作り、保存済みの部品と jlcsearch を同時に探す
//  - 同じ種別・同じ形・Basic・在庫ありを上に並べ、1 回触れれば割り当てる（同じ値・同じ形のほかの部品にもまとめて）
//  - 「品番なしをまとめて」: 品番の無い部品を（種別・値・形）の組ごとに順に割り当てる
// 部品を選ぶ → 「品番」→ 候補に触れる、の 3 手（以前は 属性 → ライブラリから選ぶ → 部品画面で入力 → オンライン検索 → 詳細 → 保存 → 割り当て）

import { getFootprint } from './footprints.js';
import { unitPrice, normalizeValue } from './parts.js';
import { kindInfo } from '../schematic/symbols.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** フットプリントの ID → 検索に使う形の名前（R_0805 → 0805, SOT-223-3_TabPin2 → SOT-223） */
export function packageOf(footprint) {
  const f = String(footprint || '');
  const size = f.match(/(?:^|_)(0201|0402|0603|0805|1206|1210|2010|2512)(?:_|$)/)?.[1];
  if (size) return size;
  if (/^SOT-223/.test(f)) return 'SOT-223';
  if (/^SOT-23-?([56])/.test(f)) return `SOT-23-${f.match(/^SOT-23-?([56])/)[1]}`;
  if (/^SOT-23/.test(f)) return 'SOT-23';
  if (/^D_(SMA|SMB|SMC)$/.test(f)) return f.slice(2);
  if (/^D_SOD-/.test(f)) return f.slice(2);
  if (/^Crystal_SMD_3225/.test(f)) return '3225';
  if (f === 'TO-269AA') return 'MBS';
  if (/^(SOIC|TSSOP|DIP)-\d+$/.test(f)) return f;
  return '';
}

/** 部品（回路図）→ 検索語 */
export function queryFor(c) {
  const v = String(c.props?.value || '').trim();
  const pkg = packageOf(c.props?.footprint);
  const j = (...xs) => xs.filter(Boolean).join(' ');
  switch (c.kind) {
    case 'resistor': return j(v, pkg);
    case 'capacitor': case 'electrolytic': return j(/[pnum]$/i.test(v) ? `${v}F` : v, pkg);
    case 'inductor': return j(/[nmu]$/i.test(v) ? `${v}H` : v, pkg);
    case 'led': return j('LED', v, pkg);
    case 'ferrite': return j('ferrite bead', v.replace(/R@.*$/i, 'Ω').replace(/@.*/, ''), pkg);
    case 'fuse': return j('fuse', v, pkg);
    case 'thermistor': return j('NTC', v, pkg);
    case 'crystal': return j(v, pkg);
    case 'buzzer': return j('buzzer', v === 'Buzzer' ? '' : v);
    case 'speaker': return j('speaker', v);
    case 'testpoint': return 'test point';
    case 'transformer': return j('transformer', v);
    default: return v;
  }
}

// 部品の種別どうしの近さ（LCSC の分類から推定した種別が、回路図の種別と少し違うことがある）
const NEAR = {
  thermistor: ['resistor'], ferrite: ['inductor'], schottky: ['diode'], tvs: ['diode', 'zener'], zener: ['diode', 'tvs'], diode: ['schottky', 'zener'],
  regulator: ['ic'], optocoupler: ['ic'], crystal: ['ic'], electrolytic: ['capacitor'], capacitor: ['electrolytic'], speaker: ['buzzer', 'connector'],
};

/** 候補の点数（高いほど上） */
export function scorePart(p, c) {
  let s = 0;
  if (p.kind === c.kind) s += 4; else if (NEAR[c.kind]?.includes(p.kind)) s += 2;
  const pkg = packageOf(c.props?.footprint);
  if (pkg && (String(p.package || '').toUpperCase().includes(pkg.toUpperCase()) || packageOf(p.footprint) === pkg)) s += 2;
  const v = normalizeValue(String(c.props?.value || ''));
  if (v && (normalizeValue(String(p.value || '')) === v || String(p.mpn || '').toUpperCase() === String(c.props?.value || '').toUpperCase())) s += 2;
  if (p.jlc?.type === 'basic') s += 1.5; else if (p.jlc?.type === 'preferred') s += 1;
  if (p.stock > 0) s += 1; else if (p.stock == null) s += 0.3;
  return s;
}

export function rankParts(parts, c) {
  const price = (p) => unitPrice(p, 10) ?? Infinity;
  return [...parts].map((p) => ({ p, s: scorePart(p, c) })).sort((a, b) => b.s - a.s || price(a.p) - price(b.p)).map((x) => x.p);
}

/** 同じ種別・値・形で、まだ品番の無い部品（まとめて割り当てる相手） */
export function siblingsOf(sheet, c) {
  const key = (x) => `${x.kind}|${String(x.props?.value || '').trim().toLowerCase()}|${x.props?.footprint || ''}`;
  return sheet.components.filter((x) => x.id !== c.id && key(x) === key(c) && !x.props?.lcsc && !x.props?.partId);
}

/** 品番の無い部品の組（種別・値・形ごと。実装しない部品・電源記号・シミュ用は除く） */
export function missingGroups(sheet) {
  const groups = new Map();
  for (const c of sheet.components) {
    const info = kindInfo(c.kind);
    if (!info || info.power || info.virtual || c.kind === 'testpoint' || c.props?.dnp || c.props?.lcsc || c.props?.partId) continue; // テストポイントは部品でなくパッド
    const k = `${c.kind}|${String(c.props?.value || '').trim().toLowerCase()}|${c.props?.footprint || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups.values()];
}

/** 選んだ候補 → 割り当てに使う部品データ（回路図の種別を変えない。足形が分からなければ今のまま） */
export function partForComp(p, c) {
  const keepKind = !['ic', 'connector'].includes(c.kind) || !['ic', 'connector'].includes(p.kind);
  const out = { ...p };
  if (keepKind && p.kind !== c.kind) { out.kind = c.kind; out.symbol = {}; out.pinMap = null; }
  if (!getFootprint(out.footprint) && c.props?.footprint) out.footprint = c.props.footprint;
  return out;
}

/**
 * 品番を選ぶ画面
 * @param ctx { lib, online, ui:{ask,toast}, sheet(), assign(keys, part) }
 * @param comps 回路図の部品（先頭の部品で探す。全部に同じ品番を割り当てる）
 * @param opt { step: '2/7', batch: true }
 * @returns 'ok' | 'skip' | ''（やめる）
 */
export async function pickLcsc(ctx, comps, opt = {}) {
  const c = comps[0];
  const sibs = opt.batch ? [] : siblingsOf(ctx.sheet(), c);
  const st = { q: queryFor(c), local: [], online: null, err: '', loading: false };
  const refs = comps.map((x) => x.ref).join('・');
  const dlg = document.querySelector('#dialog');
  const body = () => document.querySelector('#dialog-body');
  const row = (p, key) => {
    const price = unitPrice(p, 10);
    const near = p.kind === c.kind ? '' : `<span class="badge planned">${esc(kindInfo(p.kind)?.label || p.kind)}</span>`;
    return `<button type="button" class="qp-row" data-key="${key}">
      <span class="qp-main"><b>${esc(p.lcsc || '品番なし')}</b> ${esc(p.mpn || p.name)}</span>
      <span class="qp-sub">${p.jlc?.type === 'basic' ? '<span class="badge ready">Basic</span>' : p.jlc?.type === 'preferred' ? '<span class="badge ready">Preferred</span>' : p.jlc?.type === 'extended' ? '<span class="badge planned">Extended</span>' : ''}${near}
        <span>${esc(p.package || '-')}</span>${p.stock != null ? `<span>在庫 ${Number(p.stock).toLocaleString()}</span>` : ''}${price != null ? `<span>$${price.toFixed(4)}</span>` : ''}</span>
      <span class="qp-desc">${esc(String(p.specs?.['カテゴリ'] || p.name || '').slice(0, 80))}</span>
    </button>`;
  };
  const listHtml = () => {
    const local = rankParts(st.local, c).slice(0, 6);
    const online = st.online ? rankParts(st.online, c).slice(0, 20) : [];
    return `${local.length ? `<div class="qp-h">保存済み</div>${local.map((p) => row(p, `L:${p.id}`)).join('')}` : ''}
      <div class="qp-h">LCSC（jlcsearch・非公式）</div>
      ${st.loading ? '<p class="note qp-loading">探しています…</p>' : st.err ? `<p class="warn">${esc(st.err)}</p>` : st.online && !online.length ? '<p class="note">見つかりませんでした。検索語を変えてください（型番・値と形 例: 10k 0603）。</p>' : online.map((p, i) => row(p, `O:${i}`)).join('')}`;
  };
  const renderList = () => {
    const el = body()?.querySelector('.qp-list');
    if (!el) return;
    el.innerHTML = listHtml();
    el.querySelectorAll('[data-key]').forEach((b) => { b.onclick = () => dlg.close(b.dataset.key); });
  };
  const searchLocal = () => {
    const a = ctx.lib.search(st.q, {}, 12)?.items || [];
    const b = ctx.lib.search(String(c.props?.value || ''), { kind: c.kind }, 12)?.items || [];
    const seen = new Set();
    st.local = [...a, ...b].filter((p) => p.lcsc && !seen.has(p.id) && seen.add(p.id));
  };
  let seq = 0;
  const searchOnline = async () => {
    const my = ++seq;
    st.loading = true; st.err = ''; renderList();
    try {
      const r = await ctx.online.search(st.q, { limit: 30 });
      if (my !== seq) return;
      st.online = r.parts;
    } catch (e) {
      if (my !== seq) return;
      st.online = [];
      st.err = `オンライン検索できませんでした（${e.message || e}）。保存済みの部品からは選べます。`;
    }
    st.loading = false;
    renderList();
  };
  searchLocal();
  const html = `<div class="qp">
    <p class="note">${esc(refs)}（${esc(kindInfo(c.kind)?.label || c.kind)}・${esc(c.props?.value || '')}${packageOf(c.props?.footprint) ? `・${esc(packageOf(c.props.footprint))}` : ''}）${opt.step ? ` <b>${esc(opt.step)}</b>` : ''}</p>
    <div class="qp-search"><input type="search" class="qp-q" value="${esc(st.q)}" enterkeyhint="search" aria-label="検索語"><button type="button" class="btn qp-go">探す</button></div>
    ${sibs.length ? `<label class="field check"><input type="checkbox" class="qp-sibs" checked> 同じ値・同じ形の ${esc(sibs.map((x) => x.ref).join('・'))} にも（${sibs.length} 個）</label>` : ''}
    <div class="qp-list"></div>
    <p class="note">触れると割り当てます。品番・足形・ピン対応は部品データに保存され、ほかの回路でも使えます。価格・在庫は検索した時点のものです。</p></div>`;
  const buttons = opt.batch ? [{ label: 'やめる', value: '' }, { label: 'とばす', value: 'skip' }] : [{ label: 'キャンセル', value: '' }];
  const p = ctx.ui.ask(`LCSC 品番: ${refs.length > 24 ? `${refs.slice(0, 24)}…` : refs}`, html, buttons);
  // ダイアログの中身は <form method="dialog"> の中なので、form は入れ子にできない（Enter で閉じないように止める）
  const qIn = body().querySelector('.qp-q');
  const go = () => { st.q = qIn.value.trim(); searchLocal(); searchOnline(); };
  body().querySelector('.qp-go').addEventListener('click', (e) => { e.preventDefault(); go(); });
  qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  renderList();
  searchOnline();
  const key = await p;
  seq++; // 閉じた後の応答は捨てる
  if (!key || key === 'skip') return key;
  const withSibs = !!body()?.querySelector('.qp-sibs')?.checked;
  let part = key.startsWith('L:') ? ctx.lib.get(key.slice(2)) : rankParts(st.online || [], c).slice(0, 20)[Number(key.slice(2))];
  if (!part) return '';
  const fitted = partForComp(part, c);
  // オンラインの候補・種別や足形を合わせた候補は部品データとして保存（同じ品番は上書き）。保存済みでそのまま使えるものは保存し直さない
  // 種別・足形を合わせて変えたときは、元の部品データ（ピン対応など）を上書きしないよう別の ID で保存する
  const changed = fitted.kind !== part.kind || fitted.footprint !== part.footprint;
  if (changed && (key.startsWith('L:') || ctx.lib.get(part.id))) fitted.id = `${part.id}~${c.kind}${fitted.footprint ? `~${fitted.footprint}` : ''}`;
  const stored = key.startsWith('L:') && !changed ? part : (await ctx.lib.upsert([fitted]))[0];
  const targets = [...comps, ...(withSibs ? sibs : [])];
  ctx.assign(targets.map((x) => `c:${x.id}`), stored);
  ctx.ui.toast(`${targets.map((x) => x.ref).join('・')} に ${stored.lcsc}（${stored.mpn || stored.name}）を割り当てました`);
  return 'ok';
}

/** 品番の無い部品を組ごとに順に割り当てる */
export async function pickAllMissing(ctx) {
  const groups = missingGroups(ctx.sheet());
  if (!groups.length) { ctx.ui.toast('品番の無い部品はありません'); return 0; }
  let done = 0;
  for (let i = 0; i < groups.length; i++) {
    // 前の組の割り当てで変わっていることがあるので、今の回路図から取り直す
    const live = groups[i].map((g) => ctx.sheet().components.find((x) => x.id === g.id)).filter((x) => x && !x.props?.lcsc && !x.props?.partId);
    if (!live.length) continue;
    const r = await pickLcsc(ctx, live, { batch: true, step: `${i + 1}/${groups.length} 組目` });
    if (r === '') break;
    if (r === 'ok') done += live.length;
  }
  return done;
}
