// 「シミュレーション」画面（KiCad の回路シミュレータに相当）
//  解析（動作点・直流スイープ・AC・過渡）の設定 → 実行 → グラフ（信号の選択・カーソル・測定・FFT）・動作点の表
//  信号源（ネットとネットの間）・部品ごとのモデル・SPICE ライブラリ・チューニング（値を動かして再計算）・SPICE ネットリストの書き出し

import { esc } from '../core/util.js';
import { simSettings, buildCircuit, exportSpice, SIM_KINDS, GROUND, defaultPins } from './circuit.js';
import { runSimulation } from './run.js';
import { builtinChoices } from './models.js';
import { formatValue, parseValue } from './units.js';
import { sourceFormHtml, bindSourceForm, readSourceForm, sourceFromSpice, sourceToSpice, sourceSummary } from './waveform.js';
import { plotSvg, plotXAt, plotPxAt, moveCursor, valueAt, measure, fft, COLORS } from './plot.js';

const TYPES = [['op', '動作点'], ['dc', '直流スイープ'], ['ac', 'AC（周波数特性）'], ['tran', '過渡（時間波形）']];
const unitOf = (name) => (name.startsWith('V(') ? 'V' : 'A');
const inner = (name) => name.replace(/^[VI]\((.*)\)$/, '$1');
// グラフの段（量ごとに分ける。上から この順）
const PANELS = {
  V: { title: '電圧', unit: 'V' }, I: { title: '電流', unit: 'A' },
  VdB: { title: '電圧の大きさ', unit: 'dB' }, IdB: { title: '電流の大きさ', unit: 'dB' },
  Vmag: { title: '電圧の大きさ（倍）', unit: '' }, Imag: { title: '電流の大きさ（倍）', unit: '' },
  ph: { title: '位相', unit: '°' }, Vfft: { title: 'FFT 電圧', unit: 'dB' }, Ifft: { title: 'FFT 電流', unit: 'dB' },
};

