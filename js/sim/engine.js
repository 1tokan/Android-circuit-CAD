// 回路シミュレータの計算部（SPICE と同じ考え方の修正節点解析 MNA ＋ ニュートン法）
//
// 回路: { nodes: ['0', '名前', ...]（0 番が GND）, elements: [...] }（circuit.js・spice.js が作る。SPICE の素子と同じ意味）
//   R  { name, n:[a,b], value }                     抵抗
//   C  { name, n:[a,b], value, ic? }                コンデンサ
//   L  { name, n:[a,b], value, ic? }                インダクタ
//   V  { name, n:[+,-], dc, ac:{mag,ph}, wave }     電圧源（wave: sin・pulse・pwl・exp）
//   I  { name, n:[+,-], dc, ac, wave }              電流源（SPICE と同じく + から源の中を通って - へ流れる）
//   E  { name, n:[+,-,c+,c-], gain }                電圧制御電圧源
//   G  { name, n:[+,-,c+,c-], gm }                  電圧制御電流源（+ から源の中を通って - へ）
//   D  { name, n:[a,k], model }                     ダイオード（IS N RS BV IBV CJO VJ M TT）
//   Q  { name, n:[c,b,e], model }                   バイポーラ（Gummel-Poon の基本: IS BF BR NF NR VAF CJE CJC TF）
//   M  { name, n:[d,g,s,b], model, W, L }           MOSFET レベル 1（VTO KP LAMBDA CGSO CGDO IS）
//   OA { name, n:[+in,-in,out,v+,v-], model }       オペアンプ（利得 A・GBW・出力抵抗・電源までの電圧の落ち。出力は電源の間で飽和）
//
// 解析: op()・dc(源, 値の並び)・ac(周波数の並び)・tran(tstep, tstop, opt)
// 結果の信号名: V(ノード名)、I(素子名)（V・L・E・OA は枝電流、R・C・D・Q・M は素子の電流）

const VT0 = 8.617333262e-5 * 300.15; // 27℃ の熱電圧 kT/q（ngspice と同じ定数）
const GMIN = 1e-12;
const ABSTOL = 1e-12, VNTOL = 1e-6, RELTOL = 1e-3;

export class SimError extends Error {}

// ---------------- 行列 ----------------
/** 実数の連立方程式 A x = b（部分ピボットのガウス消去）。A は n×n の Float64Array（行優先）。A・b は壊す */
function solveReal(A, b, n) {
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(A[i * n + k]); if (v > mx) { mx = v; p = i; } }
    if (mx < 1e-300) throw new SimError('行列が特異です（浮いたノード・電圧源のループ・電流源の直列などを確認）');
    if (p !== k) {
      for (let j = k; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t; }
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    const piv = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / piv;
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / A[i * n + i];
  }
  return x;
}

/** 複素数の連立方程式（実部・虚部を別の配列で）。壊す */
function solveComplex(Ar, Ai, br, bi, n) {
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.hypot(Ar[k * n + k], Ai[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.hypot(Ar[i * n + k], Ai[i * n + k]); if (v > mx) { mx = v; p = i; } }
    if (mx < 1e-300) throw new SimError('AC 解析の行列が特異です');
    if (p !== k) {
      for (let j = k; j < n; j++) {
        let t = Ar[k * n + j]; Ar[k * n + j] = Ar[p * n + j]; Ar[p * n + j] = t;
        t = Ai[k * n + j]; Ai[k * n + j] = Ai[p * n + j]; Ai[p * n + j] = t;
      }
      let t = br[k]; br[k] = br[p]; br[p] = t; t = bi[k]; bi[k] = bi[p]; bi[p] = t;
    }
    const pr = Ar[k * n + k], pi = Ai[k * n + k], d = pr * pr + pi * pi;
    for (let i = k + 1; i < n; i++) {
      const ar = Ar[i * n + k], ai = Ai[i * n + k];
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / d, fi = (ai * pr - ar * pi) / d;
      for (let j = k + 1; j < n; j++) {
        const cr = Ar[k * n + j], ci = Ai[k * n + j];
        Ar[i * n + j] -= fr * cr - fi * ci; Ai[i * n + j] -= fr * ci + fi * cr;
      }
      const cr = br[k], ci = bi[k];
      br[i] -= fr * cr - fi * ci; bi[i] -= fr * ci + fi * cr;
    }
  }
  const xr = new Float64Array(n), xi = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sr = br[i], si = bi[i];
    for (let j = i + 1; j < n; j++) { const ar = Ar[i * n + j], ai = Ai[i * n + j]; sr -= ar * xr[j] - ai * xi[j]; si -= ar * xi[j] + ai * xr[j]; }
    const pr = Ar[i * n + i], pi = Ai[i * n + i], d = pr * pr + pi * pi;
    xr[i] = (sr * pr + si * pi) / d; xi[i] = (si * pr - sr * pi) / d;
  }
  return [xr, xi];
}

