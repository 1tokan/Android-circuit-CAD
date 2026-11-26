// SPICE の文（ネットリスト・.model・.subckt）の読み書き
//
// 読む: R C L V I E G D Q M X の素子、.model、.subckt〜.ends（入れ子可）。行の続き（先頭の +）、注釈（* と ;）
//       ほかの素子（B・F・H・J・S・T・W など）、{式}・.param・.lib・.include は扱えない（理由つきで知らせる）
// 書く: ngspice で読める形（KiCad の回路シミュレータと同じ ngspice）。名前の頭の文字は素子の種類に合わせる

import { parseValue, spiceNum } from './units.js';

export class SpiceError extends Error {}

const num = (t) => {
  const v = parseValue(t, { spice: true });
  if (!Number.isFinite(v)) throw new SpiceError(`数として読めません: ${t}`);
  return v;
};

/** 行に分ける（続きの行をつなぎ、注釈を消す） */
export function spiceLines(text) {
  const out = [];
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    let s = raw.replace(/;.*$/, '').replace(/\$ .*$/, '').trimEnd();
    if (!s.trim() || /^\s*\*/.test(s)) continue;
    if (/^\s*\+/.test(s)) { if (out.length) out[out.length - 1] += ' ' + s.replace(/^\s*\+/, ''); continue; }
    out.push(s.trim());
  }
  return out;
}