export function createSimView(ctx) {
  const st = { result: null, running: false, stop: false, cursor: null, cursor2: null, xRange: null, acView: 'db', fft: null, tune: null, error: '', progress: 0 };
  let drag = null; // カーソルのドラッグ中の状態（下の「カーソルのドラッグ」）
  const P = () => ctx.getProject();
  const S = () => simSettings(P());
  const save = (fn, reason = 'sim') => ctx.mutate((p) => { p.sim = simSettings(p); fn(p.sim); }, reason);

  function netNames() {
    const nl = ctx.getNetlist();
    return [...new Set([GROUND, ...nl.nets.map((n) => n.name)])].sort((a, b) => (b === GROUND) - (a === GROUND) || a.localeCompare(b));
  }

  // ---------------- 実行 ----------------
  async function run(extra = {}) {
    if (st.running) { st.stop = true; return; }
    st.running = true; st.stop = false; st.error = ''; st.progress = 0; st.fft = null;
    render();
    try {
      const r = await runSimulation(P(), { netlist: ctx.getNetlist(), override: extra.override, onProgress: (f) => { st.progress = f; const el = ctx.root.querySelector('.sim-progress'); if (el) el.textContent = `計算中… ${Math.round(f * 100)}%（もう一度押すと中止）`; }, shouldStop: () => st.stop });
      st.result = r;
      if (!extra.keepView) { st.cursor = null; st.cursor2 = null; st.xRange = null; }
      // 信号を選んでいなければ、ネットの電圧を最大 3 本
      const s = S();
      if (!s.probes.some((p) => r.names.includes(p))) {
        const pick = r.names.filter((n) => n.startsWith('V(')).slice(0, 3);
        save((sim) => { sim.probes = pick; }, 'sim:probes');
      }
      ctx.log?.('sim', `シミュレーション ${r.type}: ${r.ms}ms`, { warnings: r.warnings.length });
    } catch (e) {
      st.error = e.message || String(e);
      ctx.log?.('sim', `シミュレーションの失敗: ${st.error}`);
    }
    st.running = false;
    render();
  }

  // ---------------- 設定の画面 ----------------
  function analysisForm(s) {
    const a = s.analysis, f = (k, sub, label, ph = '') => `<label class="field small"><span>${label}</span><input type="text" data-an="${k}.${sub}" value="${esc(a[k][sub] ?? '')}" placeholder="${ph}"></label>`;
    const srcOpts = (sel) => `<option value="">（選ぶ）</option>${[...schSources().map((x) => x.ref), ...s.sources.map((x) => x.name)].map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
    if (a.type === 'op') return '<p class="note">直流の動作点（各ネットの電圧・部品の電流と消費電力）を求めます。コンデンサは開放、インダクタは短絡として計算します。</p>';
    if (a.type === 'dc') return `<div class="form-row"><label class="field small"><span>信号源</span><select data-an="dc.src">${srcOpts(a.dc.src)}</select></label>${f('dc', 'start', '開始', '0')}${f('dc', 'stop', '終了', '5')}${f('dc', 'step', '刻み', '0.05')}</div>
      <div class="form-row"><label class="field small"><span>2 つ目（任意）</span><select data-an="dc.src2">${srcOpts(a.dc.src2)}</select></label>${f('dc', 'start2', '開始')}${f('dc', 'stop2', '終了')}${f('dc', 'step2', '刻み')}</div>`;
    if (a.type === 'ac') return `<div class="form-row"><label class="field small"><span>目盛り</span><select data-an="ac.scale">${['dec', 'oct', 'lin'].map((x) => `<option value="${x}" ${a.ac.scale === x ? 'selected' : ''}>${{ dec: '10 倍ごと', oct: '2 倍ごと', lin: '等間隔' }[x]}</option>`).join('')}</select></label>${f('ac', 'points', a.ac.scale === 'lin' ? '点の数' : '点の数（1 区間）', '20')}${f('ac', 'fstart', '開始 Hz', '10')}${f('ac', 'fstop', '終了 Hz', '1M')}</div>
      <p class="note">信号源の「AC」の大きさ（ふつう 1）を入れた源からの伝達を計算します（動作点で線形化した小信号）。</p>`;
    return `<div class="form-row">${f('tran', 'tstep', '刻み（目安）', '10u')}${f('tran', 'tstop', '終了時刻', '10m')}${f('tran', 'tstart', '記録の開始', '0')}${f('tran', 'tmax', '最大の刻み（任意）', '')}</div>
      <label class="field check"><input type="checkbox" data-an="tran.uic" ${a.tran.uic ? 'checked' : ''}> 動作点を求めずに 0V から始める（UIC。コンデンサの初期電圧はモデルの設定で）</label>`;
  }

  /** 回路図に置いた信号源（交流電源・直流電源・電流源） */
  const schSources = () => { try { return ctx.getNetlist()?.simSources || []; } catch { return []; } };

  function sourcesHtml(s) {
    const sch = schSources();
    const sum = (x) => { try { return sourceSummary(sourceFromSpice(x.value, x.kind === 'isrc' ? 'I' : 'V'), x.kind === 'isrc' ? 'A' : 'V'); } catch { return x.value; } };
    const schHtml = sch.length ? `<p class="note">回路図の信号源（触れると電圧・周波数などを変えられます）</p><ul class="sim-list">${sch.map((x) => `<li><button type="button" class="link" data-schsrc="${esc(x.ref)}"><b>${esc(x.ref)}</b> ${x.kind === 'isrc' ? '電流源' : '電圧源'} ${esc(x.pins[0]?.net || '未接続')} → ${esc(x.pins[1]?.net || '未接続')}・${esc(sum(x))}</button></li>`).join('')}</ul>` : '';
    if (!s.sources.length) return schHtml + `<p class="note">${sch.length ? 'ここで足す信号源はありません。' : '信号源がありません。回路図に「交流電源」「直流電源」を置くか、'}「＋ 信号源」で、ネットとネット（ふつうは GND）の間に電圧源・電流源を置きます。回路図の電池は自動で電圧源になります。</p>`;
    return schHtml + `<ul class="sim-list">${s.sources.map((x, i) => `<li><button type="button" class="link" data-src="${i}"><b>${esc(x.name)}</b> ${x.type === 'I' ? '電流源' : '電圧源'} ${esc(x.pos)} → ${esc(x.neg)}・${esc(sourceSummary(x, x.type === 'I' ? 'A' : 'V'))}</button></li>`).join('')}</ul>`;
  }

  function modelsHtml() {
    let b;
    try { b = buildCircuit(P(), { netlist: ctx.getNetlist() }); } catch (e) { return `<p class="err">${esc(e.message)}</p>`; }
    const badge = (r) => (r.status === 'on' ? '<span class="ok">計算</span>' : r.status === 'error' ? '<span class="err">誤り</span>' : '<span class="muted">外す</span>');
    return `<div class="sim-scroll"><table class="sim-table"><tr><th>部品</th><th>値</th><th>モデル</th><th></th></tr>${b.rows.map((r) => `<tr data-model="${esc(r.compId)}"><td><button type="button" class="link">${esc(r.ref)}</button></td><td>${esc(r.value)}</td><td>${esc(r.model || '')}${r.note ? `<br><small class="${r.status === 'error' ? 'err' : 'muted'}">${esc(r.note)}</small>` : ''}</td><td>${badge(r)}</td></tr>`).join('')}</table></div>`;
  }

  // ---------------- 結果 ----------------
  /** 信号の色（選んだ順で決まる。ボタンの印とグラフの線で同じ） */
  const colorOf = (name) => { const k = S().probes.indexOf(name); return k < 0 ? null : COLORS[k % COLORS.length]; };

  function seriesOf(r) {
    // 選んだ信号 → [{ name, x, y, color, panel, unit, dash }]。panel は量（電圧・電流・位相…）で分ける
    const probes = S().probes.filter((p) => r.names.includes(p));
    const out = [];
    for (const name of probes) {
      const i = r.names.indexOf(name), color = colorOf(name), q = name.startsWith('I(') ? 'I' : 'V';
      if (r.dc) {
        for (const [g, grp] of r.dc.groups.entries()) {
          const end = r.dc.groups[g + 1]?.start ?? r.dc.x.length;
          out.push({ name: grp.value == null ? name : `${name} @${formatValue(grp.value)}`, x: r.dc.x.slice(grp.start, end), y: r.dc.y[i].slice(grp.start, end), color, dash: g % 2 === 1, panel: q, unit: unitOf(name) });
        }
      } else if (r.ac) {
        const re = r.ac.re[i], im = r.ac.im[i];
        const mag = re.map((x, j) => Math.hypot(x, im[j]));
        if (st.acView === 'db' || st.acView === 'both') out.push({ name: `${name} dB`, x: r.ac.f, y: mag.map((m) => 20 * Math.log10(Math.max(m, 1e-30))), color, panel: `${q}dB`, unit: 'dB' });
        if (st.acView === 'mag') out.push({ name: `|${name}|`, x: r.ac.f, y: mag, color, panel: `${q}mag`, unit: '' });
        if (st.acView === 'phase' || st.acView === 'both') {
          // 位相は ±180° を越えてつなぐ
          let prev = null;
          const ph = re.map((x, j) => { let p = (Math.atan2(im[j], x) * 180) / Math.PI; if (prev != null) { while (p - prev > 180) p -= 360; while (p - prev < -180) p += 360; } prev = p; return p; });
          out.push({ name: `${name} 位相`, x: r.ac.f, y: ph, color, panel: 'ph', unit: '°' });
        }
      } else if (r.tran) {
        if (st.fft) { if (st.fft[name]) out.push({ name: `FFT ${name}`, x: st.fft[name].f.slice(1), y: st.fft[name].db.slice(1), color, panel: `${q}fft`, unit: 'dB' }); }
        else out.push({ name, x: r.tran.t, y: r.tran.y[i], color, panel: q, unit: unitOf(name) });
      }
    }
    return out;
  }

  /** 段ごとのグラフ（x 軸・カーソル・拡大はすべての段で共通） */
  function plotsHtml(r, series) {
    const keys = Object.keys(PANELS).filter((k) => series.some((t) => t.panel === k));
    if (!keys.length) { st.plotMaps = []; return '<p class="note">下の「表示する信号」で選んでください</p>'; }
    const xUnit = r.dc ? r.dc.src : r.ac || st.fft ? 'Hz' : 's';
    const width = Math.min(900, Math.max(320, ctx.root.clientWidth - 24));
    const h = keys.length === 1 ? 240 : keys.length === 2 ? 180 : 150;
    st.plotMaps = [];
    return keys.map((k, n) => {
      const last = n === keys.length - 1;
      const pl = plotSvg({ traces: series.filter((t) => t.panel === k), xLog: !!r.ac || !!st.fft, xUnit, yUnit: '', xRange: st.xRange, cursor: st.cursor, cursor2: st.cursor2, width, height: last ? h + 20 : h, id: k, showX: last });
      st.plotMaps.push(pl.map);
      return `<div class="sim-panel" data-panel="${k}"><div class="sim-panel-h">${PANELS[k].title}${PANELS[k].unit ? `（${PANELS[k].unit}）` : ''}</div>${pl.svg}</div>`;
    }).join('');
  }

  /** カーソルの値の表（ドラッグ中はこれだけ書き換える） */
  function cursorHtml(r, series) {
    if (st.cursor == null || !series.length) return '';
    const xu = r.ac || st.fft ? 'Hz' : r.tran ? 's' : '';
    const c2 = st.cursor2;
    return `<div class="sim-scroll"><table class="sim-table"><tr><th>信号</th><th><span class="cur-key a">A</span> ${formatValue(st.cursor, xu)}</th>${c2 != null ? `<th><span class="cur-key b">B</span> ${formatValue(c2, xu)}</th><th>B−A</th>` : ''}</tr>${c2 != null ? `<tr class="muted"><td>${r.tran ? '時間差' : '差'}</td><td></td><td></td><td class="num">${formatValue(c2 - st.cursor, xu, 4)}${r.tran && c2 !== st.cursor ? `（${formatValue(1 / Math.abs(c2 - st.cursor), 'Hz', 3)}）` : ''}</td></tr>` : ''}${series.map((t) => {
      const a = valueAt(t.x, t.y, st.cursor), b = c2 != null ? valueAt(t.x, t.y, c2) : null;
      return `<tr><td><i class="dot" style="background:${t.color}"></i>${esc(t.name)}</td><td class="num">${formatValue(a, t.unit, 4)}</td>${b != null ? `<td class="num">${formatValue(b, t.unit, 4)}</td><td class="num">${formatValue(b - a, t.unit, 4)}</td>` : ''}</tr>`;
    }).join('')}</table></div>`;
  }

  /**
   * 表示する信号のボタン（1 種類のボタンに統一）。電圧はネット、電流は部品で分ける。
   * 上の段は表示中の信号（線と同じ色の印。凡例を兼ね、触れると外す）。下の 2 つの組は折りたたみ（絞り込むと開く）
   */
  function signalsHtml(r) {
    const chip = (n) => { const c = colorOf(n); return `<button type="button" class="chip sig${c ? ' on' : ''}" data-probe="${esc(n)}"><i class="dot" style="background:${c || 'transparent'}"></i>${esc(inner(n))}</button>`; };
    const vs = r.names.filter((n) => n.startsWith('V(')), is = r.names.filter((n) => n.startsWith('I('));
    const on = S().probes.filter((p) => r.names.includes(p));
    const grp = (key, title, list) => `<details class="sig-group" data-g="${key}"${st.openGroups?.has(key) ? ' open' : ''}><summary class="sig-h">${title}（${list.length}）</summary><div class="chips">${list.map(chip).join('')}</div></details>`;
    return `<details class="sim-probes" open><summary>表示する信号（${on.length}）</summary>
      <div class="chips sig-on">${on.length ? on.map((n) => chip(n).replace('data-probe=', 'data-on="1" data-probe=')).join('') : '<span class="note">下の組から選んでください</span>'}</div>
      <div class="sig-tools"><input type="search" class="sim-filter" placeholder="名前で絞り込み（例: OUT、R1）" value="${esc(st.filter || '')}">${on.length ? '<button type="button" class="chip" data-act="probesclear">すべて外す</button>' : ''}</div>
      ${grp('V', '電圧（ネット）', vs)}${is.length ? grp('I', '電流（部品）', is) : ''}</details>`;
  }

  function resultHtml() {
    const r = st.result;
    if (st.running) return `<p class="sim-progress">計算中… ${Math.round(st.progress * 100)}%（「実行」をもう一度押すと中止）</p>`;
    if (st.error) return `<p class="err">${esc(st.error)}</p>`;
    if (!r) return '<p class="note">「実行」で計算します。</p>';
    const warn = r.warnings.length ? `<details class="sim-warn"><summary>注意 ${r.warnings.length} 件</summary><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
    const head = `<p class="note">${{ op: '動作点', dc: '直流スイープ', ac: 'AC', tran: '過渡' }[r.type]}・${r.ms}ms${r.tran ? `・${r.tran.t.length} 点` : ''}${r.op?.method && r.op.method !== 'newton' ? `・収束の補助: ${r.op.method === 'gmin' ? 'GMIN ステップ' : '電源ステップ'}` : ''}</p>`;
    if (r.op) {
      const nodes = r.names.map((n, i) => [n, r.op.values[i]]).filter(([n]) => n.startsWith('V('));
      const devs = r.op.devices.filter((d) => d.type !== 'V' || true);
      const fmtDev = (d) => (d.type === 'R' ? `I ${formatValue(d.i, 'A')}・P ${formatValue(d.p, 'W')}` : d.type === 'D' ? `Vd ${formatValue(d.vd, 'V')}・I ${formatValue(d.i, 'A')}・P ${formatValue(d.p, 'W')}`
        : d.type === 'Q' ? `Vbe ${formatValue(d.vbe, 'V')}・Vce ${formatValue(d.vce, 'V')}・Ic ${formatValue(d.ic, 'A')}・Ib ${formatValue(d.ib, 'A')}・P ${formatValue(d.p, 'W')}`
          : d.type === 'M' ? `Vgs ${formatValue(d.vgs, 'V')}・Vds ${formatValue(d.vds, 'V')}・Id ${formatValue(d.id, 'A')}・P ${formatValue(d.p, 'W')}` : `I ${formatValue(d.i, 'A')}・供給 ${formatValue(d.p, 'W')}`);
      return head + warn + `<h4>ネットの電圧</h4><div class="sim-scroll"><table class="sim-table">${nodes.map(([n, v]) => `<tr><td>${esc(n)}</td><td class="num">${formatValue(v, 'V', 5)}</td></tr>`).join('')}</table></div>
        <h4>部品</h4><div class="sim-scroll"><table class="sim-table">${devs.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(fmtDev(d))}</td></tr>`).join('')}</table></div>`;
    }
    const series = seriesOf(r);
    st.series = series; // ドラッグ中の表はこれを使う（毎回作り直さない）
    const plots = plotsHtml(r, series);
    let meas = '';
    if (r.tran && !st.fft && series.length) {
      const [a, b] = st.xRange || [-Infinity, Infinity];
      meas = `<h4>測定（表示している範囲）</h4><div class="sim-scroll"><table class="sim-table"><tr><th>信号</th><th>最小</th><th>最大</th><th>P-P</th><th>平均</th><th>実効値</th><th>周波数</th></tr>${series.map((t) => {
        const m = measure(t.x, t.y, a, b), u = t.unit;
        return `<tr><td><i class="dot" style="background:${t.color}"></i>${esc(t.name)}</td><td class="num">${formatValue(m.min, u)}</td><td class="num">${formatValue(m.max, u)}</td><td class="num">${formatValue(m.pp, u)}</td><td class="num">${formatValue(m.avg, u)}</td><td class="num">${formatValue(m.rms, u)}</td><td class="num">${Number.isFinite(m.freq) ? formatValue(m.freq, 'Hz') : '—'}</td></tr>`;
      }).join('')}</table></div>`;
    }
    if (r.ac && series.length) {
      // −3dB の周波数（最初の点から 3dB 下がる所）
      meas = `<h4>測定</h4><div class="sim-scroll"><table class="sim-table"><tr><th>信号</th><th>最大</th><th>その周波数</th><th>−3dB の周波数</th></tr>${S().probes.filter((p) => r.names.includes(p)).map((name) => {
        const i = r.names.indexOf(name), mag = r.ac.re[i].map((x, j) => 20 * Math.log10(Math.max(Math.hypot(x, r.ac.im[i][j]), 1e-30)));
        let k = 0; mag.forEach((m, j) => { if (m > mag[k]) k = j; });
        const lim = mag[k] - 3; let lo = NaN, hi = NaN;
        for (let j = k; j > 0; j--) if (mag[j - 1] < lim) { lo = r.ac.f[j - 1] + ((lim - mag[j - 1]) / (mag[j] - mag[j - 1])) * (r.ac.f[j] - r.ac.f[j - 1]); break; }
        for (let j = k; j < mag.length - 1; j++) if (mag[j + 1] < lim) { hi = r.ac.f[j] + ((mag[j] - lim) / (mag[j] - mag[j + 1])) * (r.ac.f[j + 1] - r.ac.f[j]); break; }
        return `<tr><td><i class="dot" style="background:${colorOf(name)}"></i>${esc(name)}</td><td class="num">${mag[k].toFixed(2)}dB</td><td class="num">${formatValue(r.ac.f[k], 'Hz')}</td><td class="num">${[lo, hi].filter(Number.isFinite).map((f) => formatValue(f, 'Hz')).join(' / ') || '—'}</td></tr>`;
      }).join('')}</table></div>`;
    }
    const viewChips = r.ac ? ['db', 'phase', 'both', 'mag'].map((v) => `<button type="button" class="chip${st.acView === v ? ' on' : ''}" data-acview="${v}">${{ db: '大きさ dB', phase: '位相', both: 'dB＋位相', mag: '大きさ（倍）' }[v]}</button>`).join('') : r.tran ? `<button type="button" class="chip${st.fft ? ' on' : ''}" data-act="fft">FFT</button>` : '';
    const curChips = `<button type="button" class="chip" data-act="zoomin"${st.cursor2 == null ? ' disabled' : ''}>A〜B を拡大</button><button type="button" class="chip" data-act="zoomall"${st.xRange ? '' : ' disabled'}>全体</button><button type="button" class="chip" data-act="curclear"${st.cursor == null ? ' disabled' : ''}>カーソルを消す</button><button type="button" class="chip" data-act="csv">CSV 書出</button>`;
    return head + warn + `<div class="sim-plotwrap" data-plot>${plots}</div>
      <p class="note sim-hint">グラフに触れると A、もう一度で B。<b>A・B は指で左右にドラッグ</b>できます（近い方が動きます）</p>
      <div class="chips">${viewChips}${curChips}</div><div class="sim-curtab">${cursorHtml(r, series)}</div>${meas}
      ${signalsHtml(r)}
      ${tuneHtml()}`;
  }

  function tuneHtml() {
    const r = st.result;
    if (!r || r.op) return '';
    const cand = (r.rows || []).filter((x) => x.status === 'on' && ['resistor', 'capacitor', 'electrolytic', 'inductor'].includes(x.kind));
    if (!cand.length) return '';
    const t = st.tune;
    return `<details class="sim-tune"${t ? ' open' : ''}><summary>チューニング（値を動かして計算し直す）</summary>
      <div class="form-row"><label class="field small"><span>部品</span><select data-tune="ref"><option value="">（選ぶ）</option>${cand.map((x) => `<option value="${esc(x.ref)}" ${t?.ref === x.ref ? 'selected' : ''}>${esc(x.ref)}（${esc(x.value)}）</option>`).join('')}</select></label>
      ${t ? `<label class="field small grow"><span>${formatValue(t.base * Math.pow(10, t.k))}（×${Math.pow(10, t.k).toFixed(2)}）</span><input type="range" min="-1" max="1" step="0.05" value="${t.k}" data-tune="k"></label><button type="button" class="btn small" data-act="tuneapply">この値を回路図に反映</button>` : ''}</div>
      <p class="note">選んだ部品の値を 1/10〜10 倍で変えて、すぐに計算し直します（回路図は「反映」を押すまで変えません）。</p></details>`;
  }

  // ---------------- 描画 ----------------
  function render() {
    const root = ctx.root;
    drag = null; // 描き直すと前のグラフの要素は無くなる
    const p = P();
    if (!p) { root.innerHTML = ''; return; }
    const s = S();
    root.innerHTML = `<div class="sim">
      <div class="seg">${TYPES.map(([k, l]) => `<button type="button" class="chip${s.analysis.type === k ? ' on' : ''}" data-type="${k}">${l}</button>`).join('')}</div>
      <div class="sim-an">${analysisForm(s)}</div>
      <div class="sim-actions"><button type="button" class="btn primary" data-act="run">${st.running ? '中止' : '▶ 実行'}</button><button type="button" class="btn" data-act="addsrc">＋ 信号源</button><button type="button" class="btn" data-act="spice">SPICE 書出</button></div>
      <div class="sim-result">${resultHtml()}</div>
      <details class="sim-sec"${s.sources.length || schSources().length ? '' : ' open'}><summary>信号源（${s.sources.length + schSources().length}）${s.sources.length + schSources().length ? `<span class="muted sum-note">${esc([...schSources().map((x) => x.ref), ...s.sources.map((x) => x.name)].join('・'))}</span>` : ''}</summary>${sourcesHtml(s)}</details>
      <details class="sim-sec"><summary>部品のモデル</summary><p class="note">回路図の部品を値・型番からモデルにします。部品をタップすると、内蔵モデルの選択・SPICE モデルの割り当て・計算から外す、を選べます。IC・コネクタはモデルを割り当てたときだけ計算に入ります。</p>${modelsHtml()}</details>
      <details class="sim-sec"><summary>ライブラリ（SPICE の .model・.subckt）</summary><p class="note">メーカーの SPICE モデルを貼ります（ダイオード・バイポーラ・MOSFET レベル 1 の .model と、R C L V I E G D Q M X だけでできた .subckt）。部品のモデルで「SPICE」を選び、名前を入れると使えます。</p><textarea class="sim-lib" rows="6" spellcheck="false" placeholder=".model D1N4148 D(IS=2.52n N=1.752 RS=0.568)">${esc(s.lib)}</textarea><button type="button" class="btn small" data-act="savelib">ライブラリを保存</button></details>
      <p class="note">計算は端末の中だけで行います（SPICE と同じ修正節点解析・ニュートン法・台形則）。モデルは近似なので、実機・データシートで確かめてください。</p>
    </div>`;
    if (st.filter) applyFilter();
  }

  // ---------------- 操作 ----------------
  async function editSource(i) {
    const s = S(), nets = netNames();
    const src = i == null ? { id: `src${Date.now()}`, name: `V${s.sources.length + 1}`, type: 'V', pos: nets.find((n) => n !== GROUND && !s.sources.some((x) => x.pos === n || x.neg === n)) || nets.find((n) => n !== GROUND) || '', neg: GROUND, dc: '0', acMag: '', acPh: '', wave: { type: 'none', p: [] } } : structuredClone(s.sources[i]);
    const netSel = (name, v) => `<select name="${name}">${nets.map((n) => `<option ${n === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    const html = `<div class="form">
      <div class="form-row"><label class="field small"><span>名前</span><input type="text" name="name" value="${esc(src.name)}"></label><label class="field small"><span>種類</span><select name="type"><option value="V" ${src.type !== 'I' ? 'selected' : ''}>電圧源</option><option value="I" ${src.type === 'I' ? 'selected' : ''}>電流源</option></select></label></div>
      <div class="form-row"><label class="field small"><span>＋のネット</span>${netSel('pos', src.pos)}</label><label class="field small"><span>－のネット</span>${netSel('neg', src.neg)}</label></div>
      ${sourceFormHtml(src, src.type === 'I' ? 'A' : 'V')}
      <p class="note">電流源は SPICE と同じく、＋から源の中を通って－へ流れる向きが正です（回路には－から＋の向きに流れ出ます）。値は 10k・4.7u・1M（メガ）・1m（ミリ）のように書けます。</p></div>`;
    const btns = [{ label: 'キャンセル', value: '' }, ...(i != null ? [{ label: '削除', value: 'del' }] : []), { label: '保存', value: 'ok', cls: 'primary' }];
    const pr = ctx.ask(i == null ? '信号源を追加' : `信号源 ${src.name}`, html, btns);
    bindSourceForm(document.querySelector('#dialog-body'), document.querySelector('#dialog-body [name="type"]'));
    const r = await pr;
    if (!r) return;
    if (r === 'del') { save((sim) => { sim.sources.splice(i, 1); }); render(); return; }
    const q = (n) => document.querySelector(`#dialog-body [name="${n}"]`).value.trim();
    const wf = readSourceForm(document.querySelector('#dialog-body'));
    if (wf.error) { ctx.toast(wf.error, true); return; }
    const out = { ...src, name: q('name') || src.name, type: q('type'), pos: q('pos'), neg: q('neg'), ...wf };
    if (out.pos === out.neg) { ctx.toast('＋と－に同じネットは選べません', true); return; }
    // 電圧源どうしの並列は解けない（ngspice も止まる）。ループ全体は計算の前に engine が調べる
    const twin = out.type === 'V' && s.sources.find((x, k) => k !== i && x.type !== 'I' && ((x.pos === out.pos && x.neg === out.neg) || (x.pos === out.neg && x.neg === out.pos)));
    if (twin) { ctx.toast(`${out.pos}–${out.neg} には電圧源 ${twin.name} があります。電圧源を同じネットに 2 つはつなげません（${twin.name} を直すか、別のネットを選んでください）`, true); return; }
    save((sim) => { if (i == null) sim.sources.push(out); else sim.sources[i] = out; });
    render();
  }

  /** 回路図の信号源（交流電源など）の電圧・周波数などを変える（値は回路図の部品に SPICE の書き方で入る） */
  async function editSchSource(ref) {
    const x = schSources().find((y) => y.ref === ref);
    if (!x) return;
    const type = x.kind === 'isrc' ? 'I' : 'V';
    let cur;
    try { cur = sourceFromSpice(x.value, type); } catch { cur = sourceFromSpice('', type); }
    const pr = ctx.ask(`${ref}（${x.kind === 'vac' ? '交流電源' : x.kind === 'vdc' ? '直流電源' : '電流源'}）`, `<div class="form">${sourceFormHtml(cur, type === 'I' ? 'A' : 'V')}</div>`, [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    bindSourceForm(document.querySelector('#dialog-body'));
    if (await pr !== 'ok') return;
    const wf = readSourceForm(document.querySelector('#dialog-body'));
    if (wf.error) { ctx.toast(wf.error, true); return; }
    ctx.applyValue(ref, sourceToSpice(wf));
    st.result = null;
    render();
  }

  async function editModel(compId) {
    const nl = ctx.getNetlist();
    const c = nl.components.find((x) => x.compId === compId);
    if (!c) return;
    const s = S(), set = s.models[compId] || {};
    const choices = builtinChoices(c.kind);
    const mode = set.mode || 'auto';
    const prm = set.params || {};
    const fld = (name, label, val) => `<label class="field small"><span>${label}</span><input type="text" name="${name}" value="${esc(val)}"></label>`;
    const extra = c.kind === 'pot' ? `<label class="field small"><span>ワイパーの位置（0〜1）</span><input type="text" name="pos" value="${esc(prm.pos ?? '0.5')}"></label>`
      : c.kind === 'capacitor' || c.kind === 'electrolytic' ? `<label class="field small"><span>初期電圧（UIC のとき。空 = 0）</span><input type="text" name="ic" value="${esc(prm.ic ?? '')}"></label>`
        : c.kind === 'inductor' ? `<label class="field small"><span>直列抵抗 Ω（DCR）</span><input type="text" name="rs" value="${esc(prm.rs ?? '')}"></label>`
          : c.kind === 'battery' ? `<label class="field small"><span>内部抵抗 Ω</span><input type="text" name="rint" value="${esc(prm.rint ?? '0.1')}"></label>`
            : c.kind === 'switch' ? `<label class="field small"><span>状態</span><select name="state"><option value="open" ${prm.state !== 'closed' ? 'selected' : ''}>開</option><option value="closed" ${prm.state === 'closed' ? 'selected' : ''}>閉</option></select></label>`
              : c.kind === 'transformer' ? `<p class="note">巻数比は回路図の値（例: 100V:12V）。点は 1 と 4。</p><div class="form-row">${fld('lp', '1 次のインダクタンス H', prm.lp ?? '10')}${fld('k', '結合係数（0〜1）', prm.k ?? '0.999')}</div><div class="form-row">${fld('rp', '1 次の巻線抵抗 Ω', prm.rp ?? '1')}${fld('rs', '2 次の巻線抵抗 Ω', prm.rs ?? '0.1')}</div>`
                : c.kind === 'fuse' || c.kind === 'ferrite' ? fld('r', '抵抗 Ω（直流）', prm.r ?? '0.05')
                  : c.kind === 'tvs' ? fld('bv', '降伏電圧 V（空 = 型番から）', prm.bv ?? '')
                    : c.kind === 'regulator' ? `<div class="form-row">${fld('vout', '出力電圧 V（空 = 型番から）', prm.vout ?? '')}${fld('drop', '落差 V（入力 − 出力の最小）', prm.drop ?? '')}</div>`
                      : c.kind === 'relay' ? `<div class="form-row"><label class="field small"><span>接点</span><select name="state"><option value="off" ${prm.state !== 'on' ? 'selected' : ''}>コイルに電流なし（COM–NC が閉）</option><option value="on" ${prm.state === 'on' ? 'selected' : ''}>コイルに電流あり（COM–NO が閉）</option></select></label>${fld('rcoil', 'コイル抵抗 Ω', prm.rcoil ?? '70')}</div>`
                        : c.kind === 'optocoupler' ? fld('ctr', '変換効率 CTR（1 = 100%）', prm.ctr ?? '1')
                          : c.kind === 'crystal' ? `<div class="form-row">${fld('rs', '直列抵抗 Ω', prm.rs ?? '50')}${fld('c1', '直列容量 F', prm.c1 ?? '10f')}${fld('c0', '並列容量 F', prm.c0 ?? '3p')}</div>`
                            : c.kind === 'buzzer' || c.kind === 'speaker' ? fld('r', 'コイルの抵抗 Ω', prm.r ?? (c.kind === 'buzzer' ? '42' : '')) : '';
    const pins = defaultPins(c.kind, c).join(' ');
    const html = `<div class="form">
      <p class="note">${esc(c.ref)}・${esc(c.kind)}・値 ${esc(c.value)}${c.mpn ? `・${esc(c.mpn)}` : ''}</p>
      <label class="field"><span>モデル</span><select name="mode">
        <option value="auto" ${mode === 'auto' ? 'selected' : ''}>自動（値・型番から）</option>
        ${choices.length ? `<option value="builtin" ${mode === 'builtin' ? 'selected' : ''}>内蔵モデルを選ぶ</option>` : ''}
        <option value="spice" ${mode === 'spice' ? 'selected' : ''}>SPICE（ライブラリの .model / .subckt）</option>
        <option value="off" ${mode === 'off' ? 'selected' : ''}>計算から外す</option></select></label>
      ${SIM_KINDS.includes(c.kind) && ['resistor', 'pot', 'capacitor', 'electrolytic', 'inductor', 'battery'].includes(c.kind) ? `<label class="field small"><span>シミュレーション用の値（空 = 回路図の値）</span><input type="text" name="value" value="${esc(set.value || '')}" placeholder="${esc(c.value)}"></label>` : ''}
      ${choices.length ? `<label class="field"><span>内蔵モデル</span><select name="key">${choices.map((x) => `<option value="${esc(x.key)}" ${set.key === x.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>` : ''}
      <div class="form-row"><label class="field small"><span>SPICE の名前</span><input type="text" name="spice" value="${esc(set.spice || '')}" placeholder="例: LM358"></label><label class="field small"><span>ピンの順番（サブ回路の端子の順。ピン番号）</span><input type="text" name="pins" value="${esc(set.pins || '')}" placeholder="${esc(pins)}"></label></div>
      ${extra}
      <p class="note">ピン: ${c.pins.map((x) => `${esc(x.num)}${x.name && x.name !== '~' ? `(${esc(x.name)})` : ''}=${esc(x.net || '未接続')}`).join('、')}</p></div>`;
    const r = await ctx.ask(`${c.ref} のモデル`, html, [{ label: 'キャンセル', value: '' }, { label: '保存', value: 'ok', cls: 'primary' }]);
    if (r !== 'ok') return;
    const q = (n) => document.querySelector(`#dialog-body [name="${n}"]`)?.value?.trim() ?? '';
    const out = { mode: q('mode') };
    if (q('value')) { if (!Number.isFinite(parseValue(q('value')))) { ctx.toast(`値「${q('value')}」を数として読めません`, true); return; } out.value = q('value'); }
    if (q('key')) out.key = q('key');
    if (q('spice')) out.spice = q('spice');
    if (q('pins')) out.pins = q('pins');
    const p2 = {};
    for (const k of ['pos', 'ic', 'rs', 'rint', 'state', 'lp', 'k', 'rp', 'r', 'bv', 'vout', 'drop', 'rcoil', 'ctr', 'c1', 'c0']) {
      if (!q(k)) continue;
      if (k !== 'state' && !Number.isFinite(parseValue(q(k)))) { ctx.toast(`「${q(k)}」を数として読めません`, true); return; }
      p2[k] = q(k);
    }
    if (Object.keys(p2).length) out.params = p2;
    save((sim) => { if (out.mode === 'auto' && Object.keys(out).length === 1) delete sim.models[compId]; else sim.models[compId] = out; });
    render();
  }

  function exportCsv() {
    const r = st.result;
    if (!r || r.op) return;
    const series = seriesOf(r);
    if (!series.length) return;
    const xs = series[0].x;
    const head = [r.ac || st.fft ? 'freq_Hz' : r.dc ? r.dc.src : 'time_s', ...series.map((t) => t.name)];
    const lines = [head.join(',')];
    for (let i = 0; i < xs.length; i++) lines.push([xs[i], ...series.map((t) => valueAt(t.x, t.y, xs[i]))].map((v) => (typeof v === 'number' ? v.toPrecision(8) : v)).join(','));
    ctx.download(`${P().name}-sim-${r.type}.csv`, lines.join('\n') + '\n', 'text/csv');
  }

  async function onClick(ev) {
    const t = ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.type) { save((sim) => { sim.analysis.type = t.dataset.type; }); st.result = null; render(); return; }
    if (t.dataset.src != null) { await editSource(Number(t.dataset.src)); return; }
    if (t.dataset.schsrc != null) { await editSchSource(t.dataset.schsrc); return; }
    const tr = t.closest('[data-model]');
    if (tr) { await editModel(tr.dataset.model); return; }
    if (t.dataset.probe) { const n = t.dataset.probe; save((sim) => { sim.probes = sim.probes.includes(n) ? sim.probes.filter((x) => x !== n) : [...sim.probes, n]; }, 'sim:probes'); st.fft = null; render(); return; }
    if (t.dataset.acview) { st.acView = t.dataset.acview; render(); return; }
    switch (t.dataset.act) {
      case 'run': await run(); break;
      case 'addsrc': await editSource(null); break;
      case 'spice': {
        try { ctx.download(`${P().name}.cir`, exportSpice(P(), { version: ctx.version }), 'text/plain'); ctx.toast('SPICE ネットリストを書き出しました（ngspice・KiCad の回路シミュレータで読めます）'); } catch (e) { ctx.toast(e.message, true); }
        break;
      }
      case 'savelib': {
        const txt = ctx.root.querySelector('.sim-lib').value;
        try { buildCircuit({ ...P(), sim: { ...S(), lib: txt } }, { netlist: ctx.getNetlist() }); save((sim) => { sim.lib = txt; }); ctx.toast('ライブラリを保存しました'); } catch (e) { ctx.toast(e.message, true); }
        render();
        break;
      }
      case 'fft': {
        if (st.fft) { st.fft = null; render(); break; }
        const r = st.result;
        const [a, b] = st.xRange || [r.tran.t[0], r.tran.t[r.tran.t.length - 1]];
        st.fft = {};
        for (const name of S().probes.filter((p) => r.names.includes(p))) {
          const i = r.names.indexOf(name), xs = [], ys = [];
          r.tran.t.forEach((x, j) => { if (x >= a && x <= b) { xs.push(x); ys.push(r.tran.y[i][j]); } });
          if (xs.length > 8) st.fft[name] = fft(xs, ys, { n: 8192 });
        }
        st.cursor = null; st.cursor2 = null; st.xRange = null;
        render();
        break;
      }
      case 'zoomin': {
        if (st.cursor != null && st.cursor2 != null && st.cursor !== st.cursor2) st.xRange = [Math.min(st.cursor, st.cursor2), Math.max(st.cursor, st.cursor2)];
        else ctx.toast('カーソル A と B を置いてから押してください');
        render();
        break;
      }
      case 'zoomall': st.xRange = null; render(); break;
      case 'curclear': st.cursor = null; st.cursor2 = null; render(); break;
      case 'probesclear': save((sim) => { sim.probes = []; }, 'sim:probes'); st.fft = null; render(); break;
      case 'csv': exportCsv(); break;
      case 'tuneapply': {
        const tn = st.tune;
        if (!tn) break;
        const v = formatValue(tn.base * Math.pow(10, tn.k), '', 3).replace('µ', 'u');
        ctx.applyValue(tn.ref, v);
        ctx.toast(`${tn.ref} の値を ${v} にしました`);
        st.tune = null;
        render();
        break;
      }
      default: break;
    }
  }

  function applyFilter() {
    const f = (st.filter || '').toLowerCase();
    ctx.root.querySelectorAll('.sig-group [data-probe]').forEach((b) => { b.hidden = !!f && !b.dataset.probe.toLowerCase().includes(f); });
    ctx.root.querySelectorAll('.sig-group').forEach((g) => { const any = !!g.querySelector('[data-probe]:not([hidden])'); g.hidden = !!f && !any; if (f && any) g.open = true; });
    // 絞り込みを消したら、そのとき開いている組を覚える（描き直しで閉じない）
    if (!f) st.openGroups = new Set([...ctx.root.querySelectorAll('.sig-group[open]')].map((g) => g.dataset.g));
  }

  // ---------------- カーソルのドラッグ ----------------
  // 触れた所にカーソルを置き、そのまま指を動かすと付いてくる。A・B の両方があるときは近い方を動かす。
  // ドラッグ中は SVG を作り直さず、カーソルの位置と値の表だけを書き換える（つかみが切れない・軽い）
  // 触れ方: つまみ（今のカーソル）の近くに触れたら、すぐにドラッグ。
  // それ以外は「待ち」: 動かさずに離せばそこに置く（タップ）、横に動かせばそこに置いてドラッグ、
  // 縦に動かせば画面のスクロール（ブラウザが pointercancel を送る）で、カーソルは変えない
  const GRAB = 28, SLOP = 8; // 画面の px
  function plotDown(ev) {
    const svg = ev.target.closest('.sim-plot');
    if (!svg || !st.plotMaps?.length || !st.result || st.result.op) return;
    if (ev.button != null && ev.button > 0) return;
    const map = st.plotMaps[0];
    const rc = svg.getBoundingClientRect();
    const px = ((ev.clientX - rc.left) / rc.width) * map.W;
    if (px < map.L - 12 || px > map.L + map.pw + 12) return; // 目盛りの所は触れても何もしない
    const scale = rc.width / map.W; // viewBox → 画面の px
    const near = (c) => (c != null ? Math.abs(plotPxAt(map, c) - px) * scale : Infinity);
    const dA = near(st.cursor), dB = near(st.cursor2);
    const grab = Math.min(dA, dB) <= GRAB ? (dA <= dB ? 'a' : 'b') : null;
    drag = { id: ev.pointerId, svg, x0: ev.clientX, y0: ev.clientY, prev: [st.cursor, st.cursor2], active: false, which: grab || (st.cursor == null || st.cursor2 != null ? 'a' : 'b') };
    // 両方あるときにつまみ以外へ触れたら、近い方を動かす
    if (!grab && st.cursor != null && st.cursor2 != null) drag.which = dA <= dB ? 'a' : 'b';
    if (grab) { startDrag(ev); ev.preventDefault(); }
  }
  function xOf(ev) {
    const map = st.plotMaps?.[0];
    const svg = ctx.root.querySelector('.sim-plot');
    if (!map || !svg) return null;
    const rc = svg.getBoundingClientRect();
    return plotXAt(map, ((ev.clientX - rc.left) / rc.width) * map.W);
  }
  function startDrag(ev) {
    drag.active = true;
    try { drag.svg.setPointerCapture(ev.pointerId); } catch { /* 古い WebView */ }
    const x = xOf(ev); if (x != null) setCursor(drag.which, x);
  }
  let raf = 0;
  function setCursor(which, x) {
    if (which === 'a') st.cursor = x; else st.cursor2 = x;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      ctx.root.querySelectorAll('.sim-plot').forEach((svg, k) => { const m = st.plotMaps[k] || st.plotMaps[0]; moveCursor(svg, m, 'a', st.cursor); moveCursor(svg, m, 'b', st.cursor2); });
      const tab = ctx.root.querySelector('.sim-curtab');
      if (tab && st.result) tab.innerHTML = cursorHtml(st.result, st.series || []);
      const z = ctx.root.querySelector('[data-act="zoomin"]'); if (z) z.disabled = st.cursor2 == null;
      const c = ctx.root.querySelector('[data-act="curclear"]'); if (c) c.disabled = st.cursor == null;
    });
  }
  function plotMove(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.active) {
      const dx = Math.abs(ev.clientX - drag.x0), dy = Math.abs(ev.clientY - drag.y0);
      if (dx > SLOP && dx > dy) startDrag(ev); // 横に動かした → そこに置いてドラッグ
      else return; // 縦ならスクロールに任せる
    }
    const x = xOf(ev); if (x != null) setCursor(drag.which, x);
    ev.preventDefault();
  }
  function plotUp(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag; drag = null;
    try { d.svg.releasePointerCapture(ev.pointerId); } catch { /* 無視 */ }
    if (ev.type === 'pointercancel') {
      // スクロールに変わった: カーソルは触れる前に戻す
      if (d.active) { st.cursor = d.prev[0]; st.cursor2 = d.prev[1]; setCursor('a', st.cursor); }
      return;
    }
    if (!d.active && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) <= SLOP) { const x = xOf(ev); if (x != null) setCursor(d.which, x); } // タップ
  }

  function onInput(ev) {
    const t = ev.target;
    if (t.dataset.an) {
      const [k, sub] = t.dataset.an.split('.');
      const v = t.type === 'checkbox' ? t.checked : t.value;
      save((sim) => { sim.analysis[k] = { ...sim.analysis[k], [sub]: v }; }, 'sim:analysis');
      return;
    }
    if (t.classList.contains('sim-filter')) {
      st.filter = t.value;
      applyFilter();
      return;
    }
    if (t.dataset.tune === 'ref') {
      const row = (st.result?.rows || []).find((x) => x.ref === t.value);
      st.tune = row ? { ref: row.ref, base: parseValue(S().models[row.compId]?.value || row.value), k: 0 } : null;
      render();
      return;
    }
    if (t.dataset.tune === 'k' && ev.type === 'change') {
      st.tune.k = Number(t.value);
      const v = st.tune.base * Math.pow(10, st.tune.k);
      run({ override: new Map([[st.tune.ref, v]]), keepView: true });
    }
  }

  ctx.root.addEventListener('click', (ev) => { onClick(ev).catch((e) => ctx.toast(e.message || String(e), true)); });
  ctx.root.addEventListener('toggle', (ev) => {
    const g = ev.target.closest?.('.sig-group');
    if (!g || st.filter) return;
    st.openGroups = st.openGroups || new Set();
    if (g.open) st.openGroups.add(g.dataset.g); else st.openGroups.delete(g.dataset.g);
  }, true);
  ctx.root.addEventListener('pointerdown', plotDown);
  ctx.root.addEventListener('pointermove', plotMove);
  ctx.root.addEventListener('pointerup', plotUp);
  ctx.root.addEventListener('pointercancel', plotUp);
  ctx.root.addEventListener('change', onInput);
  ctx.root.addEventListener('input', (ev) => { if (ev.target.classList.contains('sim-filter')) onInput(ev); });

  return { render, run, result: () => st.result, exportSpice: () => ctx.root.querySelector('[data-act="spice"]')?.click(), addSource: () => editSource(null) };
}