// ---------------- 信号源の波形 ----------------
/** 時刻 t の値。wave が無ければ dc */
export function waveValue(src, t) {
  const w = src.wave;
  if (!w) return src.dc || 0;
  const p = w.p || [];
  if (w.type === 'sin') {
    const [vo = 0, va = 0, f = 0, td = 0, th = 0, ph = 0] = p;
    if (t < td) return vo + va * Math.sin((Math.PI * ph) / 180);
    return vo + va * Math.exp(-(t - td) * th) * Math.sin(2 * Math.PI * f * (t - td) + (Math.PI * ph) / 180);
  }
  if (w.type === 'pulse') {
    const [v1 = 0, v2 = 0, td = 0, tr0 = 0, tf0 = 0, pw = Infinity, per = Infinity] = p;
    const tr = tr0 || 1e-12, tf = tf0 || 1e-12;
    if (t < td) return v1;
    let u = t - td;
    if (Number.isFinite(per) && per > 0) u %= per;
    if (u < tr) return v1 + ((v2 - v1) * u) / tr;
    if (u < tr + pw) return v2;
    if (u < tr + pw + tf) return v2 + ((v1 - v2) * (u - tr - pw)) / tf;
    return v1;
  }
  if (w.type === 'pwl') {
    if (!p.length) return 0;
    if (t <= p[0]) return p[1];
    for (let i = 2; i < p.length; i += 2) {
      if (t <= p[i]) { const t0 = p[i - 2], v0 = p[i - 1], t1 = p[i], v1 = p[i + 1]; return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
    }
    return p[p.length - 1];
  }
  if (w.type === 'exp') {
    const [v1 = 0, v2 = 0, td1 = 0, tau1 = 1e-9, td2 = Infinity, tau2 = 1e-9] = p;
    if (t < td1) return v1;
    let v = v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
    if (t >= td2) v += (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
    return v;
  }
  return src.dc || 0;
}

/** 波形の角（この時刻ちょうどに刻みを合わせる）。t0〜t1 の間 */
function breakpoints(src, t1) {
  const w = src.wave;
  if (!w) return [];
  const p = w.p || [];
  const out = [];
  if (w.type === 'pulse') {
    const [, , td = 0, tr0 = 0, tf0 = 0, pw = Infinity, per = Infinity] = p;
    const tr = tr0 || 1e-12, tf = tf0 || 1e-12;
    const n = Number.isFinite(per) && per > 0 ? Math.min(100000, Math.ceil((t1 - td) / per) + 1) : 1;
    for (let k = 0; k < n; k++) {
      const b = td + k * (Number.isFinite(per) ? per : 0);
      for (const x of [b, b + tr, b + tr + pw, b + tr + pw + tf]) if (x >= 0 && x <= t1 && Number.isFinite(x)) out.push(x);
      if (out.length > 400000) break;
    }
  } else if (w.type === 'pwl') { for (let i = 0; i < p.length; i += 2) if (p[i] <= t1) out.push(p[i]); }
  else if (w.type === 'sin' || w.type === 'exp') { if (p[3] && w.type === 'sin') out.push(p[3]); if (w.type === 'exp') out.push(p[2] || 0, p[4]); }
  return out.filter((x) => Number.isFinite(x));
}

// ---------------- 素子の式 ----------------
function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) { const arg = 1 + (vnew - vold) / vt; vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit; }
    else vnew = vt * Math.log(vnew / vt);
  }
  return vnew;
}
function fetlim(vnew, vold, vto) {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2, vtstlo = vtsthi / 2 + 2, vtox = vto + 3.5, delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) { if (vnew >= vtox) { if (-delv > vtstlo) vnew = vold - vtstlo; } else vnew = Math.max(vnew, vto + 2); }
      else if (delv >= vtsthi) vnew = vold + vtsthi;
    } else if (delv <= 0) vnew = Math.max(vnew, vto - 0.5);
    else vnew = Math.min(vnew, vto + 4);
  } else if (delv <= 0) { if (-delv > vtsthi) vnew = vold - vtsthi; }
  else { const vtemp = vto + 0.5; if (vnew <= vtemp) { if (delv > vtstlo) vnew = vold + vtstlo; } else vnew = vtemp; }
  return vnew;
}
function limvds(vnew, vold) {
  if (vold >= 3.5) { if (vnew > vold) vnew = Math.min(vnew, 3 * vold + 2); else if (vnew < 3.5) vnew = Math.max(vnew, 2); }
  else if (vnew > vold) vnew = Math.min(vnew, 4);
  else vnew = Math.max(vnew, -0.5);
  return vnew;
}

/** ダイオードの電流と微分（GMIN 込み） */
export function diodeIV(vd, m, vt = VT0) {
  const nvt = (m.N || 1) * vt, is = m.IS ?? 1e-14;
  const e = Math.exp(Math.min(vd / nvt, 200));
  let id = is * (e - 1), gd = (is * e) / nvt;
  if (m.BV && vd < -m.BV + 50 * nvt) {
    const ibv = m.IBV ?? 1e-3, nbv = (m.NBV || m.N || 1) * vt;
    const eb = Math.exp(Math.min(-(vd + m.BV) / nbv, 200));
    id -= ibv * eb; gd += (ibv * eb) / nbv;
  }
  return { id: id + GMIN * vd, gd: gd + GMIN };
}
/** 接合の容量（空乏層 ＋ 拡散） */
function junctionCap(v, cj0, vj = 1, mj = 0.5, fc = 0.5) {
  if (!cj0) return 0;
  if (v < fc * vj) return cj0 * Math.pow(1 - v / vj, -mj);
  return (cj0 / Math.pow(1 - fc, 1 + mj)) * (1 - fc * (1 + mj) + (mj * v) / vj);
}

// ---------------- シミュレータ ----------------
export class Simulator {
  /**
   * @param circuit { nodes, elements }
   * @param opt { temp: ℃（既定 27）, gmin }
   */
  constructor(circuit, opt = {}) {
    this.vt = VT0 * ((opt.temp ?? 27) + 273.15) / 300.15;
    this.nodeNames = circuit.nodes.slice();
    this.nodeIndex = new Map(this.nodeNames.map((n, i) => [n, i]));
    this.elements = circuit.elements.map((e) => ({ ...e }));
    this.setup();
  }

  node(name) {
    if (!this.nodeIndex.has(name)) { this.nodeIndex.set(name, this.nodeNames.length); this.nodeNames.push(name); }
    return this.nodeIndex.get(name);
  }

  /**
   * 電圧源（V・電池）とインダクタ（直流では短絡）だけでできたループを探す。
   * ループがあると行列が解けない（ngspice も singular matrix で止まる）。ループの部品の名前を返す
   */
  voltageLoop() {
    const adj = new Map();
    const link = (a, b, name) => { for (const [x, y] of [[a, b], [b, a]]) { if (!adj.has(x)) adj.set(x, []); adj.get(x).push([y, name]); } };
    const path = (from, to) => {
      const prev = new Map([[from, null]]);
      const q = [from];
      while (q.length) {
        const x = q.shift();
        if (x === to) break;
        for (const [y, name] of adj.get(x) || []) if (!prev.has(y)) { prev.set(y, [x, name]); q.push(y); }
      }
      if (!prev.has(to)) return null;
      const names = [];
      for (let x = to; prev.get(x); x = prev.get(x)[0]) names.push(prev.get(x)[1]);
      return names.reverse();
    };
    for (const e of this.elements) {
      if (e.internal || !['V', 'L'].includes(e.type)) continue;
      const [a, b] = e.n.map(String);
      const p = path(a, b);
      if (p) return [...p, e.name];
      link(a, b, e.name);
    }
    return null;
  }

