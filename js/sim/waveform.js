// 信号源の設定（直流・正弦波・パルス・指数・折れ線、AC 解析の大きさ）を、項目ごとの入力欄で入れる（0.13.4）
// 回路図の交流電源・直流電源・電流源（値は SPICE の書き方で保存）と、シミュの画面の信号源の両方で使う。
// 正弦波の大きさは実効値でもピークでも入れられる（保存は SPICE と同じピーク）。

import { parseValue, spiceNum } from './units.js';
import { parseElementLine } from './spice.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 波形ごとの項目（SPICE の引数の順）。u: 単位（電圧源・電流源で V/A を入れ替える所は '@'） */
export const WAVE_FORMS = {
  none: { label: '直流だけ', fields: [] },
  sin: { label: '正弦波（交流）', fields: [['vo', '中心（オフセット）', '@', '0'], ['va', '振幅', '@', ''], ['freq', '周波数', 'Hz', ''], ['td', '遅れ', 's', '0'], ['theta', '減衰', '1/s', '0'], ['phase', '位相', '°', '0']] },
  pulse: { label: 'パルス（方形波）', fields: [['v1', '初めの値', '@', '0'], ['v2', 'パルスの値', '@', ''], ['td', '遅れ', 's', '0'], ['tr', '立ち上がり', 's', '1u'], ['tf', '立ち下がり', 's', '1u'], ['pw', '幅', 's', ''], ['per', '周期', 's', '']] },
  exp: { label: '指数（なまった立ち上がり）', fields: [['v1', '初めの値', '@', '0'], ['v2', '行き着く値', '@', ''], ['td1', '上がり始め', 's', '0'], ['tau1', '上がりの時定数', 's', ''], ['td2', '下がり始め', 's', ''], ['tau2', '下がりの時定数', 's', '']] },
  pwl: { label: '折れ線（時刻と値の組）', fields: [] },
};

/** SPICE の値の文 → 設定 { dc, acMag, acPh, wave: { type, p: [文字列] } } */
export function sourceFromSpice(text, type = 'V') {
  const t = String(text || '').trim();
  if (!t) return { dc: '0', acMag: '', acPh: '', wave: { type: 'none', p: [] } };
  const e = parseElementLine(`${type}X a b ${t}`);
  return {
    dc: spiceNum(e.dc || 0),
    acMag: e.ac ? spiceNum(e.ac.mag) : '',
    acPh: e.ac && e.ac.ph ? spiceNum(e.ac.ph) : '',
    wave: e.wave ? { type: e.wave.type, p: e.wave.p.map((x) => spiceNum(x)) } : { type: 'none', p: [] },
  };
}

/** 設定 → SPICE の値の文（例: DC 0 AC 1 SIN(0 141.4 50)） */
export function sourceToSpice(s) {
  const parts = [`DC ${s.dc || 0}`];
  if (s.acMag) parts.push(`AC ${s.acMag}${s.acPh ? ` ${s.acPh}` : ''}`);
  if (s.wave?.type && s.wave.type !== 'none') parts.push(`${s.wave.type.toUpperCase()}(${s.wave.p.join(' ')})`);
  return parts.join(' ');
}

/** 一言の説明（一覧に出す） */
export function sourceSummary(s, unit = 'V') {
  const w = s.wave || { type: 'none', p: [] };
  const n = (x) => parseValue(x);
  if (w.type === 'sin') {
    const [vo, va, f] = w.p.map(n);
    return `正弦波 実効値 ${fmt(va / Math.SQRT2)}${unit}（ピーク ${fmt(va)}${unit}）・${fmt(f)}Hz${vo ? `・中心 ${fmt(vo)}${unit}` : ''}${s.acMag ? `・AC ${s.acMag}` : ''}`;
  }
  if (w.type === 'pulse') { const [v1, v2, , , , pw, per] = w.p.map(n); return `パルス ${fmt(v1)}→${fmt(v2)}${unit}${pw ? `・幅 ${fmt(pw)}s` : ''}${per ? `・周期 ${fmt(per)}s` : ''}${s.acMag ? `・AC ${s.acMag}` : ''}`; }
  if (w.type === 'exp') { const [v1, v2] = w.p.map(n); return `指数 ${fmt(v1)}→${fmt(v2)}${unit}`; }
  if (w.type === 'pwl') return `折れ線 ${w.p.length / 2} 点`;
  return `直流 ${s.dc || 0}${unit}${s.acMag ? `・AC ${s.acMag}` : ''}`;
}
/** 回路図に出す短い表示（例: 100V 50Hz、DC 5V、パルス 0→5V） */
export function sourceShort(text, kind) {
  const unit = kind === 'isrc' ? 'A' : 'V';
  let s;
  try { s = sourceFromSpice(text, kind === 'isrc' ? 'I' : 'V'); } catch { return String(text || ''); }
  const n = (x) => parseValue(x);
  const w = s.wave;
  if (w.type === 'sin') return `${fmt(n(w.p[1]) / Math.SQRT2)}${unit} ${fmt(n(w.p[2]))}Hz`;
  if (w.type === 'pulse') return `パルス ${fmt(n(w.p[0]))}→${fmt(n(w.p[1]))}${unit}`;
  if (w.type === 'exp') return `指数 ${fmt(n(w.p[0]))}→${fmt(n(w.p[1]))}${unit}`;
  if (w.type === 'pwl') return '折れ線';
  return `DC ${s.dc}${unit}${s.acMag ? ` AC ${s.acMag}` : ''}`;
}
const fmt = (v) => (Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : '?');

