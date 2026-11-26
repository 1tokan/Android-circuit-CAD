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
import { parseSpice, flatten, writeSpice, SpiceError, parseElementLine } from './spice.js';
import { freqList, sweepList, SimError } from './engine.js';

export const SIM_KINDS = ['resistor', 'pot', 'capacitor', 'electrolytic', 'inductor', 'diode', 'led', 'zener', 'npn', 'pnp', 'nmos', 'pmos', 'opamp', 'switch', 'battery', 'schottky', 'tvs', 'bridge', 'transformer', 'fuse', 'ferrite', 'thermistor', 'speaker', 'buzzer', 'regulator', 'relay', 'optocoupler', 'crystal', 'vac', 'vdc', 'isrc'];
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
    case 'diode': case 'led': case 'zener': case 'schottky': return ['2', '1']; // A, K
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
          // 1・3 = 両端, 2 = ワイパ
          elements.push({ type: 'R', name: `${c.ref}_A`, n: [node(1), node(2)], value: Math.max(1e-3, R * pos) });
          elements.push({ type: 'R', name: `${c.ref}_B`, n: [node(2), node(3)], value: Math.max(1e-3, R * (1 - pos)) });
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
        case 'schottky': {
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(DIODES, set.key) } : builtinFor('schottky', c.value, c.mpn);
          elements.push({ type: 'D', name: c.ref, n: [node(2), node(1)], model: { ...b.m } });
          row.model = b.label; if (b.guessed) row.note = '型番が内蔵モデルに無いため一般のショットキーのモデル';
          break;
        }
        case 'tvs': {
          // 双方向: カソードどうしを向かい合わせた 2 つのツェナー。降伏電圧は型番の「5.0CA」の 5.0（逆耐圧）×1.25 で近似
          const vwm = Number(String(c.mpn || c.value).match(/(\d+(?:\.\d+)?)C?A\b/i)?.[1]);
          const bv = prm.bv ? val(prm.bv, '降伏電圧', c.ref) : Number.isFinite(vwm) ? vwm * 1.25 : 6.4;
          const m = { IS: 1e-12, N: 1, RS: 0.1, BV: bv, IBV: 1e-3, NBV: 1.2, CJO: 300e-12 };
          const mid = `${c.ref}#m`;
          elements.push({ type: 'D', name: `${c.ref}_A`, n: [node(1), mid], model: m }, { type: 'D', name: `${c.ref}_B`, n: [node(2), mid], model: { ...m } });
          row.model = `双方向 TVS（降伏 約 ${spiceNum(bv)}V・近似）`;
          break;
        }
        case 'bridge': {
          // 1・2 = ~（交流）, 3 = +, 4 = −。ダイオード 4 本
          const b = mode === 'builtin' && set.key ? { key: set.key, ...lookup(DIODES, set.key) } : builtinFor('bridge', c.value, c.mpn);
          const [a1, a2, pos, neg] = [node(1), node(2), node(3), node(4)];
          elements.push(
            { type: 'D', name: `${c.ref}_1`, n: [a1, pos], model: { ...b.m } }, { type: 'D', name: `${c.ref}_2`, n: [a2, pos], model: { ...b.m } },
            { type: 'D', name: `${c.ref}_3`, n: [neg, a1], model: { ...b.m } }, { type: 'D', name: `${c.ref}_4`, n: [neg, a2], model: { ...b.m } });
          row.model = `ブリッジ（${b.label} ×4）`;
          break;
        }
        case 'transformer': {
          // 値「100V:12V」「10:1」= 1 次:2 次 の巻数比。1 次のインダクタンス・結合係数・巻線抵抗は属性で変えられる
          const m = String(v).replace(/\s/g, '').match(/^([^:]+):([^:]+)$/);
          if (!m) throw new SimError(`巻数比が読めません: ${v}（「100V:12V」「10:1」の形）`);
          const a = val(m[1].replace(/V$/i, ''), '1 次', c.ref), b2 = val(m[2].replace(/V$/i, ''), '2 次', c.ref);
          if (!(a > 0 && b2 > 0)) throw new SimError(`巻数比は 0 より大きくしてください: ${v}`);
          const n2 = b2 / a, lp = prm.lp ? val(prm.lp, '1 次のインダクタンス', c.ref) : 10, k = prm.k ? val(prm.k, '結合係数', c.ref) : 0.999;
          const rp = prm.rp ? val(prm.rp, '1 次の巻線抵抗', c.ref) : 1, rs = prm.rs ? val(prm.rs, '2 次の巻線抵抗', c.ref) : 0.1;
          const mp = `${c.ref}#p`, ms = `${c.ref}#s`;
          // 点は 1 と 4: 1→2 と 4→3 が同じ向き
          elements.push({ type: 'R', name: `${c.ref}_RP`, n: [node(1), mp], value: rp }, { type: 'L', name: `${c.ref}_LP`, n: [mp, node(2)], value: lp },
            { type: 'R', name: `${c.ref}_RS`, n: [node(4), ms], value: rs }, { type: 'L', name: `${c.ref}_LS`, n: [ms, node(3)], value: lp * n2 * n2 },
            { type: 'K', name: `K${c.ref}`, n: [], l: [`${c.ref}_LP`, `${c.ref}_LS`], k });
          row.model = `トランス 1:${Number(n2.toPrecision(4))}・1 次 ${spiceNum(lp)}H・結合 ${k}・巻線 ${spiceNum(rp)}Ω / ${spiceNum(rs)}Ω`;
          break;
        }
        case 'fuse': case 'ferrite': {
          const r = prm.r ? val(prm.r, '抵抗', c.ref) : 0.05;
          elements.push({ type: 'R', name: c.ref, n: [node(1), node(2)], value: r });
          row.model = `抵抗 ${spiceNum(r)}Ω`;
          row.note = c.kind === 'fuse' ? '切れる動作はありません' : '直流抵抗だけ（周波数特性はありません）';
          break;
        }
        case 'thermistor': case 'speaker': {
          elements.push({ type: 'R', name: c.ref, n: [node(1), node(2)], value: prm.r ? val(prm.r, '抵抗', c.ref) : val(c.kind === 'speaker' ? v.replace(/Ω|ohm/gi, '') : v, '抵抗値', c.ref) });
          row.model = `抵抗 ${v}`;
          row.note = c.kind === 'thermistor' ? '25°C の値（温度の変化はありません）' : 'インピーダンスを抵抗として（インダクタンスはありません）';
          break;
        }
        case 'testpoint': row.status = 'off'; row.note = '計算に関係しません'; break;
        case 'regulator': {
          // 3 端子レギュレータ（1 = GND, 2 = VO, 3 = VI）: 誤差増幅器（線形の電圧制御電圧源）が NPN の通過素子のベースを動かす。
          // ベースは「入力 − 落差 ＋ 0.7V」でダイオードが抑える（落差より入力が下がると、出力 ≒ 入力 − 落差）。
          // 入力の電流は通過素子を通る（入力側に負荷が見える）。AMS1117 と同じ NPN 型。
          // （飽和つきのオペアンプで作ると、帰還の中で動作点が求まらないことがあったので、線形＋ダイオードの押さえにした）
          const vout = prm.vout ? val(prm.vout, '出力電圧', c.ref) : regulatorVout(c.value || c.mpn);
          if (!(vout > 0)) throw new SimError(`出力電圧が型番から読めません（${c.value}）。「シミュ」の部品のモデルで出力電圧を入れてください`);
          const drop = prm.drop ? val(prm.drop, '落差', c.ref) : /^(L|LM|UA|MC|KA|NJM)?78/i.test(c.value || '') ? 2 : 1.1;
          const [g, o, i] = [node(1), node(2), node(3)];
          const ref = `${c.ref}#r`, e = `${c.ref}#e`, b = `${c.ref}#b`, cl = `${c.ref}#cl`;
          elements.push(
            { type: 'V', name: `${c.ref}_REF`, n: [ref, g], dc: vout },
            { type: 'E', name: `${c.ref}_EA`, n: [e, g, ref, o], gain: 1e4 },
            { type: 'R', name: `${c.ref}_RD`, n: [e, b], value: 1e3 },
            { type: 'V', name: `${c.ref}_OFF`, n: [cl, i], dc: -(drop + 0.05) },
            { type: 'D', name: `${c.ref}_CL`, n: [b, cl], model: { IS: 1e-14, N: 1 } },
            { type: 'C', name: `${c.ref}_CB`, n: [b, g], value: 100e-12 },
            { type: 'Q', name: `${c.ref}_Q`, n: [i, b, o], model: { type: 'npn', IS: 1e-14, BF: 200, BR: 1, VAF: 100 } },
            { type: 'R', name: `${c.ref}_RQ`, n: [i, g], value: 1e3 }, // 自分の消費（5V で 5mA）
            { type: 'R', name: `${c.ref}_RL`, n: [o, g], value: 10e3 }, // 最小負荷（無負荷でも出力が決まる）
          );
          row.model = `レギュレータ 出力 ${spiceNum(vout)}V・落差 約 ${spiceNum(drop)}V（近似）`;
          row.note = `電流制限・過熱保護・ノイズはありません${pinNet.get('1') && pinNet.get('1') !== GROUND ? '。GND ピンが GND 以外のときも基準は GND ピン' : ''}`;
          break;
        }
        case 'relay': {
          // コイル（2–5）は抵抗。接点は状態で決める（コイルの電流で自動では切り替わらない）
          const on = prm.state === 'on', rc = prm.rcoil ? val(prm.rcoil, 'コイル抵抗', c.ref) : 70;
          elements.push({ type: 'R', name: `${c.ref}_COIL`, n: [node(2), node(5)], value: rc },
            { type: 'R', name: `${c.ref}_NO`, n: [node(1), node(3)], value: on ? 0.05 : 1e9 },
            { type: 'R', name: `${c.ref}_NC`, n: [node(1), node(4)], value: on ? 1e9 : 0.05 });
          row.model = `リレー コイル ${spiceNum(rc)}Ω・${on ? 'COM–NO が閉' : 'COM–NC が閉'}`;
          row.note = '接点はコイルの電流では切り替わりません（モデルの画面で状態を選ぶ）';
          break;
        }
        case 'optocoupler': {
          // 1 = A, 2 = K（赤外 LED）, 3 = E, 4 = C。LED の電流 × 変換効率（CTR）を受光トランジスタのコレクタ電流に
          const ctr = prm.ctr ? val(prm.ctr, '変換効率', c.ref) : 1;
          const mid = `${c.ref}#m`, b = `${c.ref}#b`, BF = 100;
          elements.push(
            { type: 'R', name: `${c.ref}_RS`, n: [node(1), mid], value: 0.1 },
            { type: 'D', name: `${c.ref}_LED`, n: [mid, node(2)], model: { IS: 1e-14, N: 1.8, RS: 1, CJO: 20e-12 } },
            { type: 'G', name: `${c.ref}_PH`, n: [node(4), b, node(1), mid], gm: ctr / BF / 0.1 },
            { type: 'Q', name: `${c.ref}_Q`, n: [node(4), b, node(3)], model: { type: 'npn', IS: 1e-14, BF, BR: 1, VAF: 100, CJC: 5e-12 } },
            { type: 'R', name: `${c.ref}_RBE`, n: [b, node(3)], value: 1e6 },
          );
          row.model = `フォトカプラ CTR ${Math.round(ctr * 100)}%（近似）`;
          break;
        }
        case 'crystal': {
          // 水晶の等価回路（直列の R・L・C と並列の C0）。1・3 = 水晶、2・4 = ケース（計算では使わない）
          const f0 = val(v, '周波数', c.ref);
          const rs = prm.rs ? val(prm.rs, '直列抵抗', c.ref) : 50, c1 = prm.c1 ? val(prm.c1, '直列容量', c.ref) : 10e-15, c0 = prm.c0 ? val(prm.c0, '並列容量', c.ref) : 3e-12;
          const l1 = 1 / ((2 * Math.PI * f0) ** 2 * c1);
          const a = `${c.ref}#a`, b = `${c.ref}#b`;
          elements.push({ type: 'R', name: `${c.ref}_R1`, n: [node(1), a], value: rs }, { type: 'L', name: `${c.ref}_L1`, n: [a, b], value: l1 },
            { type: 'C', name: `${c.ref}_C1`, n: [b, node(3)], value: c1 }, { type: 'C', name: `${c.ref}_C0`, n: [node(1), node(3)], value: c0 });
          row.model = `水晶 ${spiceNum(f0)}Hz（R ${spiceNum(rs)}Ω・C1 ${spiceNum(c1)}F・C0 ${spiceNum(c0)}F）`;
          break;
        }
        case 'buzzer': {
          const r = prm.r ? val(prm.r, '抵抗', c.ref) : 42;
          elements.push({ type: 'R', name: c.ref, n: [node(1), node(2)], value: r });
          row.model = `抵抗 ${spiceNum(r)}Ω`;
          row.note = '音・インダクタンスはありません（電磁式のコイルの直流抵抗として）';
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
          row.note = ['ic', 'connector'].includes(c.kind) ? 'モデルなし（SPICE のサブ回路を割り当てると計算に入ります）。ピンは何もつながっていない扱い' : 'モデルなし';
      }
    } catch (e) {
      if (!(e instanceof SimError || e instanceof SpiceError)) throw e;
      row.status = 'error'; row.note = e.message;
      warnings.push(`${c.ref}: ${e.message}`);
    }
  }
  // 回路図に置いた信号源（交流・直流・電流源。値は SPICE の書き方）
  const srcNames = new Set();
  for (const c of nl.simSources || []) {
    const row = { ref: c.ref, compId: c.compId, kind: c.kind, value: c.value, status: 'on', model: '', note: '' };
    rows.push(row);
    const set = s.models[c.compId] || {};
    if (set.mode === 'off') { row.status = 'off'; row.note = 'シミュレーションから外す'; continue; }
    try {
      const pn = new Map(c.pins.map((p) => [p.num, p.net]));
      const nd = (num) => { const n = pn.get(num); if (n) { usedNets.add(n); return nodeOf(n); } return `${c.ref}#${num}`; };
      const type = c.kind === 'isrc' ? 'I' : 'V';
      let e;
      try { e = parseElementLine(`${type}${c.ref} a b ${String(c.value || '').trim() || 'DC 0'}`); } catch (err) { throw new SimError(`値が読めません（SPICE の書き方: DC 5 / AC 1 / SIN(0 1 1k)）: ${err.message}`); }
      if (!Number.isFinite(e.dc) || (e.wave && e.wave.p.some((x) => !Number.isFinite(x)))) throw new SimError(`値が読めません: ${c.value}`);
      elements.push({ ...e, name: c.ref, n: [nd('1'), nd('2')] });
      srcNames.add(c.ref.toUpperCase());
      row.model = `${type === 'I' ? '電流源' : '電圧源'} ${c.value}`;
    } catch (e) {
      if (!(e instanceof SimError || e instanceof SpiceError)) throw e;
      row.status = 'error'; row.note = e.message;
      warnings.push(`${c.ref}: ${e.message}`);
    }
  }
  // 信号源（シミュの画面で足したもの）
  const netNames = new Set(nl.nets.map((n) => n.name));
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
  const noGnd = !elements.some((e) => e.n.includes('0'));
  if (noGnd) warnings.push('GND（0V の基準）につながる素子がありません。GND という名前のネットを置いてください（いまは回路の 1 点を 1kΩ で基準に結んで計算します）');
  tieIsolated(elements, noGnd ? [] : warnings);
  const nodes = ['0'];
  const seen = new Set(['0']);
  for (const e of elements) for (const n of e.n) if (!seen.has(n)) { seen.add(n); nodes.push(n); }
  const off = rows.filter((r) => r.status === 'off' && r.kind !== 'power' && r.kind !== 'gnd' && r.kind !== 'testpoint').map((r) => r.ref);
  if (off.length) warnings.push(`計算に入れない部品（${off.length}）: ${off.slice(0, 12).join(', ')}${off.length > 12 ? ' …' : ''}`);
  return { circuit: { nodes, elements }, rows, warnings, lib };
}

