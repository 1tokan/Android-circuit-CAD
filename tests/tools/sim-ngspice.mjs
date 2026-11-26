// Pocket EDA の回路シミュレータを ngspice（KiCad の回路シミュレータの中身）と比べる（ngspice が要る。CI では動かさない）
// 使い方: node tests/tools/sim-ngspice.mjs [サンプルの JSON]
//  同じ回路を Pocket EDA の SPICE 書き出し（writeSpice）で ngspice に渡し、波形の差の最大を表示する。
//  ngspice は既定の刻みが粗いことがあるので、過渡は最大の刻みを指定して比べる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Simulator, freqList } from '../../js/sim/engine.js';
import { writeSpice, parseSpice, flatten, toCircuit } from '../../js/sim/spice.js';
import { buildCircuit } from '../../js/sim/circuit.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peda-ng-'));
const interp = (xs, ys, x) => { let lo = 0, hi = xs.length - 1; if (x <= xs[0]) return ys[0]; if (x >= xs[hi]) return ys[hi]; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; } return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]); };

async function compare(title, circ, an, sigs, limit) {
  const names = new Map();
  const deck = writeSpice(circ, { names, title, analyses: ['.options rshunt=1e12'] });
  const ngn = (s) => s.replace(/\((.*)\)/, (_, n) => `(${names.get(n) ?? n})`).replace(/^I\((.*)\)$/, (m, n) => `I(${/^[A-Z]/i.test(n) && /^[VL]/i.test(n) ? n : n})`);
  const out = path.join(dir, 'ng.txt');
  fs.writeFileSync(path.join(dir, 'c.cir'), deck.replace(/\.end\s*$/, '') + `.control\nset wr_singlescale\noption numdgt=8\n${an.ng}\nwrdata ${out} ${sigs.map(ngn).join(' ')}\n.endc\n.end\n`);
  execFileSync('ngspice', ['-b', path.join(dir, 'c.cir')], { stdio: 'pipe' });
  const ng = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.every(Number.isFinite));
  const r = await an.ours(new Simulator(circ));
  let bad = 0;
  sigs.forEach((n, j) => {
    const i = r.names.indexOf(n);
    const ys = an.ac ? r.re[i].map((re, k) => Math.hypot(re, r.im[i][k])) : r.y?.[i] ?? r.values;
    const xs = r.t || r.f || r.x;
    let maxErr = 0, maxRef = 0;
    for (const row of ng) {
      const ref = an.ac ? Math.hypot(row[1 + 2 * j], row[2 + 2 * j]) : row[1 + j];
      maxErr = Math.max(maxErr, Math.abs(interp(xs, ys, row[0]) - ref)); maxRef = Math.max(maxRef, Math.abs(ref));
    }
    const rel = maxErr / (maxRef || 1);
    if (rel > limit) bad++;
    console.log(`${rel > limit ? 'NG' : 'ok'} ${title} ${an.ng.split(' ')[0]} ${n}: 差の最大 ${maxErr.toExponential(3)}（最大値の ${(rel * 100).toFixed(3)}%）`);
  });
  return bad;
}