/** .model の文 → { name, type, params } */
export function parseModelLine(line) {
  const m = line.match(/^\.model\s+(\S+)\s+([a-z]+)\s*\(?([\s\S]*?)\)?\s*$/i);
  if (!m) throw new SpiceError(`.model の書き方が違います: ${line}`);
  const type = m[2].toLowerCase();
  if (!['d', 'npn', 'pnp', 'nmos', 'pmos'].includes(type)) throw new SpiceError(`.model ${m[1]}: 種類 ${m[2]} は扱えません（D・NPN・PNP・NMOS・PMOS）`);
  const params = {};
  for (const kv of m[3].replace(/[()]/g, ' ').matchAll(/([a-z][a-z0-9_]*)\s*=\s*([^\s=]+)/gi)) {
    const k = kv[1].toUpperCase();
    if (/^\{/.test(kv[2])) throw new SpiceError(`.model ${m[1]}: 式 ${kv[2]} は扱えません`);
    params[k] = num(kv[2]);
  }
  if ((type === 'nmos' || type === 'pmos') && params.LEVEL && params.LEVEL !== 1) throw new SpiceError(`.model ${m[1]}: MOSFET はレベル 1 だけ扱えます（LEVEL=${params.LEVEL}）`);
  return { name: m[1], type, params };
}

/** 値と波形（V・I の行の後ろ） */
function parseSource(tokens) {
  const src = { dc: 0 };
  const s = tokens.join(' ');
  const dc = s.match(/^\s*(?:dc\s+)?([^\s(]+)(?=\s|$)/i);
  if (dc && !/^(ac|sin|pulse|pwl|exp)$/i.test(dc[1])) src.dc = num(dc[1]);
  const dcKw = s.match(/\bdc\s+([^\s(]+)/i);
  if (dcKw) src.dc = num(dcKw[1]);
  const ac = s.match(/\bac\s+([^\s(]+)(?:\s+([^\s(a-z][^\s(]*))?/i);
  if (ac) src.ac = { mag: num(ac[1]), ph: ac[2] ? num(ac[2]) : 0 };
  const w = s.match(/\b(sin|pulse|pwl|exp)\s*\(([^)]*)\)/i);
  if (w) src.wave = { type: w[1].toLowerCase(), p: w[2].trim().split(/[\s,]+/).filter(Boolean).map(num) };
  return src;
}

/**
 * ネットリストを読む
 * @returns { elements: [], models: Map(名前小文字 → model), subckts: Map(名前小文字 → { name, ports, lines }), analyses: [行], title }
 */
export function parseSpice(text, { title = true } = {}) {
  // SPICE のファイルは 1 行目が題名（注釈の * で始まっていても題名）
  let body = String(text);
  const out = { elements: [], models: new Map(), subckts: new Map(), analyses: [], title: '' };
  if (title) { const i = body.indexOf('\n'); out.title = (i < 0 ? body : body.slice(0, i)).replace(/^\*\s*/, '').trim(); body = i < 0 ? '' : body.slice(i + 1); }
  const lines = spiceLines(body);
  let sub = null, depth = 0;
  for (const l of lines) {
    const low = l.toLowerCase();
    if (low.startsWith('.subckt')) {
      if (sub) { depth++; sub.lines.push(l); continue; }
      const t = l.split(/\s+/);
      sub = { name: t[1], ports: t.slice(2).filter((x) => !x.includes('=') && !/^params:$/i.test(x)), lines: [] };
      continue;
    }
    if (low.startsWith('.ends')) {
      if (depth) { depth--; sub.lines.push(l); continue; }
      if (!sub) throw new SpiceError('.ends に対応する .subckt がありません');
      out.subckts.set(sub.name.toLowerCase(), sub); sub = null; continue;
    }
    if (sub) { sub.lines.push(l); continue; }
    if (low.startsWith('.model')) { const m = parseModelLine(l); out.models.set(m.name.toLowerCase(), m); continue; }
    if (/^\.(op|dc|ac|tran|end|control|endc|options?|option|temp|save|probe|print|plot|ic|nodeset)\b/.test(low)) { out.analyses.push(l); continue; }
    if (low.startsWith('.')) throw new SpiceError(`扱えない文です: ${l.split(/\s+/)[0]}（.param・.lib・.include・.func などは未対応）`);
    out.elements.push(parseElementLine(l));
  }
  if (sub) throw new SpiceError(`.subckt ${sub.name} に .ends がありません`);
  return out;
}

/** 素子の行 → 素子（モデルはまだ名前のまま） */
export function parseElementLine(l) {
  const t = l.split(/\s+/);
  const name = t[0], c = name[0].toUpperCase();
  const params = {};
  for (const kv of t.slice(1).join(' ').matchAll(/([a-z][a-z0-9_]*)\s*=\s*([^\s=]+)/gi)) params[kv[1].toUpperCase()] = kv[2];
  const pos = t.slice(1).filter((x) => !x.includes('='));
  switch (c) {
    case 'R': case 'C': case 'L': {
      if (pos.length < 3) throw new SpiceError(`${name}: ノード 2 つと値が要ります`);
      const e = { type: c, name, n: [pos[0], pos[1]], value: num(pos[2]) };
      if (params.IC) e.ic = num(params.IC);
      if (!(e.value > 0)) throw new SpiceError(`${name}: 値は 0 より大きくしてください`);
      return e;
    }
    case 'V': case 'I': return { type: c, name, n: [pos[0], pos[1]], ...parseSource(t.slice(3)) };
    case 'E': case 'G': {
      if (pos.length < 5) throw new SpiceError(`${name}: ノード 4 つと利得が要ります（POLY・式は未対応）`);
      const e = { type: c, name, n: pos.slice(0, 4) };
      if (c === 'E') e.gain = num(pos[4]); else e.gm = num(pos[4]);
      return e;
    }
    case 'D': return { type: 'D', name, n: [pos[0], pos[1]], modelName: pos[2], area: pos[3] ? num(pos[3]) : 1 };
    case 'Q': return { type: 'Q', name, n: [pos[0], pos[1], pos[2]], modelName: pos[pos.length >= 5 && !/^\d/.test(pos[4]) ? 4 : 3], area: 1 };
    case 'M': return { type: 'M', name, n: [pos[0], pos[1], pos[2], pos[3]], modelName: pos[4], W: params.W ? num(params.W) : 1e-4, L: params.L ? num(params.L) : 1e-4 };
    case 'X': return { type: 'X', name, n: pos.slice(0, -1), subckt: pos[pos.length - 1] };
    case 'K': {
      // 結合: K名 L名 L名 結合係数（トランス）
      if (pos.length < 3) throw new SpiceError(`${name}: インダクタ 2 つと結合係数が要ります（例: K1 L1 L2 0.999）`);
      return { type: 'K', name, n: [], l: [pos[0], pos[1]], k: num(pos[2]) };
    }
    default: throw new SpiceError(`${name}: 素子 ${c} は扱えません（R C L K V I E G D Q M X のみ）`);
  }
}

/**
 * サブ回路を展開し、モデルを素子に付ける
 * @param parsed parseSpice の結果（ほかのライブラリの models・subckts を足してよい）
 * @returns 素子の並び（ノード名は文字列、GND は '0'）
 */
export function flatten(parsed, { models = parsed.models, subckts = parsed.subckts } = {}) {
  const out = [];
  const modelOf = (nm, kind) => {
    const m = models.get(String(nm).toLowerCase());
    if (!m) throw new SpiceError(`モデル ${nm} がありません（.model で定義してください）`);
    if (kind === 'D' && m.type !== 'd') throw new SpiceError(`モデル ${nm} はダイオードではありません`);
    if (kind === 'Q' && m.type !== 'npn' && m.type !== 'pnp') throw new SpiceError(`モデル ${nm} はバイポーラではありません`);
    if (kind === 'M' && m.type !== 'nmos' && m.type !== 'pmos') throw new SpiceError(`モデル ${nm} は MOSFET ではありません`);
    return { type: m.type, ...m.params };
  };
  const expand = (els, prefix, map, depth) => {
    if (depth > 20) throw new SpiceError('サブ回路の入れ子が深すぎます');
    const nm = (n) => { const s = String(n); if (s === '0' || /^gnd$/i.test(s)) return '0'; if (map && map.has(s)) return map.get(s); return prefix ? `${prefix}.${s}` : s; };
    for (const e0 of els) {
      const e = { ...e0, name: prefix ? `${prefix}.${e0.name}` : e0.name, n: e0.n.map(nm) };
      if (e.type === 'K') e.l = e0.l.map((x) => (prefix ? `${prefix}.${x}` : x));
      if (e.type === 'X') {
        const sc = subckts.get(String(e0.subckt).toLowerCase());
        if (!sc) throw new SpiceError(`サブ回路 ${e0.subckt} がありません`);
        if (sc.ports.length !== e.n.length) throw new SpiceError(`${e0.name}: サブ回路 ${sc.name} の端子の数 ${sc.ports.length} と、つないだノードの数 ${e.n.length} が違います`);
        const inner = parseSpice(sc.lines.join('\n'), { title: false });
        const m2 = new Map(sc.ports.map((p, i) => [p, e.n[i]]));
        // サブ回路の中の .model / .subckt はそのサブ回路の中だけで使う
        const saveM = new Map(models), saveS = new Map(subckts);
        for (const [k, v] of inner.models) models.set(k, v);
        for (const [k, v] of inner.subckts) subckts.set(k, v);
        expand(inner.elements, e.name, m2, depth + 1);
        models.clear(); for (const [k, v] of saveM) models.set(k, v);
        subckts.clear(); for (const [k, v] of saveS) subckts.set(k, v);
        continue;
      }
      if (e.type === 'D' || e.type === 'Q' || e.type === 'M') {
        e.model = modelOf(e0.modelName, e.type);
        if (e.type === 'D' && e.area && e.area !== 1) e.model = { ...e.model, IS: (e.model.IS ?? 1e-14) * e.area };
        if (e.type === 'M' && !e.n[3]) e.n[3] = e.n[2];
      }
      out.push(e);
    }
  };
  expand(parsed.elements, '', null, 0);
  return out;
}

/** 素子の並び → 回路（ノードの並び） */
export function toCircuit(elements) {
  const nodes = ['0'];
  const seen = new Set(['0']);
  for (const e of elements) for (const n of e.n) if (!seen.has(n)) { seen.add(n); nodes.push(n); }
  return { nodes, elements };
}

// ---------------- 書く ----------------
const PREFIX = { K: 'K', R: 'R', C: 'C', L: 'L', V: 'V', I: 'I', E: 'E', G: 'G', D: 'D', Q: 'Q', M: 'M', OA: 'X' };

/** 名前を SPICE の名前に（頭の文字を種類に合わせ、使えない文字を _ に） */
export function spiceName(type, name) {
  const p = PREFIX[type] || 'X';
  const s = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return s[0]?.toUpperCase() === p ? s : `${p}${s}`;
}

/** ノード名を SPICE のノード名に（GND → 0、使えない文字を _ に。重なれば番号を足す） */
export function nodeNamer() {
  const map = new Map([['0', '0']]), used = new Set(['0']);
  return (n) => {
    const s = String(n);
    if (map.has(s)) return map.get(s);
    let b = s.replace(/[^A-Za-z0-9_]/g, '_') || 'n';
    if (/^\d/.test(b)) b = `n${b}`;
    let nm = b;
    for (let i = 2; used.has(nm.toLowerCase()); i++) nm = `${b}_${i}`;
    used.add(nm.toLowerCase()); map.set(s, nm);
    return nm;
  };
}

function srcText(e) {
  const parts = [`DC ${spiceNum(e.dc || 0)}`];
  if (e.ac) parts.push(`AC ${spiceNum(e.ac.mag || 0)} ${spiceNum(e.ac.ph || 0)}`);
  if (e.wave) parts.push(`${e.wave.type.toUpperCase()}(${e.wave.p.map(spiceNum).join(' ')})`);
  return parts.join(' ');
}

const modelParams = (m, keys) => keys.filter((k) => m[k] !== undefined && Number.isFinite(m[k])).map((k) => `${k}=${spiceNum(m[k])}`).join(' ');

/**
 * 回路 → ngspice のネットリスト
 * @param circuit { elements }（engine と同じ素子。OA はサブ回路にする）
 * @param opt { title, analyses: [行], probes, names: ノード名の対応を返す先 }
 */
export function writeSpice(circuit, opt = {}) {
  const nn = nodeNamer();
  const lines = [`* ${opt.title || 'Pocket EDA'}`];
  const models = new Map(), subs = new Map();
  const mkey = (prefix, m) => {
    const k = JSON.stringify(m);
    if (!models.has(k)) models.set(k, { name: `${prefix}${models.size + 1}`, m });
    return models.get(k).name;
  };
  for (const e of circuit.elements) {
    const n = e.n.map(nn);
    const nm = spiceName(e.type, e.name);
    switch (e.type) {
      case 'R': case 'C': case 'L': lines.push(`${nm} ${n[0]} ${n[1]} ${spiceNum(e.value)}${e.ic != null && e.type !== 'R' ? ` IC=${spiceNum(e.ic)}` : ''}`); break;
      case 'V': case 'I': lines.push(`${nm} ${n[0]} ${n[1]} ${srcText(e)}`); break;
      case 'K': lines.push(`${nm} ${e.l.map((x) => spiceName('L', x)).join(' ')} ${spiceNum(e.k)}`); break;
      case 'E': lines.push(`${nm} ${n.join(' ')} ${spiceNum(e.gain)}`); break;
      case 'G': lines.push(`${nm} ${n.join(' ')} ${spiceNum(e.gm)}`); break;
      case 'D': lines.push(`${nm} ${n[0]} ${n[1]} ${mkey('DMOD', { t: 'D', ...e.model })}`); break;
      case 'Q': lines.push(`${nm} ${n[0]} ${n[1]} ${n[2]} ${mkey('QMOD', { t: e.model.type, ...e.model })}`); break;
      case 'M': lines.push(`${nm} ${n[0]} ${n[1]} ${n[2]} ${n[3] ?? n[2]} ${mkey('MMOD', { t: e.model.type, ...e.model })} W=${spiceNum(e.W ?? 1)} L=${spiceNum(e.L ?? 1)}`); break;
      case 'OA': {
        const m = e.model, rails = e.n.length >= 5;
        const key = JSON.stringify([m, rails]);
        if (!subs.has(key)) subs.set(key, { name: `PEDA_OPAMP${subs.size + 1}`, m, rails });
        lines.push(`${nm} ${n.slice(0, rails ? 5 : 3).join(' ')} ${subs.get(key).name}`);
        break;
      }
      default: throw new SpiceError(`書けない素子: ${e.type}`);
    }
  }
  for (const { name, m } of models.values()) {
    if (m.t === 'D') lines.push(`.model ${name} D(${modelParams(m, ['IS', 'N', 'RS', 'BV', 'IBV', 'CJO', 'VJ', 'M', 'TT'])})`);
    else if (m.t === 'npn' || m.t === 'pnp') lines.push(`.model ${name} ${m.t.toUpperCase()}(${modelParams(m, ['IS', 'BF', 'BR', 'NF', 'NR', 'VAF', 'CJE', 'VJE', 'MJE', 'CJC', 'VJC', 'MJC', 'TF'])})`);
    else lines.push(`.model ${name} ${m.t.toUpperCase()}(LEVEL=1 ${modelParams(m, ['VTO', 'KP', 'LAMBDA', 'CGSO', 'CGDO', 'IS'])})`);
  }
  for (const { name, m, rails } of subs.values()) {
    const A0 = m.A ?? 1e5, gbw = m.GBW ?? 1e6, rout = m.ROUT ?? 10, voh = m.VOH ?? 1.5, vol = m.VOL ?? 0.05;
    const vh = rails ? `(V(vcc)-${spiceNum(voh)})` : '15', vl = rails ? `(V(vee)+${spiceNum(vol)})` : '(-15)';
    lines.push(`.subckt ${name} inp inn out${rails ? ' vcc vee' : ''}`);
    lines.push(`* Pocket EDA のオペアンプ（開ループ利得 ${A0}・GBW ${gbw}Hz・出力抵抗 ${rout}Ω・出力は電源の間で飽和）`);
    lines.push(`G1 0 int inp inn ${spiceNum(A0)}`);
    lines.push('R1 int 0 1');
    lines.push(`C1 int 0 ${spiceNum(1 / (2 * Math.PI * (gbw / A0)))}`);
    lines.push(`B1 x 0 V=(${vh}+${vl})/2+(${vh}-${vl})/2*tanh((V(int)-(${vh}+${vl})/2)/max((${vh}-${vl})/2,1m))`);
    lines.push(`R2 x out ${spiceNum(rout)}`);
    lines.push('.ends');
  }
  for (const a of opt.analyses || []) lines.push(a);
  lines.push('.end');
  if (opt.names) for (const e of circuit.elements) for (const x of e.n) opt.names.set(String(x), nn(x));
  return lines.join('\n') + '\n';
}
