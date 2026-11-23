// node --test tests/current.test.mjs … 配線幅と電流（IPC-2221）
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules, runPipeline } from './scenarios.js';
import { requiredWidthMm, widthCapacityA, viaCapacityA, netWidthFor, checkCurrent } from '../js/check/current.js';

const M = await loadModules(new URL('../', import.meta.url));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test('IPC-2221: 1A・外層 1oz・温度上昇 10℃ は約 0.30mm、内層 0.5oz は約 1.56mm、逆算も一致', () => {
  near(requiredWidthMm(1, { oz: 1, tempRiseC: 10 }), 0.300, 0.005);
  near(requiredWidthMm(1, { internal: true, oz: 0.5, tempRiseC: 10 }), 1.56, 0.02);
  near(widthCapacityA(requiredWidthMm(0.7, { oz: 1 }), { oz: 1 }), 0.7, 1e-9);
  near(viaCapacityA(0.2), 0.53, 0.02);
  assert.equal(requiredWidthMm(0), 0);
});

test('電流を設定したネットの細い配線を DRC が警告し、自動配線は必要な幅で引く', async () => {
  // 設定なしで配線（電源は 0.3mm）
  const r1 = await runPipeline(M, 'A', { route: true });
  const prj = r1.project, pcb = r1.pcb;
  prj.board.current = { tempRiseC: 10, nets: { VBAT: 1.5, GND: 1.5 } };
  const need = netWidthFor(prj, 'VBAT', 'F.Cu');
  assert.ok(need > 0.5 && need < 0.7, `必要幅 ${need}`);
  const issues = checkCurrent(prj, pcb);
  assert.ok(issues.some((i) => i.rule === 'track_current' && /VBAT/.test(i.message)), JSON.stringify(issues));
  const drc = M.drc.runDrc(prj, pcb);
  assert.ok(drc.issues.some((i) => i.rule === 'track_current'));
  assert.ok(drc.checked.some((c) => c.id === 'track_current'));
  // はがして、必要な幅で引き直す
  pcb.tracks = []; pcb.vias = [];
  const { autoroute } = await import(new URL('js/pcb/autoroute.js', M.base).href);
  const res = await autoroute(pcb, M.drc.drcRules(prj), { layers: ['F.Cu', 'B.Cu'], netWidth: (n) => Math.max(netWidthFor(prj, n, 'F.Cu'), netWidthFor(prj, n, 'B.Cu')) });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  const vb = pcb.tracks.filter((t) => t.net === 'VBAT');
  assert.ok(vb.length && vb.every((t) => M.pcb.toMm(t.width) + 1e-6 >= need), vb.map((t) => M.pcb.toMm(t.width)).join(','));
  M.zonefill.fillAllZones(pcb, M.drc.drcRules(prj));
  const drc2 = M.drc.runDrc(prj, pcb);
  assert.equal(drc2.issues.filter((i) => i.rule === 'track_current' && /VBAT/.test(i.message)).length, 0);
  assert.equal(drc2.summary.errors, 0, JSON.stringify(drc2.issues.filter((i) => i.level === 'error').map((i) => i.message)));
});

test('電流の設定はプロジェクトの保存・読み込みで残る', () => {
  const p = M.project.createProject('t');
  p.board.current = { tempRiseC: 20, nets: { VBUS: 0.5 } };
  const q = M.project.parseProject(M.project.serializeProject(p));
  assert.deepEqual(q.board.current, { tempRiseC: 20, nets: { VBUS: 0.5 } });
});