const C = (text) => toCircuit(flatten(parseSpice(text)));
let bad = 0;
bad += await compare('RC', C('rc\nV1 in 0 PULSE(0 1 0 1u 1u 1m 2m) AC 1\nR1 in out 1k\nC1 out 0 1u\n.end'), { ng: 'tran 10u 5m 0 10u', ours: (s) => s.tran(10e-6, 5e-3, { tmax: 10e-6 }) }, ['V(out)'], 1e-3);
bad += await compare('RC', C('rc\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.end'), { ac: true, ng: 'ac dec 10 1 1meg', ours: (s) => s.ac(freqList('dec', 10, 1, 1e6)) }, ['V(out)'], 1e-6);
const D1 = '.model D1N4148 D(IS=2.52n N=1.752 RS=0.568 BV=100 IBV=100u CJO=4p M=0.333 VJ=0.5 TT=11.5n)';
bad += await compare('半波整流', C(`d\nV1 in 0 SIN(0 5 1k)\nD1 in out D1N4148\nR1 out 0 1k\nC1 out 0 10u\n${D1}\n.end`), { ng: 'tran 5u 5m 0 5u', ours: (s) => s.tran(5e-6, 5e-3, { tmax: 5e-6 }) }, ['V(out)'], 3e-3);
const Q = '.model Q2N3904 NPN(IS=6.734f BF=416.4 BR=0.7371 NF=1 NR=1 VAF=74.03 CJE=4.493p MJE=0.2593 VJE=0.75 CJC=3.638p MJC=0.3085 VJC=0.75 TF=301.2p)';
const ce = `ce\nVCC vcc 0 12\nVIN in 0 DC 0 AC 1 SIN(0 10m 1k)\nC1 in b 10u\nR1 vcc b 47k\nR2 b 0 10k\nRC vcc c 4.7k\nRE e 0 1k\nCE e 0 100u\nQ1 c b e Q2N3904\n${Q}\n.end`;
bad += await compare('CE 増幅', C(ce), { ac: true, ng: 'ac dec 10 10 100meg', ours: (s) => s.ac(freqList('dec', 10, 10, 1e8)) }, ['V(c)'], 2e-3);
bad += await compare('CE 増幅', C(ce), { ng: 'tran 5u 3m 0 5u', ours: (s) => s.tran(5e-6, 3e-3, { tmax: 5e-6 }) }, ['V(c)'], 2e-3);
const P = '.model PAO3401 PMOS(LEVEL=1 VTO=-0.9 KP=6.3 LAMBDA=0.01 CGSO=585p CGDO=60p)';
bad += await compare('P-MOS ゆっくり立ち上げ', C(`p\nVBUS vbus 0 PULSE(0 5 0 100u 1m 1 2)\nM1 out g vbus vbus PAO3401 W=1 L=1\nC40 vbus g 4.7u\nR15 g 0 100k\nC39 g out 100n\nCL out 0 47u\nRL out 0 100\n${P}\n.end`), { ng: 'tran 100u 200m 0 100u', ours: (s) => s.tran(100e-6, 0.2, { tmax: 100e-6 }) }, ['V(out)', 'V(g)'], 2e-3);
const oa = { nodes: ['0'], elements: [
  { type: 'V', name: 'VCC', n: ['vcc', '0'], dc: 5 },
  { type: 'V', name: 'VIN', n: ['in', '0'], dc: 0.4, ac: { mag: 1, ph: 0 }, wave: { type: 'sin', p: [0.4, 0.3, 1000] } },
  { type: 'R', name: 'R1', n: ['out', 'fb'], value: 10e3 }, { type: 'R', name: 'R2', n: ['fb', '0'], value: 2.2e3 },
  { type: 'OA', name: 'U1', n: ['in', 'fb', 'out', 'vcc', '0'], model: { A: 1e5, GBW: 1e6, ROUT: 10, VOH: 1.5, VOL: 0.05 } }] };
oa.nodes = ['0', ...new Set(oa.elements.flatMap((e) => e.n).filter((n) => n !== '0'))];
bad += await compare('オペアンプ（飽和あり）', oa, { ng: 'tran 0.5u 3m 0 0.5u', ours: (s) => s.tran(5e-6, 3e-3, { tmax: 0.5e-6 }) }, ['V(out)'], 3e-3);
bad += await compare('オペアンプ', { ...oa, elements: oa.elements.map((e) => (e.name === 'VIN' ? { ...e, dc: 0.3, wave: undefined } : e)) }, { ac: true, ng: 'ac dec 10 10 10meg', ours: (s) => s.ac(freqList('dec', 10, 10, 1e7)) }, ['V(out)'], 1e-6);

