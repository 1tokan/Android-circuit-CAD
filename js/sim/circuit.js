// 回路図（ネットリスト）＋ シミュレーションの設定 → シミュレータの回路
//
// project.sim（無ければ既定値）
//   analysis: { type: 'op'|'dc'|'ac'|'tran', dc: { src, start, stop, step, src2, start2, stop2, step2 },
//               ac: { scale: 'dec'|'oct'|'lin', points, fstart, fstop }, tran: { tstep, tstop, tstart, tmax, uic } }
//   sources:  [{ id, name, type: 'V'|'I', pos, neg, dc, acMag, acPh, wave: { type: 'none'|'sin'|'pulse'|'pwl'|'exp', p: [文字列] } }]
//             回路図に描かずに、ネットとネットの間に置く信号源（KiCad の VSOURCE・ISOURCE 記号と同じ役目）
//   models:   { 部品のid: { mode: 'auto'|'off'|'builtin'|'spice', key, spice, pins, params: { pos, ic, rs, rint, state } } }
//   lib:      SPICE の文（.model・.subckt）。メーカーのモデルを貼る
//   probes:   グラフに出す信号の名前
// GND という名前のネットが 0V の基準（SPICE のノード 0）

import { generateNetlist } from '../netlist/netlist.js';
import { parseValue, spiceNum } from './units.js';
import { builtinFor, lookup, DIODES, BJTS, MOSFETS, OPAMPS } from './models.js';
import { parseSpice, flatten, writeSpice, SpiceError } from './spice.js';
import { freqList, sweepList, SimError } from './engine.js';

export const SIM_KINDS = ['resistor', 'pot', 'capacitor', 'electrolytic', 'inductor', 'diode', 'led', 'zener', 'npn', 'pnp', 'nmos', 'pmos', 'opamp', 'switch', 'battery'];
export const GROUND = 'GND';

export function defaultSim() {
  return {
    analysis: {
      type: 'tran',
      dc: { src: '', start: '0', stop: '5', step: '0.05', src2: '', start2: '', stop2: '', step2: '' },
      ac: { scale: 'dec', points: '20', fstart: '10', fstop: '1Meg' },
      tran: { tstep: '10u', tstop: '10m', tstart: '0', tmax: '', uic: false },
    },
    sources: [],
    models: {},
    lib: '',
    probes: [],
  };
}

/** プロジェクトのシミュレーション設定（足りない所を既定値で補う） */
export function simSettings(project) {
  const d = defaultSim(), s = project.sim || {};
  return {
    ...d, ...s,
    analysis: { ...d.analysis, ...(s.analysis || {}), dc: { ...d.analysis.dc, ...(s.analysis?.dc || {}) }, ac: { ...d.analysis.ac, ...(s.analysis?.ac || {}) }, tran: { ...d.analysis.tran, ...(s.analysis?.tran || {}) } },
    sources: Array.isArray(s.sources) ? s.sources : [],
    models: s.models && typeof s.models === 'object' ? s.models : {},
    lib: typeof s.lib === 'string' ? s.lib : '',
    probes: Array.isArray(s.probes) ? s.probes : [],
  };
}

const val = (t, what, ref) => {
  const v = parseValue(t);
  if (!Number.isFinite(v)) throw new SimError(`${ref}: ${what}「${t}」を数として読めません（例: 10k・4.7u・100n）`);
  return v;
};

/** ネット名 → ノード名（GND は 0） */
const nodeOf = (net) => (net === GROUND ? '0' : net);

/** 部品ごとの既定のピンの順番（SPICE の端子の順。ic・connector はサブ回路の端子の順） */
export function defaultPins(kind, comp) {
  switch (kind) {
    case 'diode': case 'led': case 'zener': return ['2', '1']; // A, K
    case 'npn': case 'pnp': return ['3', '1', '2']; // C, B, E
    case 'nmos': case 'pmos': return ['3', '1', '2']; // D, G, S
    case 'opamp': return ['3', '2', '1', '8', '4']; // +, −, OUT, V+, V−
    default: return (comp?.pins || []).map((p) => p.num);
  }
}

/**
 * @param opt { netlist }（無ければ回路図から作る）
 * @returns { circuit, rows: [{ ref, kind, value, model, status, note }], warnings: [], lib }
 */