/**
 * GND と何の素子でもつながっていない部分（トランスの 2 次側のように磁気だけで結合した所）を、1kΩ で GND に結ぶ。
 * つながりが無いので電流は流れず、計算の結果は変わらない。結ばないと電位が決まらず、計算が進まない（ngspice は singular matrix）。
 * 容量だけでつながった所は結ばない（交流が流れるので結果が変わる）
 */
export function tieIsolated(elements, warnings = []) {
  const parent = new Map();
  const find = (a) => { let r = a; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(a) !== r) { const nx = parent.get(a); parent.set(a, r); a = nx; } return r; };
  const add = (a) => { if (!parent.has(a)) parent.set(a, a); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  add('0');
  for (const e of elements) {
    if (e.type === 'K' || !e.n.length) continue;
    e.n.forEach(add);
    for (let i = 1; i < e.n.length; i++) union(e.n[0], e.n[i]);
    if (e.type === 'OA') union(e.n[0], '0'); // 出力は中で GND を基準にしている
  }
  const ground = find('0');
  const groups = new Map();
  for (const n of parent.keys()) { const r = find(n); if (r !== ground) { if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); } }
  for (const nodes of groups.values()) {
    const at = nodes.find((n) => !n.includes('#')) || nodes[0];
    elements.push({ type: 'R', name: `RTIE_${at.replace(/[^A-Za-z0-9_]/g, '_')}`, n: [at, '0'], value: 1e3, internal: true });
    warnings.push(`${at}${nodes.length > 1 ? ` など ${nodes.length} 個のノード` : ''} は GND とつながっていないので、1kΩ で GND に結びました（つながりが無いので電流は流れません）`);
  }
  return elements;
}

/** レギュレータの型番 → 出力電圧（AMS1117-3.3 → 3.3、7805・L7812CV → 5・12）。読めなければ NaN */
export function regulatorVout(name) {
  const t = String(name || '').toUpperCase().trim();
  // 78xx は頭（L・LM・UA・MC・KA の後）にあるものだけ（TPS78233 などを 23V と読まない）
  const m78 = t.match(/^(?:L|LM|UA|MC|KA|NJM)?78[LM]?(\d{2})(?!\d)/);
  const m = m78 ? null : t.match(/-(\d+\.\d+|\d+)/);
  const v = m78 ? Number(m78[1]) : m ? Number(m[1]) : NaN;
  // 3302 や 33 のように、型番の数字が電圧そのものでないものは読まない（モデルの画面で入れてもらう）
  return v >= 0.5 && v <= 40 && !(m && /^\d{2,}$/.test(m[1]) && !m78) ? v : NaN;
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