  setup() {
    const loop = this.voltageLoop();
    if (loop) {
      const kinds = loop.map((n) => (this.elements.find((e) => e.name === n)?.type === 'L' ? `${n}（インダクタ）` : n));
      throw new SimError(`電圧源がループ（または並列）になっています: ${kinds.join(' ・ ')}。同じネットに電圧源を 2 つつながないでください（信号源を消すか、ネットを変えてください）`);
    }
    // 内部ノード（ダイオードの直列抵抗・オペアンプの内部）と、MOSFET のボディダイオード
    const extra = [];
    for (const e of this.elements) {
      e.ni = e.n.map((x) => this.node(String(x)));
      if (e.type === 'D' && e.model.RS > 0) { e.inner = this.node(`${e.name}#a`); }
      if (e.type === 'M') {
        const m = e.model, pol = m.type === 'pmos' ? -1 : 1;
        const isj = m.IS ?? 1e-14;
        // ボディ（バルク）とドレイン・ソースの接合（N チャネル: バルク → ドレイン/ソース が順方向）
        const [d, , s, b] = e.n;
        for (const [x, tag] of [[d, 'bd'], [s, 'bs']]) {
          if (String(x) === String(b)) continue;
          extra.push({ type: 'D', name: `${e.name}#${tag}`, n: pol > 0 ? [b, x] : [x, b], model: { IS: isj, N: 1 }, internal: true, ni: pol > 0 ? [this.node(String(b)), this.node(String(x))] : [this.node(String(x)), this.node(String(b))] });
        }
      }
      if (e.type === 'OA') e.inner = this.node(`${e.name}#int`);
    }
    this.elements.push(...extra);
    this.nn = this.nodeNames.length - 1; // GND を除くノードの数
    let k = this.nn;
    for (const e of this.elements) if (['V', 'L', 'E', 'OA'].includes(e.type)) e.br = k++;
    this.size = k;
    // 素子名 → 素子
    this.byName = new Map(this.elements.map((e) => [e.name, e]));
    if (!this.nn) throw new SimError('ノードがありません（GND のほかにノードが要ります）');
  }

  // 行列の位置（GND は 0 → 行列に入れない）
  idx(n) { return n - 1; }