export function buildCircuit(project, opt = {}) {
  const s = simSettings(project);
  const nl = opt.netlist || generateNetlist(project);
  const warnings = [];
  const rows = [];
  let lib;
  try { lib = parseSpice(s.lib || '', { title: false }); } catch (e) { throw new SimError(`ライブラリ（SPICE の文）: ${e.message}`); }
  const elements = [];
  const usedNets = new Set();
  for (const c of nl.components) {
    if (c.dnp) { rows.push({ ref: c.ref, compId: c.compId, kind: c.kind, value: c.value, status: 'off', note: '実装しない部品（DNP）' }); continue; }
    const set = s.models[c.compId] || {};
    const mode = set.mode || 'auto';
    const prm = set.params || {};
    const pinNet = new Map(c.pins.map((p) => [p.num, p.net]));
    // つながっていないピンは、その部品だけのノード（浮いた端子）
    const node = (num) => { const n = pinNet.get(String(num)); if (n) { usedNets.add(n); return nodeOf(n); } return `${c.ref}#${num}`; };
    const row = { ref: c.ref, compId: c.compId, kind: c.kind, value: c.value, status: 'on', model: '', note: '' };
    rows.push(row);
    if (mode === 'off') { row.status = 'off'; row.note = 'シミュレーションから外す'; continue; }
    try {
      if (mode === 'spice') {
        const name = String(set.spice || '').trim();
        if (!name) throw new SimError('SPICE のモデル名・サブ回路名が空です');
        const pins = String(set.pins || '').trim() ? String(set.pins).trim().split(/[\s,]+/) : defaultPins(c.kind, c);
        const nodes = pins.map(node);
        const sub = lib.subckts.get(name.toLowerCase());
        if (sub) {
          if (sub.ports.length !== nodes.length) throw new SimError(`サブ回路 ${name} の端子は ${sub.ports.length} 個、ピンの対応は ${nodes.length} 個です（ピンの順番を確認）`);
          const els = flatten({ elements: [{ type: 'X', name: `X${c.ref}`, n: nodes, subckt: name }], models: new Map(lib.models), subckts: new Map(lib.subckts) });
          elements.push(...els);
          row.model = `サブ回路 ${name}（${pins.join(' ')}）`;
          continue;
        }
        const m = lib.models.get(name.toLowerCase());
        if (!m) throw new SimError(`ライブラリに ${name} がありません（.model か .subckt を貼ってください）`);
        const p = { type: m.type, ...m.params };
        if (m.type === 'd') elements.push({ type: 'D', name: c.ref, n: [nodes[0], nodes[1]], model: p });
        else if (m.type === 'npn' || m.type === 'pnp') elements.push({ type: 'Q', name: c.ref, n: nodes.slice(0, 3), model: p });
        else elements.push({ type: 'M', name: c.ref, n: [nodes[0], nodes[1], nodes[2], nodes[2]], model: p, W: 1, L: 1 });
        row.model = `.model ${name}（${m.type.toUpperCase()}）`;
        continue;
      }
      const v = set.value ? String(set.value) : String(c.value || '');
      switch (c.kind) {
        case 'resistor': {
          elements.push({ type: 'R', name: c.ref, n: [node(1), node(2)], value: val(v, '抵抗値', c.ref) });
          row.model = `R ${v}`;
          break;
        }
        case 'pot': {
          const R = val(v, '抵抗値', c.ref), pos = Math.min(1, Math.max(0, Number(prm.pos ?? 0.5)));
          elements.push({ type: 'R', name: `${c.ref}_A`, n: [node(1), node(3)], value: Math.max(1e-3, R * pos) });
          elements.push({ type: 'R', name: `${c.ref}_B`, n: [node(3), node(2)], value: Math.max(1e-3, R * (1 - pos)) });
          row.model = `可変抵抗 ${v}・位置 ${Math.round(pos * 100)}%`;
          break;
        }
        case 'capacitor': case 'electrolytic': {
          const e = { type: 'C', name: c.ref, n: [node(1), node(2)], value: val(v, '容量', c.ref) };
          if (prm.ic !== undefined && prm.ic !== '') e.ic = val(prm.ic, '初期電圧', c.ref);
          elements.push(e);
          row.model = `C ${v}${e.ic != null ? `・初期 ${prm.ic}V` : ''}`;
          break;
        }
        case 'inductor': {
          const L = val(v, 'インダクタンス', c.ref), rs = prm.rs ? val(prm.rs, '直列抵抗', c.ref) : 0;
          if (rs > 0) {
            const mid = `${c.ref}#m`;
            elements.push({ type: 'L', name: c.ref, n: [node(1), mid], value: L }, { type: 'R', name: `${c.ref}_RS`, n: [mid, node(2)], value: rs });
          } else elements.push({ type: 'L', name: c.ref, n: [node(1), node(2)], value: L });
          row.model = `L ${v}${rs ? `・直列 ${prm.rs}Ω` : ''}`;
          break;
        }
        case 'diode': case 'led': case 'zener': {
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(DIODES, set.key) } : builtinFor(c.kind, c.value, c.mpn);
          elements.push({ type: 'D', name: c.ref, n: [node(2), node(1)], model: { ...b.m } });
          row.model = b.label; if (b.guessed) row.note = '型番が内蔵モデルに無いため一般のモデル';
          break;
        }
        case 'npn': case 'pnp': {
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(BJTS, set.key) } : builtinFor(c.kind, c.value, c.mpn);
          elements.push({ type: 'Q', name: c.ref, n: [node(3), node(1), node(2)], model: { ...b.m } });
          row.model = b.label; if (b.guessed) row.note = '型番が内蔵モデルに無いため一般のモデル';
          break;
        }
        case 'nmos': case 'pmos': {
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(MOSFETS, set.key) } : builtinFor(c.kind, c.value, c.mpn);
          elements.push({ type: 'M', name: c.ref, n: [node(3), node(1), node(2), node(2)], model: { ...b.m }, W: 1, L: 1 });
          row.model = b.label; if (b.guessed) row.note = '型番が内蔵モデルに無いため一般のモデル';
          break;
        }
        case 'opamp': {
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(OPAMPS, set.key) } : builtinFor('opamp', c.value, c.mpn);
          const rails = pinNet.get('8') && pinNet.get('4');
          const n = rails ? [node(3), node(2), node(1), node(8), node(4)] : [node(3), node(2), node(1)];
          elements.push({ type: 'OA', name: c.ref, n, model: { ...b.m } });
          row.model = b.label + (rails ? '' : '（電源ピンが未接続のため ±15V で飽和）');
          if (b.guessed) row.note = '型番が内蔵モデルに無いため一般のモデル';
          break;
        }
        case 'switch': {
          const on = prm.state === 'closed';
          elements.push({ type: 'R', name: c.ref, n: [node(1), node(2)], value: on ? 0.05 : 1e9 });
          row.model = on ? 'スイッチ 閉（0.05Ω）' : 'スイッチ 開（1GΩ）';
          break;
        }
        case 'battery': {
          const V = val(v, '電圧', c.ref), rint = prm.rint ? val(prm.rint, '内部抵抗', c.ref) : 0.1;
          const mid = `${c.ref}#m`;
          elements.push({ type: 'V', name: `V${c.ref}`, n: [mid, node(2)], dc: V }, { type: 'R', name: `${c.ref}_RINT`, n: [mid, node(1)], value: rint });
          row.model = `電池 ${V}V・内部抵抗 ${spiceNum(rint)}Ω`;
          break;
        }
        default:
          row.status = 'off';
          row.note = c.kind === 'ic' || c.kind === 'connector' ? 'モデルなし（SPICE のサブ回路を割り当てると計算に入ります）。ピンは何もつながっていない扱い' : 'モデルなし';
      }
    } catch (e) {
      if (!(e instanceof SimError || e instanceof SpiceError)) throw e;
      row.status = 'error'; row.note = e.message;
      warnings.push(`${c.ref}: ${e.message}`);
    }
  }
  // 信号源
  const netNames = new Set(nl.nets.map((n) => n.name));
  const srcNames = new Set();
  for (const src of s.sources) {
    const name = String(src.name || '').trim() || `${src.type}${s.sources.indexOf(src) + 1}`;
    if (srcNames.has(name.toUpperCase())) throw new SimError(`信号源の名前 ${name} が重なっています`);
    srcNames.add(name.toUpperCase());
    for (const n of [src.pos, src.neg]) if (n !== GROUND && !netNames.has(n)) throw new SimError(`信号源 ${name}: ネット ${n || '（未選択）'} が回路図にありません`);
    if (src.pos === src.neg) throw new SimError(`信号源 ${name}: ＋と－が同じネットです`);
    const e = { type: src.type === 'I' ? 'I' : 'V', name, n: [nodeOf(src.pos), nodeOf(src.neg)], dc: src.dc ? val(src.dc, '直流の値', name) : 0 };
    if (src.acMag) e.ac = { mag: val(src.acMag, 'AC の大きさ', name), ph: src.acPh ? val(src.acPh, 'AC の位相', name) : 0 };
    if (src.wave && src.wave.type && src.wave.type !== 'none') e.wave = { type: src.wave.type, p: (src.wave.p || []).filter((x) => String(x).trim() !== '').map((x) => val(x, '波形の値', name)) };
    elements.push(e);
    usedNets.add(src.pos); usedNets.add(src.neg);
  }
  if (!elements.length) throw new SimError('計算に入る部品がありません');
  const nodes = ['0'];
  const seen = new Set(['0']);
  for (const e of elements) for (const n of e.n) if (!seen.has(n)) { seen.add(n); nodes.push(n); }
  if (!elements.some((e) => e.n.includes('0'))) warnings.push('GND（0V の基準）につながる素子がありません。GND という名前のネットを基準にします');
  const off = rows.filter((r) => r.status === 'off' && r.kind !== 'power' && r.kind !== 'gnd').map((r) => r.ref);
  if (off.length) warnings.push(`計算に入れない部品（${off.length}）: ${off.slice(0, 12).join(', ')}${off.length > 12 ? ' …' : ''}`);
  return { circuit: { nodes, elements }, rows, warnings, lib };
}