/**
 * 入力欄の HTML（ダイアログの本文に入れる）。bindSourceForm で波形の切り替えに合わせて欄を出し入れする
 * @param unit 'V'（電圧源）か 'A'（電流源）
 */
export function sourceFormHtml(s, unit = 'V') {
  const w = s.wave?.type || 'none';
  const f = (name, label, u, val, ph = '') => `<label class="field small"><span>${label}${u ? `（${u === '@' ? unit : u}）` : ''}</span><input type="text" inputmode="decimal" name="${name}" value="${esc(val)}" placeholder="${esc(ph)}"></label>`;
  const groups = Object.entries(WAVE_FORMS).map(([k, def]) => {
    if (k === 'none') return '';
    if (k === 'pwl') {
      const pairs = [];
      if (w === 'pwl') for (let i = 0; i + 1 < s.wave.p.length; i += 2) pairs.push(`${s.wave.p[i]} ${s.wave.p[i + 1]}`);
      return `<div class="wf-group" data-w="pwl"><label class="field"><span>時刻（s）と値（${unit}）を 1 行に 1 組（例: 0 0 ／ 1m 5 ／ 2m 5 ／ 3m 0）</span><textarea name="w_pwl" rows="4">${esc(pairs.join('\n'))}</textarea></label></div>`;
    }
    const vals = w === k ? s.wave.p : [];
    let cells = def.fields.map(([name, label, u, ph], i) => {
      if (k === 'sin' && name === 'va') return ''; // 下で実効値・ピークの欄にする
      return f(`w_${k}_${name}`, label, u, vals[i] ?? '', ph);
    });
    if (k === 'sin') {
      // 表に出す: 大きさ・周波数・中心。畳む: 遅れ・減衰・位相（cells は vo, (va), freq, td, theta, phase の順）
      const peak = vals[1] ? parseValue(vals[1]) : NaN;
      const rms = Number.isFinite(peak) ? spiceNum(Number((peak / Math.SQRT2).toPrecision(5))) : '';
      const amp = `<label class="field small"><span>大きさ（${unit}）</span><span class="wf-amp"><input type="text" inputmode="decimal" name="w_sin_amp" value="${esc(rms)}" placeholder="100"><select name="w_sin_kind"><option value="rms" selected>実効値</option><option value="peak">ピーク</option></select></span></label>`;
      const [vo, , freq, td, theta, phase] = cells;
      cells = [`<div class="form-row">${amp}${freq}${vo}</div>`, `<details class="wf-more"><summary>遅れ・減衰・位相</summary><div class="form-row">${td}${theta}${phase}</div></details>`];
      return `<div class="wf-group" data-w="sin">${cells.join('')}<p class="note wf-hint">家庭用 100V（東日本 50Hz・西日本 60Hz）なら 大きさ 100・実効値・周波数 50 か 60。</p></div>`;
    }
    return `<div class="wf-group" data-w="${k}"><div class="form-row">${cells.join('')}</div></div>`;
  }).join('');
  return `<div class="wf">
    <label class="field"><span>波形（過渡解析で使う）</span><select name="w_type">${Object.entries(WAVE_FORMS).map(([k, d]) => `<option value="${k}" ${w === k ? 'selected' : ''}>${d.label}</option>`).join('')}</select></label>
    ${groups}
    <div class="form-row"><label class="field small"><span>直流（動作点・直流スイープで使う。${unit}）</span><input type="text" inputmode="decimal" name="w_dc" value="${esc(s.dc || '')}" placeholder="0"></label></div>
    <div class="form-row"><label class="field small"><span>AC 解析の大きさ（${unit}。空 = 使わない）</span><input type="text" inputmode="decimal" name="w_acMag" value="${esc(s.acMag || '')}" placeholder="1"></label><label class="field small"><span>AC 解析の位相（°）</span><input type="text" inputmode="decimal" name="w_acPh" value="${esc(s.acPh || '')}" placeholder="0"></label></div>
  </div>`;
}