  /**
   * 行列を組み立てる
   * @param x 今の解
   * @param ctx { mode: 'dc'|'tran', t, h, method: 'be'|'trap', srcScale, gmin, state }
   */
  assemble(x, ctx) {
    const N = this.size, A = new Float64Array(N * N), b = new Float64Array(N);
    const v = (n) => (n ? x[n - 1] : 0);
    const add = (i, j, g) => { if (i && j) A[(i - 1) * N + (j - 1)] += g; };
    const addB = (i, val) => { if (i) b[i - 1] += val; };
    const addR = (r, j, g) => { if (j) A[r * N + (j - 1)] += g; }; // 枝の行
    const addC = (i, c, g) => { if (i) A[(i - 1) * N + c] += g; }; // 枝の列
    const cond = (a, c, g) => { add(a, a, g); add(c, c, g); add(a, c, -g); add(c, a, -g); };
    const st = ctx.state;
    const gminX = ctx.gmin || 0;
    const scale = ctx.srcScale ?? 1;
    const tran = ctx.mode === 'tran';
    const h = ctx.h;
    const trap = ctx.method === 'trap';

    // すべてのノードから GND へごく小さいコンダクタンス（浮いたノードで解けなくならないように）
    for (let i = 1; i <= this.nn; i++) add(i, i, GMIN);

    // 容量の等価回路（台形則 / 後退オイラー）: i = geq v - ieq
    const capStamp = (key, a, c, C) => {
      if (!tran || !C) return;
      const s = st.caps.get(key) || { v: 0, i: 0 };
      const geq = trap ? (2 * C) / h : C / h;
      const ieq = trap ? geq * s.v + s.i : geq * s.v;
      cond(a, c, geq);
      addB(a, ieq); addB(c, -ieq);
    };

    for (const e of this.elements) {
      const n = e.ni;
      switch (e.type) {
        case 'R': cond(n[0], n[1], 1 / e.value); break;
        case 'C': capStamp(e.name, n[0], n[1], e.value); break;
        case 'L': {
          const r = e.br;
          addC(n[0], r, 1); addC(n[1], r, -1);
          addR(r, n[0], 1); addR(r, n[1], -1);
          if (tran) {
            const s = st.inds.get(e.name) || { v: 0, i: 0 };
            const req = trap ? (2 * e.value) / h : e.value / h;
            A[r * N + r] -= req;
            b[r] = trap ? -req * s.i - s.v : -req * s.i;
          }
          // 直流では短絡（v = 0）
          break;
        }
        case 'V': {
          const r = e.br;
          addC(n[0], r, 1); addC(n[1], r, -1);
          addR(r, n[0], 1); addR(r, n[1], -1);
          b[r] = (tran ? waveValue(e, ctx.t) : (ctx.dcOverride?.has(e.name) ? ctx.dcOverride.get(e.name) : e.wave ? waveValue(e, 0) : e.dc || 0)) * scale;
          break;
        }
        case 'I': {
          const val = (tran ? waveValue(e, ctx.t) : (ctx.dcOverride?.has(e.name) ? ctx.dcOverride.get(e.name) : e.wave ? waveValue(e, 0) : e.dc || 0)) * scale;
          addB(n[0], -val); addB(n[1], val);
          break;
        }
        case 'E': {
          const r = e.br;
          addC(n[0], r, 1); addC(n[1], r, -1);
          addR(r, n[0], 1); addR(r, n[1], -1); addR(r, n[2], -e.gain); addR(r, n[3], e.gain);
          break;
        }
        case 'G': add(n[0], n[2], e.gm); add(n[0], n[3], -e.gm); add(n[1], n[2], -e.gm); add(n[1], n[3], e.gm); break;
        case 'D': {
          const m = e.model;
          const a = e.inner || n[0], k = n[1];
          if (e.inner) cond(n[0], e.inner, 1 / m.RS);
          const nvt = (m.N || 1) * this.vt, is = m.IS ?? 1e-14;
          const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * is));
          const vd0 = v(a) - v(k);
          let vd = vd0;
          const ds = st.dev.get(e.name);
          if (ds && ctx.limit) vd = pnjlim(vd, ds.vd, nvt, vcrit);
          if (Math.abs(vd - vd0) > VNTOL + RELTOL * Math.abs(vd0)) st.noncon = true; // 制限したら、まだ収束していない
          const { id, gd } = diodeIV(vd, m, this.vt);
          st.devNew.set(e.name, { vd, id, gd });
          // 電流 id(vd) を a → k に。v(a)-v(k) = vd として線形化
          const g = gd + gminX;
          cond(a, k, g);
          const ieq = id - gd * vd;
          addB(a, -ieq); addB(k, ieq);
          if (tran) capStamp(`${e.name}#cj`, a, k, (st.capVal.get(`${e.name}#cj`) ?? this.diodeCap(vd, gd, m)));
          break;
        }
        case 'Q': {
          const m = e.model, pol = m.type === 'pnp' ? -1 : 1;
          const [c, bb, em] = n;
          const vt = this.vt, is = m.IS ?? 1e-16, nf = (m.NF || 1) * vt, nr = (m.NR || 1) * vt;
          const vcrit = nf * Math.log(nf / (Math.SQRT2 * is)), vcritr = nr * Math.log(nr / (Math.SQRT2 * is));
          const vbe0 = pol * (v(bb) - v(em)), vbc0 = pol * (v(bb) - v(c));
          let vbe = vbe0, vbc = vbc0;
          const ds = st.dev.get(e.name);
          if (ds && ctx.limit) { vbe = pnjlim(vbe, ds.vbe, nf, vcrit); vbc = pnjlim(vbc, ds.vbc, nr, vcritr); }
          if (Math.abs(vbe - vbe0) > VNTOL + RELTOL * Math.abs(vbe0) || Math.abs(vbc - vbc0) > VNTOL + RELTOL * Math.abs(vbc0)) st.noncon = true;
          const ef = Math.exp(Math.min(vbe / nf, 200)), er = Math.exp(Math.min(vbc / nr, 200));
          const If = is * (ef - 1) + GMIN * vbe, gif = (is * ef) / nf + GMIN;
          const Ir = is * (er - 1) + GMIN * vbc, gir = (is * er) / nr + GMIN;
          const bf = m.BF ?? 100, br = m.BR ?? 1;
          const vaf = m.VAF && Number.isFinite(m.VAF) ? m.VAF : 0;
          const q = vaf ? 1 - vbc / vaf : 1;
          const Ict = (If - Ir) * q;
          const dIct_dvbe = gif * q, dIct_dvbc = -gir * q - (vaf ? (If - Ir) / vaf : 0);
          const Ic = Ict - Ir / br, Ib = If / bf + Ir / br;
          const dIc_dvbe = dIct_dvbe, dIc_dvbc = dIct_dvbc - gir / br;
          const dIb_dvbe = gif / bf, dIb_dvbc = gir / br;
          st.devNew.set(e.name, { vbe, vbc, ic: pol * Ic, ib: pol * Ib, gm: dIc_dvbe, gmc: dIc_dvbc, gpi: dIb_dvbe, gmu: dIb_dvbc });
          // 端子に入る電流（実際の向き）= pol × I(vbe, vbc)。制限後の (vbe, vbc) のまわりで線形化:
          //   pol·I ≈ pol·(I0 − gbe·vbe − gbc·vbc) + gbe·(vb − ve) + gbc·(vb − vc)   （vbe = pol(vb−ve)、vbc = pol(vb−vc)）
          const stampTerm = (node, I0, gbe, gbc) => {
            add(node, bb, gbe + gbc); add(node, em, -gbe); add(node, c, -gbc);
            addB(node, -pol * (I0 - gbe * vbe - gbc * vbc));
          };
          stampTerm(c, Ic, dIc_dvbe, dIc_dvbc);
          stampTerm(bb, Ib, dIb_dvbe, dIb_dvbc);
          stampTerm(em, -(Ic + Ib), -(dIc_dvbe + dIb_dvbe), -(dIc_dvbc + dIb_dvbc));
          if (gminX) { cond(bb, em, gminX); cond(bb, c, gminX); }
          if (tran) {
            const sCap = this.bjtCaps(vbe, vbc, dIc_dvbe, m);
            capStamp(`${e.name}#cbe`, bb, em, st.capVal.get(`${e.name}#cbe`) ?? sCap.cbe);
            capStamp(`${e.name}#cbc`, bb, c, st.capVal.get(`${e.name}#cbc`) ?? sCap.cbc);
          }
          break;
        }
        case 'M': {
          const m = e.model, pol = m.type === 'pmos' ? -1 : 1;
          const [d, g, s] = n;
          const vto = pol * (m.VTO ?? (pol > 0 ? 1 : -1));
          const vgs0 = pol * (v(g) - v(s)), vds0 = pol * (v(d) - v(s));
          let vgs = vgs0, vds = vds0;
          const ds = st.dev.get(e.name);
          if (ds && ctx.limit) {
            if (ds.vds >= 0) { vgs = fetlim(vgs, ds.vgs, vto); vds = limvds(vds, ds.vds); }
            else { const vgd = fetlim(vgs - vds, ds.vgs - ds.vds, vto); vds = -limvds(-vds, -ds.vds); vgs = vgd + vds; }
          }
          if (Math.abs(vgs - vgs0) > VNTOL + RELTOL * Math.abs(vgs0) || Math.abs(vds - vds0) > VNTOL + RELTOL * Math.abs(vds0)) st.noncon = true;
          const beta = (m.KP ?? 2e-5) * (e.W ?? 1) / (e.L ?? 1), lam = m.LAMBDA ?? 0;
          const rev = vds < 0;
          const vgsE = rev ? vgs - vds : vgs, vdsE = rev ? -vds : vds;
          const vov = vgsE - vto;
          let id = 0, gm = 0, gds = 0;
          if (vov > 0) {
            if (vdsE < vov) { id = beta * (vov - vdsE / 2) * vdsE * (1 + lam * vdsE); gm = beta * vdsE * (1 + lam * vdsE); gds = beta * (vov - vdsE) * (1 + lam * vdsE) + beta * (vov - vdsE / 2) * vdsE * lam; }
            else { id = (beta / 2) * vov * vov * (1 + lam * vdsE); gm = beta * vov * (1 + lam * vdsE); gds = (beta / 2) * vov * vov * lam; }
          }
          st.devNew.set(e.name, { vgs, vds, id: pol * (rev ? -id : id), gm, gds });
          // ドレイン → ソースの電流（実際の向き）を、制限後の電圧のまわりで線形化して I = K + Σ c·v
          //   通常:  I = pol·(id − gm·vgs − gds·vds) + gm·(vg − vs) + gds·(vd − vs)
          //   逆:    I = −pol·(id − gm·vgd − gds·vsd) − gm·(vg − vd) − gds·(vs − vd)   （vgd = vgs − vds、vsd = −vds）
          let K, cs;
          if (!rev) { K = pol * (id - gm * vgs - gds * vds); cs = [[g, gm], [s, -gm - gds], [d, gds]]; }
          else { K = -pol * (id - gm * (vgs - vds) - gds * -vds); cs = [[g, -gm], [d, gm + gds], [s, -gds]]; }
          for (const [kk, cc] of cs) { add(d, kk, cc); add(s, kk, -cc); }
          addB(d, -K); addB(s, K);
          if (tran) {
            capStamp(`${e.name}#cgs`, g, s, m.CGSO ? m.CGSO * (e.W ?? 1) : 0);
            capStamp(`${e.name}#cgd`, g, d, m.CGDO ? m.CGDO * (e.W ?? 1) : 0);
          }
          break;
        }
        case 'OA': {
          // 入力 → 内部ノード: 電流 gm (v+ − v−) を 1Ω と容量へ（開ループ利得 A、極 GBW/A）。出力 = 電源の間で飽和する電圧源 ＋ 出力抵抗
          const m = e.model;
          const [ip, im, out, vp, vn] = n;
          const A0 = m.A ?? 1e5, gbw = m.GBW ?? 1e6, rout = m.ROUT ?? 10;
          const it = e.inner;
          // 内部ノード: (A0)(v+ − v−) を 1Ω に → 電圧 = A0 (v+ − v−)。容量で極を作る
          add(it, ip, -A0); add(it, im, A0); add(it, it, 1);
          capStamp(`${e.name}#c`, it, 0, 1 / (2 * Math.PI * (gbw / A0)));
          // 出力: 枝 r の電圧源 vx = f(v(it), v(vp), v(vn))、vx と out の間に rout
          const r = e.br;
          const vhiOff = m.VOH ?? 1.5, vloOff = m.VOL ?? 0.05;
          const hasRails = n.length >= 5; // 電源ピンがつながっていなければ ±15V で飽和
          const vh = hasRails ? v(vp) - vhiOff : 15, vl = hasRails ? v(vn) + vloOff : -15;
          const mid = (vh + vl) / 2, half = Math.max(0.05, (vh - vl) / 2);
          // 飽和の奥へ一度に飛ばないよう、内部ノードの電圧を飽和の少し外までに制限して線形化する（ダイオードの電圧の制限と同じ考え方）
          let vit = v(it);
          {
            // 飽和の深さ u = (v_int − mid)/half。線形の所（|u| ≤ 3）から飽和の奥へ一度に飛ぶときは、飽和の入口（|u| = 3）で止める。
            // 同じ側の飽和の奥どうしは止めない（出力は平らで往復しない。積分器が深く振り切れた解に一度で届く）
            const ds = st.dev.get(e.name), uu = (vit - mid) / half;
            if (ds && ctx.limit && !ctx.oaLinear && Math.abs(uu) > 3 && !(Math.abs(ds.u) >= 3 - 1e-9 && Math.sign(uu) === Math.sign(ds.u))) {
              vit = mid + Math.sign(uu) * 3 * half; st.noncon = true;
            }
          }
          // 動作点を求める最初の段階は飽和させない（線形の解を出発点にする）
          const u = ctx.oaLinear ? 0 : (vit - mid) / half, th = ctx.oaLinear ? 0 : Math.tanh(Math.max(-30, Math.min(30, u)));
          const f = ctx.oaLinear ? vit : mid + half * th;
          const sech2 = 1 - th * th;
          // f = mid + half·tanh(u)、u = (v_int − mid)/half、mid = (vh+vl)/2、half = (vh−vl)/2
          const dfdvit = ctx.oaLinear ? 1 : sech2;
          const dfdvh = ctx.oaLinear ? 0 : 0.5 + th / 2 - (sech2 * (1 + u)) / 2;
          const dfdvl = ctx.oaLinear ? 0 : 0.5 - th / 2 - (sech2 * (1 - u)) / 2;
          // 枝の行: v(out) + rout·i − f = 0（i は内部の電圧源から out へ流れ出る電流）
          A[r * N + r] += rout;
          addR(r, out, 1);
          addR(r, it, -dfdvit);
          if (hasRails) { addR(r, vp, -dfdvh); addR(r, vn, -dfdvl); }
          b[r] = f - dfdvit * vit - (hasRails ? dfdvh * v(vp) + dfdvl * v(vn) : 0);
          addC(out, r, -1); // 枝電流 i は out へ流れ込む
          st.devNew.set(e.name, { f, u });
          break;
        }
        default: throw new SimError(`扱えない素子: ${e.type}（${e.name}）`);
      }
    }
    return { A, b };
  }

  diodeCap(vd, gd, m) { return junctionCap(vd, m.CJO || 0, m.VJ ?? 1, m.M ?? 0.5, m.FC ?? 0.5) + (m.TT || 0) * gd; }
  bjtCaps(vbe, vbc, gm, m) {
    return {
      cbe: junctionCap(vbe, m.CJE || 0, m.VJE ?? 0.75, m.MJE ?? 0.33, m.FC ?? 0.5) + (m.TF || 0) * gm,
      cbc: junctionCap(vbc, m.CJC || 0, m.VJC ?? 0.75, m.MJC ?? 0.33, m.FC ?? 0.5),
    };
  }

  /** ニュートン法。収束しなければ null */
  newton(x0, ctx, maxIt = 100) {
    let x = Float64Array.from(x0);
    const st = ctx.state;
    for (let it = 0; it < maxIt; it++) {
      st.devNew = new Map();
      st.noncon = false;
      const { A, b } = this.assemble(x, { ...ctx, limit: it > 0 || !!ctx.limitFirst });
      const noncon = st.noncon;
      let xn;
      try { xn = solveReal(A, b, this.size); } catch (e) { if (e instanceof SimError) return null; throw e; }
      if (!xn.every(Number.isFinite)) return null;
      let ok = it > 0 && !noncon;
      for (let i = 0; i < this.size; i++) {
        const tol = RELTOL * Math.max(Math.abs(xn[i]), Math.abs(x[i])) + (i < this.nn ? VNTOL : ABSTOL * 1e3);
        if (Math.abs(xn[i] - x[i]) > tol) { ok = false; break; }
      }
      st.dev = st.devNew;
      x = xn;
      if (ok) return { x, iters: it + 1 };
    }
    return null;
  }

  newState() { return { dev: new Map(), devNew: new Map(), caps: new Map(), inds: new Map(), capVal: new Map() }; }

  /** 動作点（直流）。うまく収束しないときは GMIN を段階的に下げ、それでもだめなら電源を 0 から上げる */
  solveOp(ctx = {}, x0 = null) {
    const st = ctx.state || this.newState();
    const base = { mode: 'dc', state: st, dcOverride: ctx.dcOverride };
    let x = x0 || new Float64Array(this.size);
    // オペアンプがあれば、まず飽和させずに解き、それを出発点にする
    if (!x0 && this.elements.some((e) => e.type === 'OA')) {
      const lin = this.newton(x, { ...base, oaLinear: true }, 150);
      if (lin) x = lin.x;
      st.dev = new Map(); // 飽和の深さ（u）は線形の解から測り直す
    }
    let r = this.newton(x, base, 150);
    if (r) return { x: r.x, state: st, method: 'newton' };
    // GMIN ステップ
    st.dev = new Map();
    let ok = true;
    x = new Float64Array(this.size);
    for (let gm = 1e-2; gm >= 1e-13; gm /= 10) {
      r = this.newton(x, { ...base, gmin: gm > 1e-12 ? gm : 0 }, 150);
      if (!r) { ok = false; break; }
      x = r.x;
    }
    if (ok) return { x, state: st, method: 'gmin' };
    // 電源ステップ
    st.dev = new Map();
    x = new Float64Array(this.size);
    for (let s = 0.05; s <= 1.0001; s += 0.05) {
      r = this.newton(x, { ...base, srcScale: Math.min(1, s) }, 200);
      if (!r) throw new SimError(`動作点が求まりません（電源を ${Math.round(s * 100)}% まで上げたところで収束しません）`);
      x = r.x;
    }
    return { x, state: st, method: 'source' };
  }

  // ---------------- 結果の取り出し ----------------
  signalNames() {
    const out = [];
    for (let i = 1; i <= this.nn; i++) if (!this.nodeNames[i].includes('#')) out.push(`V(${this.nodeNames[i]})`);
    for (const e of this.elements) if (!e.internal && e.type !== 'G') out.push(`I(${e.name})`);
    return out;
  }

  /** 解 x と素子の状態から、全信号の値（同じ順） */
  signals(x, st, ctx = {}) {
    const v = (n) => (n ? x[n - 1] : 0);
    const out = [];
    for (let i = 1; i <= this.nn; i++) if (!this.nodeNames[i].includes('#')) out.push(x[i - 1]);
    for (const e of this.elements) {
      if (e.internal || e.type === 'G') continue;
      const n = e.ni;
      let i = 0;
      switch (e.type) {
        case 'R': i = (v(n[0]) - v(n[1])) / e.value; break;
        case 'C': i = ctx.mode === 'tran' ? (st.caps.get(e.name)?.i ?? 0) : 0; break;
        case 'V': case 'L': case 'E': i = x[e.br]; break;
        case 'OA': i = x[e.br]; break; // 出力ピンから流れ出る電流を正
        case 'I': i = ctx.mode === 'tran' ? waveValue(e, ctx.t) : e.dc || 0; break;
        case 'D': i = st.dev.get(e.name)?.id ?? 0; break;
        case 'Q': i = st.dev.get(e.name)?.ic ?? 0; break;
        case 'M': i = st.dev.get(e.name)?.id ?? 0; break;
        default: break;
      }
      out.push(i);
    }
    return out;
  }

  // ---------------- 解析 ----------------
  /** 動作点: { names, values, devices: [{ name, type, ... }] } */
  op() {
    const r = this.solveOp();
    const names = this.signalNames(), values = this.signals(r.x, r.state);
    const devices = [];
    const v = (n) => (n ? r.x[n - 1] : 0);
    for (const e of this.elements) {
      if (e.internal) continue;
      const d = r.state.dev.get(e.name);
      const n = e.ni;
      if (e.type === 'R') { const i = (v(n[0]) - v(n[1])) / e.value; devices.push({ name: e.name, type: 'R', i, p: i * (v(n[0]) - v(n[1])) }); }
      if (e.type === 'D') devices.push({ name: e.name, type: 'D', vd: d.vd, i: d.id, p: d.vd * d.id });
      if (e.type === 'Q') devices.push({ name: e.name, type: 'Q', vbe: (e.model.type === 'pnp' ? -1 : 1) * d.vbe, vce: v(n[0]) - v(n[2]), ic: d.ic, ib: d.ib, p: d.ic * (v(n[0]) - v(n[2])) + d.ib * (v(n[1]) - v(n[2])) });
      if (e.type === 'M') devices.push({ name: e.name, type: 'M', vgs: v(n[1]) - v(n[2]), vds: v(n[0]) - v(n[2]), id: d.id, p: d.id * (v(n[0]) - v(n[2])) });
      if (e.type === 'V') devices.push({ name: e.name, type: 'V', i: r.x[e.br], p: -r.x[e.br] * (v(n[0]) - v(n[1])) });
    }
    return { names, values, devices, method: r.method };
  }

  /**
   * 直流スイープ: 源 src の値を values の順に変える（2 つ目の源 src2 は外側のループ）
   * @returns { names, x: 値, y: [信号ごとの配列], groups: 2 つ目の値ごとの区切り }
   */
  dc(src, values, src2 = null, values2 = [null]) {
    for (const s of [src, src2].filter(Boolean)) { const e = this.byName.get(s); if (!e || !['V', 'I'].includes(e.type)) throw new SimError(`スイープする電源 ${s} がありません（電圧源・電流源の名前）`); }
    const names = this.signalNames();
    const y = names.map(() => []);
    const xs = [], groups = [];
    for (const v2 of values2) {
      const st = this.newState();
      let x = null;
      groups.push({ value: v2, start: xs.length });
      for (const val of values) {
        const ov = new Map([[src, val]]);
        if (src2) ov.set(src2, v2);
        let r;
        try { r = x ? this.newton(x, { mode: 'dc', state: st, dcOverride: ov }, 100) : null; } catch { r = null; }
        if (!r) r = this.solveOp({ state: this.newState(), dcOverride: ov });
        x = r.x;
        const s = this.signals(x, r.state || st);
        xs.push(val);
        s.forEach((q, i) => y[i].push(q));
      }
    }
    return { names, x: xs, y, groups };
  }

  /**
   * 小信号の交流解析（動作点で線形化）
   * @param freqs 周波数（Hz）の並び
   * @returns { names, f, re: [[]], im: [[]] }
   */
  ac(freqs) {
    const op = this.solveOp();
    const st = op.state;
    // 動作点での導通の行列 G（tran モードの h→∞ 相当）と、容量の行列 C
    st.devNew = new Map();
    const { A: G } = this.assemble(op.x, { mode: 'dc', state: st });
    const N = this.size;
    const Cm = new Float64Array(N * N);
    const addC = (i, j, c) => { if (i && j) Cm[(i - 1) * N + (j - 1)] += c; };
    const capC = (a, b, c) => { if (!c) return; addC(a, a, c); addC(b, b, c); addC(a, b, -c); addC(b, a, -c); };
    const bsrc = new Float64Array(N), bsrcI = new Float64Array(N);
    for (const e of this.elements) {
      const n = e.ni;
      const d = st.dev.get(e.name);
      if (e.type === 'C') capC(n[0], n[1], e.value);
      if (e.type === 'L') Cm[e.br * N + e.br] -= e.value;
      if (e.type === 'D') capC(e.inner || n[0], n[1], this.diodeCap(d.vd, d.gd, e.model));
      if (e.type === 'Q') { const c = this.bjtCaps(d.vbe, d.vbc, d.gm, e.model); capC(n[1], n[2], c.cbe); capC(n[1], n[0], c.cbc); }
      if (e.type === 'M') { capC(n[1], n[2], e.model.CGSO ? e.model.CGSO * (e.W ?? 1) : 0); capC(n[1], n[0], e.model.CGDO ? e.model.CGDO * (e.W ?? 1) : 0); }
      if (e.type === 'OA') capC(e.inner, 0, 1 / (2 * Math.PI * ((e.model.GBW ?? 1e6) / (e.model.A ?? 1e5))));
      if (e.type === 'V' && e.ac) { const ph = ((e.ac.ph || 0) * Math.PI) / 180; bsrc[e.br] = (e.ac.mag || 0) * Math.cos(ph); bsrcI[e.br] = (e.ac.mag || 0) * Math.sin(ph); }
      if (e.type === 'I' && e.ac) {
        const ph = ((e.ac.ph || 0) * Math.PI) / 180, re = (e.ac.mag || 0) * Math.cos(ph), im = (e.ac.mag || 0) * Math.sin(ph);
        if (n[0]) { bsrc[n[0] - 1] -= re; bsrcI[n[0] - 1] -= im; }
        if (n[1]) { bsrc[n[1] - 1] += re; bsrcI[n[1] - 1] += im; }
      }
    }
    // 電圧源の直流分は AC では 0（b を AC の値だけにする）。G の b は使わない
    const names = this.signalNames();
    const re = names.map(() => []), im = names.map(() => []);
    for (const f of freqs) {
      const w = 2 * Math.PI * f;
      const Ar = Float64Array.from(G), Ai = new Float64Array(N * N);
      for (let i = 0; i < N * N; i++) Ai[i] = w * Cm[i];
      const [xr, xi] = solveComplex(Ar, Ai, Float64Array.from(bsrc), Float64Array.from(bsrcI), N);
      const sr = this.acSignals(xr, xi, st, w, true), si = this.acSignals(xr, xi, st, w, false);
      sr.forEach((q, i) => re[i].push(q));
      si.forEach((q, i) => im[i].push(q));
    }
    return { names, f: freqs.slice(), re, im };
  }

  /** AC の信号（実部 or 虚部） */
  acSignals(xr, xi, st, w, real) {
    const x = real ? xr : xi, xo = real ? xi : xr;
    const v = (n) => (n ? x[n - 1] : 0), vo = (n) => (n ? xo[n - 1] : 0);
    const out = [];
    for (let i = 1; i <= this.nn; i++) if (!this.nodeNames[i].includes('#')) out.push(x[i - 1]);
    for (const e of this.elements) {
      if (e.internal || e.type === 'G') continue;
      const n = e.ni, d = st.dev.get(e.name);
      let i = 0;
      switch (e.type) {
        case 'R': i = (v(n[0]) - v(n[1])) / e.value; break;
        // i = jωC v → 実部 = −ωC Im(v)、虚部 = ωC Re(v)
        case 'C': i = (real ? -1 : 1) * w * e.value * (vo(n[0]) - vo(n[1])); break;
        case 'V': case 'L': case 'E': i = x[e.br]; break;
        case 'OA': i = x[e.br]; break;
        case 'D': i = (d?.gd ?? 0) * (v(e.inner || n[0]) - v(n[1])); break;
        // 小信号のコレクタ電流 = ∂Ic/∂vbe·vbe + ∂Ic/∂vbc·vbc（極性は両方に掛かるので消える。容量の電流は含めない）
        case 'Q': i = (d?.gm ?? 0) * (v(n[1]) - v(n[2])) + (d?.gmc ?? 0) * (v(n[1]) - v(n[0])); break;
        case 'M': i = (d?.gm ?? 0) * (v(n[1]) - v(n[2])) + (d?.gds ?? 0) * (v(n[0]) - v(n[2])); break;
        default: break;
      }
      out.push(i);
    }
    return out;
  }

  /**
   * 過渡解析（台形則・刻みは自動）
   * @param tstep 出力の刻みの目安、tstop 終了時刻
   * @param opt { tstart: 記録を始める時刻, tmax: 刻みの上限, uic: 初期値 0 から（動作点を求めない）, maxPoints, onProgress, shouldStop }
   * @returns { names, t, y }
   */
  async tran(tstep, tstop, opt = {}) {
    if (!(tstop > 0)) throw new SimError('終了時刻は 0 より大きくしてください');
    const tmax = Math.min(opt.tmax || Infinity, tstep > 0 ? tstep : tstop / 50, tstop / 50);
    const names = this.signalNames();
    const T = [], Y = names.map(() => []);
    let st = this.newState(), x;
    if (opt.uic) x = new Float64Array(this.size);
    else { const r = this.solveOp(); x = r.x; st = r.state; }
    // 容量・インダクタの初期状態
    const v = (xx, n) => (n ? xx[n - 1] : 0);
    const initCaps = (xx) => {
      for (const e of this.elements) {
        const n = e.ni;
        if (e.type === 'C') st.caps.set(e.name, { v: e.ic != null && opt.uic ? e.ic : v(xx, n[0]) - v(xx, n[1]), i: 0 });
        if (e.type === 'L') st.inds.set(e.name, { v: 0, i: e.ic != null && opt.uic ? e.ic : xx[e.br] });
        if (e.type === 'D') { const vd = v(xx, e.inner || n[0]) - v(xx, n[1]); st.caps.set(`${e.name}#cj`, { v: vd, i: 0 }); const d = st.dev.get(e.name); st.capVal.set(`${e.name}#cj`, this.diodeCap(vd, d?.gd ?? 0, e.model)); }
        if (e.type === 'Q') {
          st.caps.set(`${e.name}#cbe`, { v: v(xx, n[1]) - v(xx, n[2]), i: 0 }); st.caps.set(`${e.name}#cbc`, { v: v(xx, n[1]) - v(xx, n[0]), i: 0 });
          const d = st.dev.get(e.name); if (d) { const c = this.bjtCaps(d.vbe, d.vbc, d.gm, e.model); st.capVal.set(`${e.name}#cbe`, c.cbe); st.capVal.set(`${e.name}#cbc`, c.cbc); }
        }
        if (e.type === 'M') { st.caps.set(`${e.name}#cgs`, { v: v(xx, n[1]) - v(xx, n[2]), i: 0 }); st.caps.set(`${e.name}#cgd`, { v: v(xx, n[1]) - v(xx, n[0]), i: 0 }); }
        if (e.type === 'OA') st.caps.set(`${e.name}#c`, { v: v(xx, e.inner), i: 0 });
      }
    };
    initCaps(x);
    if (opt.uic) {
      // 初期値 0（容量の初期電圧 IC= があればそれ）から、t=0 で一度解く
      const r = this.newton(x, { mode: 'tran', t: 0, h: 1e-15, method: 'be', state: st }, 200);
      if (r) x = r.x;
    }
    const record = (t, xx, ctxR) => { if (t >= (opt.tstart || 0) - 1e-18) { T.push(t); this.signals(xx, st, ctxR).forEach((q, i) => Y[i].push(q)); } };
    record(0, x, { mode: 'tran', t: 0 });
    // 波形の角
    const bps = [...new Set(this.elements.filter((e) => e.type === 'V' || e.type === 'I').flatMap((e) => breakpoints(e, tstop)).filter((b) => b > 0 && b < tstop))].sort((a, b) => a - b);
    let bi = 0;
    let t = 0;
    let h = Math.min(tmax, tstop / 1000, ...(bps.length ? [bps[0] / 2] : []), tstep > 0 ? tstep / 4 : Infinity);
    const hmin = Math.max(tstop * 1e-12, 1e-18);
    let first = true; // 角の直後は後退オイラー（台形則の振動を抑える）
    let xPrev = Float64Array.from(x), tPrev = 0;
    const maxPts = opt.maxPoints || 200000;
    let steps = 0, rejects = 0, lastYield = Date.now();
    while (t < tstop * (1 - 1e-12)) {
      while (bi < bps.length && bps[bi] <= t * (1 + 1e-12) + 1e-21) bi++;
      let hh = Math.min(h, tmax, tstop - t);
      let hitBp = false;
      if (bi < bps.length && t + hh >= bps[bi] - hmin) { hh = bps[bi] - t; hitBp = true; }
      const method = first ? 'be' : 'trap';
      const ctxT = { mode: 'tran', t: t + hh, h: hh, method, state: st };
      // 予測（直前の 2 点から直線で）
      const r = this.newton(x, ctxT, 50);
      let accept = !!r, err = 0;
      if (r && !first && t > tPrev) {
        const k = hh / (t - tPrev);
        for (let i = 0; i < this.nn; i++) {
          const pred = x[i] + (x[i] - xPrev[i]) * k;
          const e = Math.abs(r.x[i] - pred) / (RELTOL * 10 * Math.max(Math.abs(r.x[i]), Math.abs(x[i])) + 1e-3);
          if (e > err) err = e;
        }
        if (err > 4 && hh > hmin * 10) accept = false;
      }
      if (!accept) {
        h = hh / (r ? Math.min(4, Math.max(2, Math.sqrt(err / 4) * 1.5)) : 8);
        rejects++;
        if (h < hmin) throw new SimError(`時刻 ${t.toExponential(3)}s で刻みが小さくなりすぎました（収束しません）`);
        continue;
      }
      // 受け入れ: 容量・インダクタの履歴を更新
      const xn = r.x;
      for (const e of this.elements) {
        const n = e.ni;
        const upd = (key, a, c, C) => {
          if (!C) return;
          const s = st.caps.get(key) || { v: 0, i: 0 };
          const vn = v(xn, a) - v(xn, c);
          const geq = method === 'trap' ? (2 * C) / hh : C / hh;
          const i = method === 'trap' ? geq * (vn - s.v) - s.i : geq * (vn - s.v);
          st.caps.set(key, { v: vn, i });
        };
        if (e.type === 'C') upd(e.name, n[0], n[1], e.value);
        if (e.type === 'L') st.inds.set(e.name, { v: v(xn, n[0]) - v(xn, n[1]), i: xn[e.br] });
        if (e.type === 'D') { const key = `${e.name}#cj`; upd(key, e.inner || n[0], n[1], st.capVal.get(key)); const d = st.dev.get(e.name); st.capVal.set(key, this.diodeCap(d.vd, d.gd, e.model)); }
        if (e.type === 'Q') {
          upd(`${e.name}#cbe`, n[1], n[2], st.capVal.get(`${e.name}#cbe`)); upd(`${e.name}#cbc`, n[1], n[0], st.capVal.get(`${e.name}#cbc`));
          const d = st.dev.get(e.name); const c = this.bjtCaps(d.vbe, d.vbc, d.gm, e.model); st.capVal.set(`${e.name}#cbe`, c.cbe); st.capVal.set(`${e.name}#cbc`, c.cbc);
        }
        if (e.type === 'M') { upd(`${e.name}#cgs`, n[1], n[2], e.model.CGSO ? e.model.CGSO * (e.W ?? 1) : 0); upd(`${e.name}#cgd`, n[1], n[0], e.model.CGDO ? e.model.CGDO * (e.W ?? 1) : 0); }
        if (e.type === 'OA') upd(`${e.name}#c`, e.inner, 0, 1 / (2 * Math.PI * ((e.model.GBW ?? 1e6) / (e.model.A ?? 1e5))));
      }
      xPrev = x; tPrev = t;
      x = xn; t += hh;
      record(t, x, { mode: 'tran', t });
      steps++;
      if (T.length > maxPts) throw new SimError(`点の数が ${maxPts} を超えました（終了時刻を短くするか、刻みを大きくしてください）`);
      first = hitBp;
      // 次の刻み
      const grow = r.iters <= 4 ? 2 : r.iters <= 10 ? 1.2 : 0.7;
      const errFac = err > 0 ? Math.min(2, Math.max(0.5, Math.sqrt(4 / err))) : 2;
      h = Math.min(tmax, hh * Math.min(grow, errFac));
      if (hitBp) h = Math.min(h, (bps[bi + 1] ? (bps[bi + 1] - t) : tmax) / 4, tmax / 4);
      if (opt.onProgress && Date.now() - lastYield > 150) {
        lastYield = Date.now();
        opt.onProgress(t / tstop);
        await new Promise((res) => setTimeout(res, 0));
        if (opt.shouldStop?.()) throw new SimError('中止しました');
      }
    }
    return { names, t: T, y: Y, steps, rejects };
  }
}