/** 解析の設定 → SPICE の解析の文 */
export function analysisLine(a) {
  if (a.type === 'op') return '.op';
  if (a.type === 'dc') return `.dc ${a.dc.src} ${a.dc.start} ${a.dc.stop} ${a.dc.step}${a.dc.src2 ? ` ${a.dc.src2} ${a.dc.start2} ${a.dc.stop2} ${a.dc.step2}` : ''}`;
  if (a.type === 'ac') return `.ac ${a.ac.scale} ${a.ac.points} ${a.ac.fstart} ${a.ac.fstop}`;
  return `.tran ${a.tran.tstep} ${a.tran.tstop} ${a.tran.tstart || 0}${a.tran.tmax ? ` ${a.tran.tmax}` : ''}${a.tran.uic ? ' uic' : ''}`;
}

/** SPICE の解析の文の数を ngspice 用に（SI の M → Meg） */
function siToSpice(line) {
  return line.replace(/(\d)M(?![eE][gG])/g, '$1Meg');
}

/** ngspice で読めるネットリスト（KiCad の「SPICE ネットリストを書き出す」に相当） */
export function exportSpice(project, { version = '' } = {}) {
  const s = simSettings(project);
  const b = buildCircuit(project);
  const head = [`Pocket EDA ${version}: ${project.name}`];
  // rshunt: 全ノードから GND へ 1TΩ（Pocket EDA の計算と同じ。モデルの無い IC にだけつながるノードが浮いて解けなくなるのを防ぐ）
  const deck = writeSpice(b.circuit, { title: head[0], analyses: ['.options rshunt=1e12', siToSpice(analysisLine(s.analysis))] });
  const notes = b.rows.filter((r) => r.status !== 'on').map((r) => `* ${r.ref}（${r.value}）: ${r.note}`);
  return deck.replace(/\n/, `\n* 回路図のネット GND をノード 0 にしています\n${notes.join('\n')}${notes.length ? '\n' : ''}`);
}

