// 「検査」画面（ERC / DRC の実行と結果一覧）
// 結果はプロジェクトの checks.erc / checks.drc に保存し、回路図・PCB が変わったら「古い結果」と表示する。

import { runErc, ercStatus } from './erc.js';
import { runDrc, drcStatus, drcRules, DRC_DEFAULTS } from './drc.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RULE_LABELS = {
  minTrackWidthMm: '最小配線幅', minClearanceMm: '最小間隔（銅どうし）', minPadClearanceMm: '最小間隔（パッド-配線/ビア）',
  boardEdgeClearanceMm: '基板外形と銅', minViaDrillMm: 'ビア最小穴径', minViaDiameterMm: 'ビア最小外径', minViaAnnularMm: 'ビア最小ランド幅',
  minAnnularRingMm: 'スルーホールパッド最小ランド幅', minPthDrillMm: 'スルーホール最小穴径', maxDrillMm: '最大穴径',
  minHoleToHoleMm: '穴どうし（異なるネット）', minNpthToCopperMm: '取付穴と銅', minSilkToPadMm: 'シルクとパッド',
};

/**
 * @param ctx { root, getProject, getPcb, mutate(fn, reason), jump(kind, at), ask, toast, fmtTime }
 */
export function createCheckView(ctx) {
  const st = { tab: 'erc', filter: 'all' };

  function status(kind) {
    const p = ctx.getProject();
    return kind === 'erc' ? ercStatus(p) : drcStatus(p, ctx.getPcb());
  }

  function run(kind) {
    const p = ctx.getProject();
    const r = kind === 'erc' ? runErc(p) : runDrc(p, ctx.getPcb());
    ctx.mutate((q) => { q.checks = { ...(q.checks || {}), [kind]: r }; }, `check:${kind}`);
    st.tab = kind;
    render();
    ctx.toast(`${kind.toUpperCase()}: エラー ${r.summary.errors}・警告 ${r.summary.warnings}`);
    return r;
  }

  async function editRules() {
    const p = ctx.getProject();
    const R = drcRules(p);
    const rows = Object.keys(DRC_DEFAULTS).map((k) => `<label class="rule-row"><span>${esc(RULE_LABELS[k] || k)}</span><input type="number" step="0.001" min="0" inputmode="decimal" data-rule="${k}" value="${R[k]}"><small>mm</small></label>`).join('');
    const pr = ctx.ask('DRCルール（mm）', `<p class="note">既定値は JLCPCB 1〜2層標準品の製造能力に合わせています。発注先の仕様に合わせて変更してください。</p><div class="rules">${rows}</div>`,
      [{ label: 'キャンセル', value: '' }, { label: '既定に戻す', value: 'reset' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    const inputs = [...document.querySelectorAll('#dialog-body [data-rule]')];
    const r = await pr;
    if (r === 'reset') { ctx.mutate((q) => { q.board.rules = { ...q.board.rules, ...DRC_DEFAULTS }; }, 'rules'); ctx.toast('既定のルールに戻しました'); }
    if (r === 'ok') {
      const vals = {};
      for (const el of inputs) { const v = Number(el.value); if (Number.isFinite(v) && v >= 0) vals[el.dataset.rule] = v; }
      ctx.mutate((q) => { q.board.rules = { ...q.board.rules, ...vals }; }, 'rules');
      ctx.toast('ルールを保存しました');
    }
    render();
  }

  function summaryCard(kind, title, desc) {
    const p = ctx.getProject();
    const r = p.checks?.[kind];
    const s = status(kind);
    const badge = s === 'none' ? '<span class="badge planned">未実行</span>'
      : s === 'stale' ? '<span class="badge partial">古い結果</span>'
      : r.summary.errors ? `<span class="badge err">エラー ${r.summary.errors}</span>` : '<span class="badge ready">エラーなし</span>';
    const meta = r ? `<small>${esc(ctx.fmtTime(r.ranAt))} 実行・エラー ${r.summary.errors}・警告 ${r.summary.warnings}${s === 'stale' ? '<br><b class="warn">実行後に変更されています。もう一度実行してください</b>' : ''}</small>` : `<small>${esc(desc)}</small>`;
    return `<div class="check-card${st.tab === kind ? ' on' : ''}" data-tab="${kind}">
      <div class="check-card-head"><b>${title}</b>${badge}</div>${meta}
      <div class="check-card-actions"><button class="btn primary" data-run="${kind}">${r ? '再実行' : '実行'}</button>${kind === 'drc' ? '<button class="btn" data-rules>ルール</button>' : ''}</div>
    </div>`;
  }

  function issueList(r) {
    const s = status(st.tab);
    const list = r.issues.filter((i) => st.filter === 'all' || i.level === st.filter);
    const where = st.tab === 'erc' ? '回路図' : 'PCB';
    const items = list.map((i, k) => `<li class="issue ${i.level}">
        <span class="lv">${i.level === 'error' ? '✕' : '!'}</span>
        <span class="msg">${esc(i.message)}</span>
        ${i.at && s !== 'stale' ? `<button class="btn small-btn" data-jump="${r.issues.indexOf(i)}" aria-label="${where}で表示">表示</button>` : ''}
      </li>`).join('');
    const filt = (v, l, n) => `<button class="chip${st.filter === v ? ' on' : ''}" data-filter="${v}">${l} ${n}</button>`;
    return `<div class="chips">${filt('all', 'すべて', r.issues.length)}${filt('error', 'エラー', r.summary.errors)}${filt('warning', '警告', r.summary.warnings)}</div>` +
      (list.length ? `<ul class="issues">${items}</ul>` : `<p class="ok">✓ ${st.filter === 'all' ? '指摘はありません' : '該当なし'}（下の「検査した項目」の範囲で）</p>`);
  }

  function coverage(r) {
    const checked = r.checked.map((c) => `<li><span>${c.count ? `<b class="${r.issues.some((i) => i.rule === c.id && i.level === 'error') ? 'err' : 'warn'}">${c.count}件</b>` : '<span class="ok">✓</span>'}</span>${esc(c.label)}</li>`).join('');
    const un = r.unchecked.map((u) => `<li>${esc(u)}</li>`).join('');
    const rules = st.tab === 'drc' && r.rules ? `<details><summary>使ったルール値</summary><ul class="cover">${Object.keys(DRC_DEFAULTS).map((k) => `<li><span>${r.rules[k]}mm</span>${esc(RULE_LABELS[k] || k)}</li>`).join('')}</ul></details>` : '';
    return `<details open><summary>検査した項目（${r.checked.length}）</summary><ul class="cover">${checked}</ul></details>
      <details open><summary>検査していない項目（${r.unchecked.length}）</summary><ul class="uncovered">${un}</ul></details>${rules}`;
  }

  function render() {
    const p = ctx.getProject();
    if (!p) { ctx.root.innerHTML = ''; return; }
    const r = p.checks?.[st.tab];
    ctx.root.innerHTML = `<div class="check-wrap">
      <div class="check-cards">${summaryCard('erc', 'ERC 電気的ルール', '回路図の未接続ピン・電源・出力の衝突などを検査します')}${summaryCard('drc', 'DRC 基板設計ルール', 'PCB の間隔・配線幅・穴・未配線・シルクなどを検査します')}</div>
      <h3>${st.tab === 'erc' ? 'ERC' : 'DRC'} の結果</h3>
      ${r ? issueList(r) + coverage(r) : `<p class="note">まだ実行していません。上の「実行」を押してください。</p>`}
    </div>`;
    ctx.root.querySelectorAll('[data-run]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); run(b.dataset.run); }; });
    ctx.root.querySelector('[data-rules]')?.addEventListener('click', (e) => { e.stopPropagation(); editRules(); });
    ctx.root.querySelectorAll('[data-tab]').forEach((c) => { c.onclick = () => { st.tab = c.dataset.tab; st.filter = 'all'; render(); }; });
    ctx.root.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { st.filter = b.dataset.filter; render(); }; });
    ctx.root.querySelectorAll('[data-jump]').forEach((b) => {
      b.onclick = () => { const i = r.issues[Number(b.dataset.jump)]; ctx.jump(st.tab === 'erc' ? 'schematic' : 'pcb', i.at, i.message); };
    });
  }

  return {
    render,
    run,
    editRules,
    setTab(t) { st.tab = t; st.filter = 'all'; render(); },
    get tab() { return st.tab; },
  };
}