// 時定数が素子の容量だけで決まる回路（関係ない平滑の C がほかにある）: 刻みの誤差を容量の状態で見る変更の確かめ。
// 既知の差: ゲート容量 約 3.5%・接合容量 約 0.6%（0.13.2 以前のエンジンでも 4.6%・0.6%。刻みを細かくしても変わらないので、
// 容量のモデルの違い。許容をその分だけ広げ、悪くなったら気づけるようにしておく）
bad += await compare('ゲート容量だけの時定数', C(`g\nVP in 0 PULSE(0 5 10u 10n 10n 40u 100u)\nRG in g 20k\nM1 d g 0 0 NAO\nRD vdd d 1k\nVDD vdd 0 5\nCB vdd 0 10u\n.model NAO NMOS(LEVEL=1 VTO=1.2 KP=10 LAMBDA=0.01 CGSO=600p CGDO=80p)\n.end`), { ng: 'tran 0.2u 200u 0 0.2u', ours: (s) => s.tran(0.2e-6, 200e-6) }, ['V(g)', 'V(d)'], 4e-2);
bad += await compare('ダイオードの接合容量だけ', C(`j\nV1 in 0 SIN(0 1 1meg)\nR1 in a 10k\nD1 a 0 DJ\nC9 x 0 1u\nR9 x 0 1k\n.model DJ D(IS=1e-14 CJO=50p M=0.5 VJ=0.7)\n.end`), { ng: 'tran 5n 5u 0 5n', ours: (s) => s.tran(5e-9, 5e-6) }, ['V(a)'], 8e-3);

// トランス（K の結合）: 100V 50Hz → 12V、ブリッジ整流・平滑
const DR = '.model DRECT D(IS=1n N=1.8 RS=0.05 BV=1000 IBV=10u CJO=20p)';
const tr = `t\nV1 ac 0 SIN(0 141 50) AC 1\nRP ac p 2\nLP p 0 10\nLS s1 s2 0.144\nRS s1 a 0.5\nKT LP LS 0.999\nRB s2 0 1meg\n`;
bad += await compare('トランス', C(`${tr}RL a s2 100\n.end`), { ng: 'tran 50u 60m 0 50u', ours: (s) => s.tran(50e-6, 0.06, { tmax: 50e-6 }) }, ['V(a)'], 3e-3);
bad += await compare('トランス', C(`${tr}RL a s2 100\n.end`), { ac: true, ng: 'ac dec 10 1 100k', ours: (s) => s.ac(freqList('dec', 10, 1, 1e5)) }, ['V(a)'], 1e-6);
bad += await compare('トランス＋ブリッジ整流＋平滑', C(`${tr}D1 a pos DRECT\nD2 s2 pos DRECT\nD3 neg a DRECT\nD4 neg s2 DRECT\nRG neg 0 1m\nC1 pos neg 1000u\nRL pos neg 100\n${DR}\n.end`), { ng: 'tran 50u 100m 0 50u', ours: (s) => s.tran(50e-6, 0.1, { tmax: 50e-6 }) }, ['V(pos)'], 3e-3);

// 同梱サンプル: 電源の入口（Q1）を、回路図から作った回路で
const src = process.argv[2] || new URL('../../samples/usb-dac-amp.json', import.meta.url);
const prj = JSON.parse(fs.readFileSync(src, 'utf8'));
prj.sim = { sources: [{ name: 'VBUS_IN', type: 'V', pos: 'VBUS', neg: 'GND', dc: '0', wave: { type: 'pulse', p: ['0', '5', '1m', '100u', '1m', '1', '2'] } }] };
bad += await compare('サンプル（電源の入口）', buildCircuit(prj).circuit, { ng: 'tran 100u 300m 0 100u', ours: (s) => s.tran(100e-6, 0.3, { tmax: 100e-6 }) }, ['V(+5V_SYS)', 'V(SYS_G)'], 3e-3);
console.log(bad ? `NG ${bad} 件` : 'すべて ngspice と一致（許容範囲内）');
process.exit(bad ? 1 : 0);
