// 「検査」画面（ERC / DRC の実行と結果一覧）
// 結果はプロジェクトの checks.erc / checks.drc に保存し、回路図・PCB が変わったら「古い結果」と表示する。

import { runErc, ercStatus } from './erc.js';
import { runDrc, drcStatus } from './drc.js';
import { runSignals, signalStatus } from './signal.js';
import { log as alog, projectSummary } from '../core/applog.js';
import { drcRules, baseRules, layerCount } from './rules.js';
import { esc } from '../core/util.js';
import { currentSettings, requiredWidthMm, viaCapacityA, layerOz, DEFAULT_TEMP_RISE } from './current.js';
import { isPowerNet } from '../ai/spec.js';
import { copperLayers } from '../pcb/model.js';


const RULE_LABELS = {
  minTrackWidthMm: '最小配線幅', minClearanceMm: '最小間隔（銅どうし）', minPadClearanceMm: '最小間隔（パッド-配線/ビア）',
  boardEdgeClearanceMm: '基板外形と銅', minViaDrillMm: 'ビア最小穴径', minViaDiameterMm: 'ビア最小外径', minViaAnnularMm: 'ビア最小ランド幅',
  minAnnularRingMm: 'スルーホールパッド最小ランド幅', minPthDrillMm: 'スルーホール最小穴径', maxDrillMm: '最大穴径',
  minHoleToHoleMm: '穴どうし（異なるネット）', minSameNetHoleMm: '穴どうし（同じネット）', minThermalSpokes: 'サーマルのスポーク（本）', minNpthToCopperMm: '取付穴と銅', minSilkToPadMm: 'シルクとパッド',
  innerEdgeClearanceMm: '基板外形と銅（内層）', minMaskBridgeMm: 'レジストの最小ブリッジ幅',
  minSilkWidthMm: 'シルク最小線幅', minSilkTextHeightMm: 'シルク文字の最小高さ', maskExpansionMm: 'レジスト開口の広げ幅',
};

/**
 * @param ctx { root, getProject, getPcb, mutate(fn, reason), jump(kind, at), ask, toast, fmtTime }
 */
/** ルール値の単位（名前が Mm で終わるものは mm、ほかは本数） */
const ruleUnit = (k) => (/Mm$/.test(k) ? 'mm' : '');