/** 波形の選択に合わせて欄を出し入れする（ダイアログが開いてから呼ぶ） */
export function bindSourceForm(root, typeSelect = null) {
  const sel = root.querySelector('[name="w_type"]');
  if (!sel) return;
  // 電圧源 ⇄ 電流源 を切り替えたら、単位（V・A）の表示も変える
  typeSelect?.addEventListener('change', () => {
    const to = typeSelect.value === 'I' ? 'A' : 'V', from = to === 'A' ? 'V' : 'A';
    root.querySelectorAll('.wf label > span:first-child').forEach((sp) => { sp.textContent = sp.textContent.replace(`（${from}`, `（${to}`).replace(`。${from}）`, `。${to}）`).replace(`値（${from}）`, `値（${to}）`); });
  });
  const show = () => root.querySelectorAll('.wf-group').forEach((g) => { g.hidden = g.dataset.w !== sel.value; });
  sel.addEventListener('change', show);
  show();
}

/**
 * 入力欄 → 設定。読めない値・足りない値があれば { error }
 * @returns { dc, acMag, acPh, wave } | { error }
 */
export function readSourceForm(root) {
  const q = (n) => String(root.querySelector(`[name="${n}"]`)?.value ?? '').trim();
  // 読めるか確かめて、SPICE と SI のどちらで読んでも同じになる書き方にそろえる（1M は SI ではメガ、SPICE ではミリ → 1Meg）
  const num = (v, label) => { const x = parseValue(v); if (!Number.isFinite(x)) throw new Error(`${label}「${v}」を数として読めません（例: 100、4.7k、1m、50）`); return spiceNum(x); };
  try {
    const type = q('w_type') || 'none';
    const acMag = q('w_acMag') ? num(q('w_acMag'), 'AC の大きさ') : '';
    const out = { dc: q('w_dc') ? num(q('w_dc'), '直流') : '0', acMag, acPh: acMag && q('w_acPh') ? num(q('w_acPh'), 'AC の位相') : '', wave: { type, p: [] } };
    if (type === 'pwl') {
      const t = q('w_pwl').split(/[\n,／/]+/).map((l) => l.trim()).filter(Boolean).flatMap((l) => l.split(/\s+/));
      if (t.length < 4 || t.length % 2) throw new Error('折れ線は「時刻 値」の組を 2 つ以上入れてください');
      out.wave.p = t.map((x, i) => num(x, i % 2 ? '値' : '時刻'));
      for (let i = 2; i < out.wave.p.length; i += 2) if (!(parseValue(out.wave.p[i]) > parseValue(out.wave.p[i - 2]))) throw new Error(`折れ線の時刻は増えていく順にしてください（${out.wave.p[i - 2]} の次が ${out.wave.p[i]}）`);
      if (parseValue(out.wave.p[0]) < 0) throw new Error('折れ線の時刻は 0 以上にしてください');
    } else if (type !== 'none') {
      const def = WAVE_FORMS[type];
      const p = def.fields.map(([name]) => {
        if (type === 'sin' && name === 'va') {
          const a = q('w_sin_amp');
          if (!a) return '';
          const v = parseValue(num(a, '大きさ'));
          return spiceNum(Number((q('w_sin_kind') === 'peak' ? v : v * Math.SQRT2).toPrecision(6)));
        }
        const v = q(`w_${type}_${name}`);
        return v ? num(v, def.fields.find((f) => f[0] === name)[1]) : '';
      });
      // 必要な値（初めの 3 つ。パルスは幅と周期も）が空ならことわる
      const need = type === 'sin' ? [1, 2] : type === 'pulse' ? [1] : [1, 3];
      for (const i of need) if (!p[i]) throw new Error(`${def.label}: 「${def.fields[i][1]}」を入れてください`);
      if (type === 'sin' && parseValue(p[2]) <= 0) throw new Error('周波数は 0 より大きくしてください');
      // 後ろの空欄は省き、途中の空欄は既定（0、パルスは立ち上がり・立ち下がり 1u）にする
      let last = p.length - 1;
      while (last >= 0 && !p[last]) last--;
      out.wave.p = p.slice(0, last + 1).map((v, i) => v || def.fields[i][3] || '0');
      // 指数: 下がり始め（TD2）が空なら SPICE と同じ「上がり始め＋上がりの時定数」
      if (type === 'exp' && out.wave.p.length >= 5 && !p[4]) out.wave.p[4] = spiceNum(parseValue(out.wave.p[2]) + parseValue(out.wave.p[3]));
    }
    return out;
  } catch (e) {
    return { error: e.message };
  }
}