/** 周波数の並び（SPICE の dec・oct・lin と同じ） */
export function freqList(type, points, fstart, fstop) {
  const out = [];
  if (!(fstart > 0) || !(fstop >= fstart)) throw new SimError('周波数の範囲が正しくありません');
  if (type === 'lin') { const n = Math.max(1, Math.round(points)); for (let i = 0; i < n; i++) out.push(n === 1 ? fstart : fstart + ((fstop - fstart) * i) / (n - 1)); return out; }
  const per = Math.max(1, Math.round(points)), base = type === 'oct' ? 2 : 10;
  const k = Math.log(fstop / fstart) / Math.log(base);
  const n = Math.floor(k * per + 1e-9);
  for (let i = 0; i <= n; i++) out.push(fstart * Math.pow(base, i / per));
  if (out[out.length - 1] < fstop * (1 - 1e-9)) out.push(fstop);
  return out;
}

/** 値の並び（直流スイープ） */
export function sweepList(start, stop, step) {
  if (!(step !== 0) || !Number.isFinite(step)) throw new SimError('刻みを 0 以外にしてください');
  const n = Math.floor((stop - start) / step + 1e-9);
  if (n < 0) throw new SimError('刻みの符号が範囲と合っていません');
  if (n > 100000) throw new SimError('点の数が多すぎます（10 万点まで）');
  const out = [];
  for (let i = 0; i <= n; i++) out.push(start + step * i);
  return out;
}