export function createCheckView(ctx) {
  const st = { tab: 'erc', filter: 'all' };

  function status(kind) {
    const p = ctx.getProject();
    return kind === 'erc' ? ercStatus(p) : kind === 'sig' ? signalStatus(p) : drcStatus(p, ctx.getPcb());
  }

  function run(kind, { quiet = false } = {}) {
    const p = ctx.getProject();
    const r = kind === 'erc' ? runErc(p) : kind === 'sig' ? runSignals(p, ctx.getPcb()) : runDrc(p, ctx.getPcb());
    ctx.mutate((q) => { q.checks = { ...(q.checks || {}), [kind]: r }; }, `check:${kind}`);
    {
      // 検査の結果をログへ（エラーは規則ごとの件数と、最初の数件の内容・位置）
      const errs = r.issues.filter((i) => i.level === 'error');
      const byRule = {};
      for (const i of errs) byRule[i.rule] = (byRule[i.rule] || 0) + 1;
      alog('check', `${{ erc: 'ERC', drc: 'DRC', sig: '信号経路' }[kind]}: エラー ${r.summary.errors}・警告 ${r.summary.warnings}`,
        { ...projectSummary(p), errors: byRule, first: errs.slice(0, 8).map((i) => `${i.message}${i.at ? ` @(${(+i.at.x).toFixed(2)},${(+i.at.y).toFixed(2)})` : ''}`) });
    }
    st.tab = kind;
    render();
    if (!quiet) ctx.toast(`${kind === 'sig' ? '信号経路' : kind.toUpperCase()}: エラー ${r.summary.errors}・警告 ${r.summary.warnings}`);
    return r;
  }

  async function editRules() {
    const p = ctx.getProject();
    const n = layerCount(p);
    const base = baseRules(n), R = drcRules(p);
    const rows = Object.keys(base).map((k) => `<label class="rule-row${R[k] !== base[k] ? ' changed' : ''}"><span>${esc(RULE_LABELS[k] || k)}</span><input type="number" step="${ruleUnit(k) ? '0.001' : '1'}" min="0" inputmode="decimal" data-rule="${k}" value="${R[k]}"><small>${ruleUnit(k) || '本'}</small></label>`).join('');
    const pr = ctx.ask(`DRCルール（${n}層・mm）`, `<p class="note">既定値は JLCPCB ${n >= 4 ? '4・6層' : '1・2層'}標準品の製造能力です。層数を変えると既定値も変わります。変えた値だけを保存します（色付きの行）。</p><div class="rules">${rows}</div>`,
      [{ label: 'キャンセル', value: '' }, { label: '既定に戻す', value: 'reset' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    const inputs = [...document.querySelectorAll('#dialog-body [data-rule]')];
    const r = await pr;
    if (r === 'reset') { ctx.mutate((q) => { q.board.rules = {}; }, 'rules'); ctx.toast('既定のルールに戻しました'); }
    if (r === 'ok') {
      const over = {};
      for (const el of inputs) { const v = Number(el.value); if (Number.isFinite(v) && v >= 0 && v !== base[el.dataset.rule]) over[el.dataset.rule] = v; }
      ctx.mutate((q) => { q.board.rules = over; }, 'rules');
      ctx.toast(Object.keys(over).length ? `変えた値 ${Object.keys(over).length} 件を保存しました` : '既定値のままです');
    }
    render();
  }

  // ネットごとの最大電流（配線幅の検査と自動配線の線幅に使う）
  async function editCurrent() {
    const p = ctx.getProject(), pcb = ctx.getPcb();
    const s = currentSettings(p);
    const nets = [...new Set([...(pcb?.tracks || []).map((t) => t.net), ...(p.netlist?.nets || []).map((n) => n.name)].filter(Boolean))].sort();
    const shown = [...new Set([...Object.keys(s.nets), ...nets.filter((n) => isPowerNet(n))])];
    const inner = (pcb ? copperLayers(pcb) : []).some((l) => l !== 'F.Cu' && l !== 'B.Cu');
    const fmt = (v) => (Math.round(v * 1000) / 1000).toString();
    const widths = (I, dT) => {
      if (!(I > 0)) return '—';
      const o = requiredWidthMm(I, { oz: layerOz(p, 'F.Cu'), tempRiseC: dT });
      const i = inner ? requiredWidthMm(I, { internal: true, oz: layerOz(p, 'In1.Cu'), tempRiseC: dT }) : 0;
      return `外層 ${fmt(o)}mm${inner ? `・内層 ${fmt(i)}mm` : ''}`;
    };
    const row = (n) => `<label class="rule-row current-row${s.nets[n] ? ' changed' : ''}"><span>${esc(n)}<br><small data-w="${esc(n)}">${widths(s.nets[n], s.tempRiseC)}</small></span><input type="number" step="0.01" min="0" inputmode="decimal" data-net="${esc(n)}" value="${s.nets[n] ?? ''}" placeholder="—"><small>A</small></label>`;
    const others = nets.filter((n) => !shown.includes(n));
    const via = pcb?.vias?.length ? Math.min(...pcb.vias.map((v) => v.drill)) / 1e6 : (p.pcb?.settings?.viaDrill || 300000) / 1e6;
    const pr = ctx.ask('電流と配線幅', `<p class="note">ネットに流れる最大の電流を入れると、必要な配線幅を IPC-2221 の近似式で求め、DRC で細い配線を知らせます。自動配線もこの幅で引きます。空欄のネットは検査しません。銅厚は製造仕様（外層 ${layerOz(p, 'F.Cu')}oz${inner ? `・内層 ${layerOz(p, 'In1.Cu')}oz` : ''}）です。</p>
      <label class="rule-row"><span>許す温度上昇</span><input type="number" step="1" min="1" inputmode="decimal" data-trise value="${s.tempRiseC}"><small>℃</small></label>
      <p class="note">ビア1本（穴 ${fmt(via)}mm）の目安: <b data-via>${fmt(viaCapacityA(via, { tempRiseC: s.tempRiseC }))}</b>A</p>
      <div class="rules" id="current-rows">${shown.map(row).join('') || '<p class="note">電源のネットがありません。下から追加してください。</p>'}</div>
      ${others.length ? `<label class="field"><span>ネットを追加</span><select data-add><option value="">（選ぶ）</option>${others.map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>` : ''}`,
      [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    const body = document.querySelector('#dialog-body');
    const dT = () => Number(body.querySelector('[data-trise]').value) || DEFAULT_TEMP_RISE;
    const refresh = () => {
      body.querySelectorAll('[data-net]').forEach((el) => { const w = body.querySelector(`[data-w="${CSS.escape(el.dataset.net)}"]`); if (w) w.textContent = widths(Number(el.value), dT()); });
      body.querySelector('[data-via]').textContent = fmt(viaCapacityA(via, { tempRiseC: dT() }));
    };
    body.addEventListener('input', refresh);
    body.querySelector('[data-add]')?.addEventListener('change', (e) => {
      const n = e.target.value; if (!n) return;
      body.querySelector('#current-rows').insertAdjacentHTML('beforeend', row(n));
      e.target.querySelector(`option[value="${CSS.escape(n)}"]`)?.remove(); e.target.value = '';
    });
    const r = await pr;
    if (r !== 'ok') return;
    const netsOut = {};
    body.querySelectorAll('[data-net]').forEach((el) => { const v = Number(el.value); if (el.value !== '' && v > 0) netsOut[el.dataset.net] = v; });
    ctx.mutate((q) => { q.board.current = { tempRiseC: dT(), nets: netsOut }; }, 'current');
    ctx.toast(`電流を ${Object.keys(netsOut).length} ネットに設定しました。DRC を実行すると配線幅を検査します`);
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
      <div class="check-card-actions"><button class="btn primary" data-run="${kind}">${r ? '再実行' : '実行'}</button>${kind === 'drc' ? '<button class="btn" data-rules>ルール</button><button class="btn" data-current>電流</button>' : ''}</div>
    </div>`;
  }

  function issueList(r) {
    const s = status(st.tab);
    const list = r.issues.filter((i) => st.filter === 'all' || i.level === st.filter);
    const where = st.tab === 'drc' ? 'PCB' : '回路図';
    const items = list.map((i, k) => `<li class="issue ${i.level}">
        <span class="lv">${i.level === 'error' ? '✕' : i.level === 'info' ? 'i' : '!'}</span>
        <span class="msg">${esc(i.message)}</span>
        ${i.at && s !== 'stale' ? `<button class="btn small-btn" data-jump="${r.issues.indexOf(i)}" aria-label="${where}で表示">表示</button>` : ''}
      </li>`).join('');
    const filt = (v, l, n) => `<button class="chip${st.filter === v ? ' on' : ''}" data-filter="${v}">${l} ${n}</button>`;
    return `<div class="chips">${filt('all', 'すべて', r.issues.length)}${filt('error', 'エラー', r.summary.errors)}${filt('warning', '警告', r.summary.warnings)}${r.summary.infos != null ? filt('info', 'お知らせ', r.summary.infos) : ''}</div>` +
      (list.length ? `<ul class="issues">${items}</ul>` : `<p class="ok">✓ ${st.filter === 'all' ? '指摘はありません' : '該当なし'}（下の「検査した項目」の範囲で）</p>`);
  }

  /** 信号経路の一覧（入口 → 出口） */
  function chainList(r) {
    const mark = { ok: '<span class="ok">✓</span>', warning: '<b class="warn">!</b>', error: '<b class="err">✕</b>' };
    return `<ul class="chains">${r.chains.map((c) => `<li class="chain ${c.status}"><div>${mark[c.status] || ''} <b>${esc(c.title)}</b></div><small>${c.path.map(esc).join(' → ')}</small></li>`).join('') || '<li>音声・USB の信号が見つかりません</li>'}</ul>`;
  }

  function coverage(r) {
    const checked = r.checked.map((c) => `<li><span>${c.count ? `<b class="${r.issues.some((i) => i.rule === c.id && i.level === 'error') ? 'err' : 'warn'}">${c.count}件</b>` : '<span class="ok">✓</span>'}</span>${esc(c.label)}</li>`).join('');
    const un = r.unchecked.map((u) => `<li>${esc(u)}</li>`).join('');
    const rules = st.tab === 'drc' && r.rules ? `<details><summary>使ったルール値</summary><ul class="cover">${Object.keys(r.rules).map((k) => `<li><span>${r.rules[k]}${ruleUnit(k) || '本'}</span>${esc(RULE_LABELS[k] || k)}</li>`).join('')}</ul></details>` : '';
    return `<details open><summary>検査した項目（${r.checked.length}）</summary><ul class="cover">${checked}</ul></details>
      <details open><summary>検査していない項目（${r.unchecked.length}）</summary><ul class="uncovered">${un}</ul></details>${rules}`;
  }

  function render() {
    const p = ctx.getProject();
    if (!p) { ctx.root.innerHTML = ''; return; }
    const r = p.checks?.[st.tab];
    ctx.root.innerHTML = `<div class="check-wrap">
      <div class="check-cards">${summaryCard('erc', 'ERC 電気的ルール', '回路図の未接続ピン・電源・出力の衝突などを検査します')}${summaryCard('drc', 'DRC 基板設計ルール', 'PCB の間隔・配線幅・穴・未配線・シルクなどを検査します')}${summaryCard('sig', '信号経路（USB・I2S・アナログ音声）', '信号が種類ごとに正しく受け渡され、目的の出力まで届くか（左右・極性・設定ピン・フィルター・レベル）を検査します')}</div>
      <h3>${{ erc: 'ERC', drc: 'DRC', sig: '信号経路' }[st.tab]} の結果</h3>
      ${r ? (st.tab === 'sig' ? chainList(r) : '') + issueList(r) + coverage(r) : `<p class="note">まだ実行していません。上の「実行」を押してください。</p>`}
    </div>`;
    ctx.root.querySelectorAll('[data-run]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); run(b.dataset.run); }; });
    ctx.root.querySelector('[data-rules]')?.addEventListener('click', (e) => { e.stopPropagation(); editRules(); });
    ctx.root.querySelector('[data-current]')?.addEventListener('click', (e) => { e.stopPropagation(); editCurrent(); });
    ctx.root.querySelectorAll('[data-tab]').forEach((c) => { c.onclick = () => { st.tab = c.dataset.tab; st.filter = 'all'; render(); }; });
    ctx.root.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { st.filter = b.dataset.filter; render(); }; });
    ctx.root.querySelectorAll('[data-jump]').forEach((b) => {
      b.onclick = () => { const i = r.issues[Number(b.dataset.jump)]; ctx.jump(st.tab === 'drc' ? 'pcb' : 'schematic', i.at, i.message); };
    });
  }

  return {
    render,
    run,
    editRules,
    editCurrent,
    setTab(t) { st.tab = t; st.filter = 'all'; render(); },
    get tab() { return st.tab; },
  };
}
