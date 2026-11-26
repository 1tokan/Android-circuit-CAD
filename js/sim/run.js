// シミュレーションを実行する（画面とテストで共通）
import { Simulator, SimError } from './engine.js';
import { buildCircuit, simSettings, analysisParams } from './circuit.js';

/**
 * @param opt { netlist, analysis（設定を上書き）, override: Map(素子名 → 値)（チューニング）, onProgress, shouldStop }
 * @returns {
 *   type, names, warnings, rows, ms,
 *   op:   { values, devices }                         動作点
 *   dc:   { x, y, groups, src, src2 }                 直流スイープ
 *   ac:   { f, re, im }                               交流
 *   tran: { t, y, steps, rejects }                    過渡
 * }
 */
export async function runSimulation(project, opt = {}) {
  const t0 = Date.now();
  const s = simSettings(project);
  const a = opt.analysis || s.analysis;
  const b = buildCircuit(project, { netlist: opt.netlist });
  if (opt.override) for (const e of b.circuit.elements) if (opt.override.has(e.name)) e.value = opt.override.get(e.name);
  const sim = new Simulator(b.circuit);
  const p = analysisParams(a);
  const out = { type: a.type, warnings: b.warnings, rows: b.rows };
  if (a.type === 'op') {
    const r = sim.op();
    Object.assign(out, { names: r.names, op: { values: r.values, devices: r.devices, method: r.method } });
  } else if (a.type === 'dc') {
    if (!a.dc.src) throw new SimError('スイープする信号源を選んでください');
    const r = sim.dc(a.dc.src, p.values, a.dc.src2 || null, p.values2);
    Object.assign(out, { names: r.names, dc: { x: r.x, y: r.y, groups: r.groups, src: a.dc.src, src2: a.dc.src2 } });
  } else if (a.type === 'ac') {
    if (!b.circuit.elements.some((e) => (e.type === 'V' || e.type === 'I') && e.ac && e.ac.mag)) throw new SimError('AC の大きさを入れた信号源がありません（信号源の「AC」に 1 などを入れてください）');
    const r = sim.ac(p.freqs);
    Object.assign(out, { names: r.names, ac: { f: r.f, re: r.re, im: r.im } });
  } else {
    const r = await sim.tran(p.tstep, p.tstop, { tstart: p.tstart, tmax: p.tmax, uic: p.uic, onProgress: opt.onProgress, shouldStop: opt.shouldStop });
    Object.assign(out, { names: r.names, tran: { t: r.t, y: r.y, steps: r.steps, rejects: r.rejects } });
  }
  out.ms = Date.now() - t0;
  return out;
}
