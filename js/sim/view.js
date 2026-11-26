// 「シミュレーション」画面（KiCad の回路シミュレータに相当）
//  解析（動作点・直流スイープ・AC・過渡）の設定 → 実行 → グラフ（信号の選択・カーソル・測定・FFT）・動作点の表
//  信号源（ネットとネットの間）・部品ごとのモデル・SPICE ライブラリ・チューニング（値を動かして再計算）・SPICE ネットリストの書き出し

import { esc } from '../core/util.js';
import { simSettings, buildCircuit, exportSpice, SIM_KINDS, GROUND, defaultPins } from './circuit.js';
import { runSimulation } from './run.js';
import { builtinChoices } from './models.js';
import { formatValue, parseValue } from './units.js';
import { plotSvg, plotXAt, valueAt, measure, fft, COLORS } from './plot.js';

const TYPES = [['op', '動作点'], ['dc', '直流スイープ'], ['ac', 'AC（周波数特性）'], ['tran', '過渡（時間波形）']];
const WAVES = {
  none: { label: 'なし（直流）', p: [] },
  sin: { label: '正弦波 SIN', p: ['中心 VO', '振幅 VA', '周波数 Hz', '遅れ TD s', '減衰 θ 1/s', '位相 °'] },
  pulse: { label: 'パルス PULSE', p: ['初期 V1', 'パルス V2', '遅れ TD s', '立ち上がり TR s', '立ち下がり TF s', '幅 PW s', '周期 PER s'] },
  pwl: { label: '折れ線 PWL（時刻 値 …）', p: [] },
  exp: { label: '指数 EXP', p: ['初期 V1', '到達 V2', '遅れ1 TD1', '時定数1 TAU1', '遅れ2 TD2', '時定数2 TAU2'] },
};
const unitOf = (name) => (name.startsWith('V(') ? 'V' : 'A');