/** 解析の値の並び（数に直す） */
export function analysisParams(a) {
  const n = (t, what) => { const v = parseValue(t); if (!Number.isFinite(v)) throw new SimError(`${what}「${t}」を数として読めません`); return v; };
  if (a.type === 'dc') {
    const values = sweepList(n(a.dc.start, '開始'), n(a.dc.stop, '終了'), n(a.dc.step, '刻み'));
    const values2 = a.dc.src2 ? sweepList(n(a.dc.start2, '2 つ目の開始'), n(a.dc.stop2, '2 つ目の終了'), n(a.dc.step2, '2 つ目の刻み')) : [null];
    if (values.length * values2.length > 200000) throw new SimError('点の数が多すぎます');
    return { values, values2 };
  }
  if (a.type === 'ac') return { freqs: freqList(a.ac.scale, n(a.ac.points, '点の数'), n(a.ac.fstart, '開始周波数'), n(a.ac.fstop, '終了周波数')) };
  if (a.type === 'tran') {
    const tstep = n(a.tran.tstep, '刻み'), tstop = n(a.tran.tstop, '終了時刻');
    if (tstop / tstep > 1e6) throw new SimError('終了時刻 ÷ 刻み が 100 万を超えています');
    return { tstep, tstop, tstart: a.tran.tstart ? n(a.tran.tstart, '記録の開始') : 0, tmax: a.tran.tmax ? n(a.tran.tmax, '最大の刻み') : undefined, uic: !!a.tran.uic };
  }
  return {};
}