export function createSimView(ctx) {
  const st = { result: null, running: false, stop: false, cursor: null, cursor2: null, xRange: null, acView: 'db', fft: null, tune: null, error: '', progress: 0 };
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
    const srcOpts = (sel) => `<option value="">（選ぶ）</option>${s.sources.map((x) => `<option ${x.name === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
    if (a.type === 'op') return '<p class="note">直流の動作点（各ネットの電圧・部品の電流と消費電力）を求めます。コンデンサは開放、インダクタは短絡として計算します。</p>';
    if (a.type === 'dc') return `<div class="form-row"><label class="field small"><span>信号源</span><select data-an="dc.src">${srcOpts(a.dc.src)}</select></label>${f('dc', 'start', '開始', '0')}${f('dc', 'stop', '終了', '5')}${f('dc', 'step', '刻み', '0.05')}</div>
      <div class="form-row"><label class="field small"><span>2 つ目（任意）</span><select data-an="dc.src2">${srcOpts(a.dc.src2)}</select></label>${f('dc', 'start2', '開始')}${f('dc', 'stop2', '終了')}${f('dc', 'step2', '刻み')}</div>`;
    if (a.type === 'ac') return `<div class="form-row"><label class="field small"><span>目盛り</span><select data-an="ac.scale">${['dec', 'oct', 'lin'].map((x) => `<option value="${x}" ${a.ac.scale === x ? 'selected' : ''}>${{ dec: '10 倍ごと', oct: '2 倍ごと', lin: '等間隔' }[x]}</option>`).join('')}</select></label>${f('ac', 'points', a.ac.scale === 'lin' ? '点の数' : '点の数（1 区間）', '20')}${f('ac', 'fstart', '開始 Hz', '10')}${f('ac', 'fstop', '終了 Hz', '1M')}</div>
      <p class="note">信号源の「AC」の大きさ（ふつう 1）を入れた源からの伝達を計算します（動作点で線形化した小信号）。</p>`;
    return `<div class="form-row">${f('tran', 'tstep', '刻み（目安）', '10u')}${f('tran', 'tstop', '終了時刻', '10m')}${f('tran', 'tstart', '記録の開始', '0')}${f('tran', 'tmax', '最大の刻み（任意）', '')}</div>
      <label class="field check"><input type="checkbox" data-an="tran.uic" ${a.tran.uic ? 'checked' : ''}> 動作点を求めずに 0V から始める（UIC。コンデンサの初期電圧はモデルの設定で）</label>`;
  }

  function sourcesHtml(s) {
    if (!s.sources.length) return '<p class="note">信号源がありません。「＋ 信号源」で、ネットとネット（ふつうは GND）の間に電圧源・電流源を置きます。回路図の電池は自動で電圧源になります。</p>';
    return `<ul class="sim-list">${s.sources.map((x, i) => `<li><button type="button" class="link" data-src="${i}"><b>${esc(x.name)}</b> ${x.type === 'I' ? '電流源' : '電圧源'} ${esc(x.pos)} → ${esc(x.neg)}・DC ${esc(x.dc || '0')}${x.acMag ? `・AC ${esc(x.acMag)}` : ''}${x.wave?.type && x.wave.type !== 'none' ? `・${x.wave.type.toUpperCase()}(${esc((x.wave.p || []).join(' '))})` : ''}</button></li>`).join('')}</ul>`;
  }

  function modelsHtml() {
    let b;
    try { b = buildCircuit(P(), { netlist: ctx.getNetlist() }); } catch (e) { return `<p class="err">${esc(e.message)}</p>`; }
    const badge = (r) => (r.status === 'on' ? '<span class="ok">計算</span>' : r.status === 'error' ? '<span class="err">誤り</span>' : '<span class="muted">外す</span>');
    return `<table class="sim-table"><tr><th>部品</th><th>値</th><th>モデル</th><th></th></tr>${b.rows.map((r) => `<tr data-model="${esc(r.compId)}"><td><button type="button" class="link">${esc(r.ref)}</button></td><td>${esc(r.value)}</td><td>${esc(r.model || '')}${r.note ? `<br><small class="${r.status === 'error' ? 'err' : 'muted'}">${esc(r.note)}</small>` : ''}</td><td>${badge(r)}</td></tr>`).join('')}</table>`;
  }

  // ---------------- 結果 ----------------
  function seriesOf(r) {
    // 選んだ信号 → [{ name, x, y, right }]
    const s = S();
    const probes = s.probes.filter((p) => r.names.includes(p));
    const out = [];
    probes.forEach((name, k) => {
      const i = r.names.indexOf(name), color = COLORS[k % COLORS.length];
      if (r.dc) {
        for (const [g, grp] of r.dc.groups.entries()) {
          const end = r.dc.groups[g + 1]?.start ?? r.dc.x.length;
          out.push({ name: grp.value == null ? name : `${name} @${formatValue(grp.value)}`, x: r.dc.x.slice(grp.start, end), y: r.dc.y[i].slice(grp.start, end), color, dash: g % 2 === 1 });
        }
      } else if (r.ac) {
        const re = r.ac.re[i], im = r.ac.im[i];
        const mag = re.map((x, j) => Math.hypot(x, im[j]));
        if (st.acView === 'db' || st.acView === 'both') out.push({ name: `${name} dB`, x: r.ac.f, y: mag.map((m) => 20 * Math.log10(Math.max(m, 1e-30))), color });
        if (st.acView === 'mag') out.push({ name: `|${name}|`, x: r.ac.f, y: mag, color });
        if (st.acView === 'phase' || st.acView === 'both') {
          // 位相は ±180° を越えてつなぐ
          let prev = null;
          const ph = re.map((x, j) => { let p = (Math.atan2(im[j], x) * 180) / Math.PI; if (prev != null) { while (p - prev > 180) p -= 360; while (p - prev < -180) p += 360; } prev = p; return p; });
          out.push({ name: `${name} 位相°`, x: r.ac.f, y: ph, color, right: st.acView === 'both', dash: st.acView === 'both' });
        }
      } else if (r.tran) {
        if (st.fft) out.push({ name: `FFT ${name} dB`, x: st.fft[name].f.slice(1), y: st.fft[name].db.slice(1), color });
        else out.push({ name, x: r.tran.t, y: r.tran.y[i], color });
      }
    });
    return out;
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
      return head + warn + `<h4>ネットの電圧</h4><table class="sim-table">${nodes.map(([n, v]) => `<tr><td>${esc(n)}</td><td class="num">${formatValue(v, 'V', 5)}</td></tr>`).join('')}</table>
        <h4>部品</h4><table class="sim-table">${devs.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(fmtDev(d))}</td></tr>`).join('')}</table>`;
    }
    const series = seriesOf(r);
    const xUnit = r.dc ? `${r.dc.src}（${r.names.some((n) => n === `I(${r.dc.src})`) ? 'V/A' : ''}）` : r.ac ? 'Hz' : st.fft ? 'Hz' : 's';
    const yUnit = r.ac ? (st.acView === 'mag' ? '' : st.acView === 'phase' ? '°' : 'dB') : st.fft ? 'dB' : series.every((t) => t.name.startsWith('V(')) ? 'V' : series.every((t) => t.name.startsWith('I(')) ? 'A' : '';
    const pl = series.length ? plotSvg({ traces: series, xLog: !!r.ac || !!st.fft, xUnit, yUnit, y2Unit: st.acView === 'both' ? '°' : '', xRange: st.xRange, cursor: st.cursor, cursor2: st.cursor2, width: Math.min(900, Math.max(320, ctx.root.clientWidth - 24)), height: 240 }) : null;
    st.plotMap = pl?.map;
    const legend = series.map((t) => `<span class="legend"><i style="background:${t.color}"></i>${esc(t.name)}</span>`).join('');
    // カーソルの値・測定
    let cur = '';
    if (st.cursor != null && series.length) {
      const c2 = st.cursor2;
      cur = `<table class="sim-table"><tr><th>信号</th><th>A ${formatValue(st.cursor, r.ac || st.fft ? 'Hz' : r.tran ? 's' : '')}</th>${c2 != null ? `<th>B ${formatValue(c2, r.ac || st.fft ? 'Hz' : r.tran ? 's' : '')}</th><th>B−A</th>` : ''}</tr>${series.map((t) => {
        const a = valueAt(t.x, t.y, st.cursor), b = c2 != null ? valueAt(t.x, t.y, c2) : null;
        return `<tr><td>${esc(t.name)}</td><td class="num">${formatValue(a, '', 5)}</td>${b != null ? `<td class="num">${formatValue(b, '', 5)}</td><td class="num">${formatValue(b - a, '', 5)}</td>` : ''}</tr>`;
      }).join('')}</table>`;
    }
    let meas = '';
    if (r.tran && !st.fft && series.length) {
      const [a, b] = st.xRange || [-Infinity, Infinity];
      meas = `<h4>測定（表示している範囲）</h4><table class="sim-table"><tr><th>信号</th><th>最小</th><th>最大</th><th>P-P</th><th>平均</th><th>実効値</th><th>周波数</th></tr>${series.map((t) => {
        const m = measure(t.x, t.y, a, b), u = unitOf(t.name);
        return `<tr><td>${esc(t.name)}</td><td class="num">${formatValue(m.min, u)}</td><td class="num">${formatValue(m.max, u)}</td><td class="num">${formatValue(m.pp, u)}</td><td class="num">${formatValue(m.avg, u)}</td><td class="num">${formatValue(m.rms, u)}</td><td class="num">${Number.isFinite(m.freq) ? formatValue(m.freq, 'Hz') : '—'}</td></tr>`;
      }).join('')}</table>`;
    }
    if (r.ac && series.length) {
      // −3dB の周波数（最初の点から 3dB 下がる所）
      meas = `<h4>測定</h4><table class="sim-table"><tr><th>信号</th><th>最大</th><th>その周波数</th><th>−3dB の周波数</th></tr>${S().probes.filter((p) => r.names.includes(p)).map((name) => {
        const i = r.names.indexOf(name), mag = r.ac.re[i].map((x, j) => 20 * Math.log10(Math.max(Math.hypot(x, r.ac.im[i][j]), 1e-30)));
        let k = 0; mag.forEach((m, j) => { if (m > mag[k]) k = j; });
        const lim = mag[k] - 3; let lo = NaN, hi = NaN;
        for (let j = k; j > 0; j--) if (mag[j - 1] < lim) { lo = r.ac.f[j - 1] + ((lim - mag[j - 1]) / (mag[j] - mag[j - 1])) * (r.ac.f[j] - r.ac.f[j - 1]); break; }
        for (let j = k; j < mag.length - 1; j++) if (mag[j + 1] < lim) { hi = r.ac.f[j] + ((mag[j] - lim) / (mag[j] - mag[j + 1])) * (r.ac.f[j + 1] - r.ac.f[j]); break; }
        return `<tr><td>${esc(name)}</td><td class="num">${mag[k].toFixed(2)}dB</td><td class="num">${formatValue(r.ac.f[k], 'Hz')}</td><td class="num">${[lo, hi].filter(Number.isFinite).map((f) => formatValue(f, 'Hz')).join(' / ') || '—'}</td></tr>`;
      }).join('')}</table>`;
    }
    const probeChips = r.names.map((n) => `<button type="button" class="chip${S().probes.includes(n) ? ' on' : ''}" data-probe="${esc(n)}">${esc(n)}</button>`).join('');
    const viewChips = r.ac ? ['db', 'phase', 'both', 'mag'].map((v) => `<button type="button" class="chip${st.acView === v ? ' on' : ''}" data-acview="${v}">${{ db: '大きさ dB', phase: '位相', both: 'dB＋位相', mag: '大きさ（倍）' }[v]}</button>`).join('') : r.tran ? `<button type="button" class="chip${st.fft ? ' on' : ''}" data-act="fft">FFT</button>` : '';
    const zoom = `<button type="button" class="chip" data-act="zoomin">カーソルの間を拡大</button><button type="button" class="chip" data-act="zoomall">全体</button><button type="button" class="chip" data-act="csv">CSV 書出</button>`;
    return head + warn + `<div class="sim-plotwrap" data-plot>${pl ? pl.svg : '<p class="note">下の一覧から信号を選んでください</p>'}</div>
      <div class="legend-row">${legend}</div>
      <p class="note">グラフをタップ: カーソル A、もう一度: B（3 回目で A に戻る）</p>
      <div class="chips">${viewChips}${zoom}</div>${cur}${meas}
      <details class="sim-probes" open><summary>信号を選ぶ（${S().probes.length}）</summary><input type="search" class="sim-filter" placeholder="名前で絞り込み（例: OUT、I(R）" value="${esc(st.filter || '')}"><div class="chips">${probeChips}</div></details>
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
    const p = P();
    if (!p) { root.innerHTML = ''; return; }
    const s = S();
    root.innerHTML = `<div class="sim">
      <div class="seg">${TYPES.map(([k, l]) => `<button type="button" class="chip${s.analysis.type === k ? ' on' : ''}" data-type="${k}">${l}</button>`).join('')}</div>
      <div class="sim-an">${analysisForm(s)}</div>
      <div class="sim-actions"><button type="button" class="btn primary" data-act="run">${st.running ? '中止' : '▶ 実行'}</button><button type="button" class="btn" data-act="addsrc">＋ 信号源</button><button type="button" class="btn" data-act="spice">SPICE 書出</button></div>
      <details class="sim-sec" open><summary>信号源（${s.sources.length}）</summary>${sourcesHtml(s)}</details>
      <div class="sim-result">${resultHtml()}</div>
      <details class="sim-sec"><summary>部品のモデル</summary><p class="note">回路図の部品を値・型番からモデルにします。部品をタップすると、内蔵モデルの選択・SPICE モデルの割り当て・計算から外す、を選べます。IC・コネクタはモデルを割り当てたときだけ計算に入ります。</p>${modelsHtml()}</details>
      <details class="sim-sec"><summary>ライブラリ（SPICE の .model・.subckt）</summary><p class="note">メーカーの SPICE モデルを貼ります（ダイオード・バイポーラ・MOSFET レベル 1 の .model と、R C L V I E G D Q M X だけでできた .subckt）。部品のモデルで「SPICE」を選び、名前を入れると使えます。</p><textarea class="sim-lib" rows="6" spellcheck="false" placeholder=".model D1N4148 D(IS=2.52n N=1.752 RS=0.568)">${esc(s.lib)}</textarea><button type="button" class="btn small" data-act="savelib">ライブラリを保存</button></details>
      <p class="note">計算は端末の中だけで行います（SPICE と同じ修正節点解析・ニュートン法・台形則）。モデルは近似なので、実機・データシートで確かめてください。</p>
    </div>`;
  }

  // ---------------- 操作 ----------------
  async function editSource(i) {
    const s = S(), nets = netNames();
    const src = i == null ? { id: `src${Date.now()}`, name: `V${s.sources.length + 1}`, type: 'V', pos: nets.find((n) => n !== GROUND) || '', neg: GROUND, dc: '0', acMag: '', acPh: '', wave: { type: 'none', p: [] } } : structuredClone(s.sources[i]);
    const netSel = (name, v) => `<select name="${name}">${nets.map((n) => `<option ${n === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    const wtype = src.wave?.type || 'none';
    const html = `<div class="form">
      <div class="form-row"><label class="field small"><span>名前</span><input type="text" name="name" value="${esc(src.name)}"></label><label class="field small"><span>種類</span><select name="type"><option value="V" ${src.type !== 'I' ? 'selected' : ''}>電圧源</option><option value="I" ${src.type === 'I' ? 'selected' : ''}>電流源</option></select></label></div>
      <div class="form-row"><label class="field small"><span>＋のネット</span>${netSel('pos', src.pos)}</label><label class="field small"><span>－のネット</span>${netSel('neg', src.neg)}</label></div>
      <div class="form-row"><label class="field small"><span>直流 DC</span><input type="text" name="dc" value="${esc(src.dc || '')}" placeholder="0"></label><label class="field small"><span>AC の大きさ</span><input type="text" name="acMag" value="${esc(src.acMag || '')}" placeholder="1"></label><label class="field small"><span>AC の位相°</span><input type="text" name="acPh" value="${esc(src.acPh || '')}" placeholder="0"></label></div>
      <label class="field"><span>波形（過渡解析）</span><select name="wtype">${Object.entries(WAVES).map(([k, w]) => `<option value="${k}" ${wtype === k ? 'selected' : ''}>${w.label}</option>`).join('')}</select></label>
      <label class="field"><span>波形の値（空白区切り。${esc(Object.entries(WAVES).filter(([k]) => k !== 'none').map(([k, w]) => `${k.toUpperCase()}: ${w.p.join(' ') || '時刻1 値1 時刻2 値2 …'}`).join(' ／ '))}）</span><input type="text" name="wp" value="${esc((src.wave?.p || []).join(' '))}" placeholder="0 5 1k"></label>
      <p class="note">電流源は SPICE と同じく、＋から源の中を通って－へ流れる向きが正です（回路には－から＋の向きに流れ出ます）。値は 10k・4.7u・1M（メガ）・1m（ミリ）のように書けます。</p></div>`;
    const btns = [{ label: 'キャンセル', value: '' }, ...(i != null ? [{ label: '削除', value: 'del' }] : []), { label: '保存', value: 'ok', cls: 'primary' }];
    const r = await ctx.ask(i == null ? '信号源を追加' : `信号源 ${src.name}`, html, btns);
    if (!r) return;
    if (r === 'del') { save((sim) => { sim.sources.splice(i, 1); }); render(); return; }
    const q = (n) => document.querySelector(`#dialog-body [name="${n}"]`).value.trim();
    const out = { ...src, name: q('name') || src.name, type: q('type'), pos: q('pos'), neg: q('neg'), dc: q('dc'), acMag: q('acMag'), acPh: q('acPh'), wave: { type: q('wtype'), p: q('wp').split(/[\s,]+/).filter(Boolean) } };
    for (const [k, t] of [['dc', out.dc], ['acMag', out.acMag], ['acPh', out.acPh], ...out.wave.p.map((x) => ['wave', x])]) if (t && !Number.isFinite(parseValue(t))) { ctx.toast(`${k}: 「${t}」を数として読めません`, true); return; }
    if (out.pos === out.neg) { ctx.toast('＋と－に同じネットは選べません', true); return; }
    if (out.wave.type !== 'none' && out.wave.type !== 'pwl' && !out.wave.p.length) { ctx.toast('波形の値を入れてください', true); return; }
    save((sim) => { if (i == null) sim.sources.push(out); else sim.sources[i] = out; });
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
    const extra = c.kind === 'pot' ? `<label class="field small"><span>ワイパーの位置（0〜1）</span><input type="text" name="pos" value="${esc(prm.pos ?? '0.5')}"></label>`
      : c.kind === 'capacitor' || c.kind === 'electrolytic' ? `<label class="field small"><span>初期電圧（UIC のとき。空 = 0）</span><input type="text" name="ic" value="${esc(prm.ic ?? '')}"></label>`
        : c.kind === 'inductor' ? `<label class="field small"><span>直列抵抗 Ω（DCR）</span><input type="text" name="rs" value="${esc(prm.rs ?? '')}"></label>`
          : c.kind === 'battery' ? `<label class="field small"><span>内部抵抗 Ω</span><input type="text" name="rint" value="${esc(prm.rint ?? '0.1')}"></label>`
            : c.kind === 'switch' ? `<label class="field small"><span>状態</span><select name="state"><option value="open" ${prm.state !== 'closed' ? 'selected' : ''}>開</option><option value="closed" ${prm.state === 'closed' ? 'selected' : ''}>閉</option></select></label>` : '';
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
    for (const k of ['pos', 'ic', 'rs', 'rint', 'state']) if (q(k)) p2[k] = q(k);
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
    const t = ev.target.closest('button, [data-plot] svg');
    if (!t) return;
    if (t.matches('svg')) { plotTap(ev); return; }
    if (t.dataset.type) { save((sim) => { sim.analysis.type = t.dataset.type; }); st.result = null; render(); return; }
    if (t.dataset.src != null) { await editSource(Number(t.dataset.src)); return; }
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

  function plotTap(ev) {
    const svg = ev.target.closest('svg');
    if (!svg || !st.plotMap) return;
    const rc = svg.getBoundingClientRect();
    const px = ((ev.clientX - rc.left) / rc.width) * st.plotMap.W;
    const x = plotXAt(st.plotMap, px);
    if (st.cursor == null || (st.cursor != null && st.cursor2 != null)) { st.cursor = x; st.cursor2 = null; }
    else st.cursor2 = x;
    render();
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
      const f = t.value.toLowerCase();
      ctx.root.querySelectorAll('[data-probe]').forEach((b) => { b.hidden = !!f && !b.dataset.probe.toLowerCase().includes(f); });
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
  ctx.root.addEventListener('change', onInput);
  ctx.root.addEventListener('input', (ev) => { if (ev.target.classList.contains('sim-filter')) onInput(ev); });

  return { render, run, result: () => st.result, exportSpice: () => ctx.root.querySelector('[data-act="spice"]')?.click(), addSource: () => editSource(null) };
}
