// node --test tests/multilayer.test.mjs … 4・6層、製造仕様、レジストのブリッジ
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules, runPipeline } from './scenarios.js';
import { createProject } from '../js/core/project.js';
import { getFootprint } from '../js/library/footprints.js';
import { ensurePcb, toNm, setOutlineRect, allPads, addTrackPath, addVia, addBoardZone, copperLayers, mirrorLayer, flipSelection } from '../js/pcb/model.js';
import { computePcbConnectivity } from '../js/pcb/connectivity.js';
import { drcRules, baseRules } from '../js/check/rules.js';
import { runDrc } from '../js/check/drc.js';
import { buildPlot, layerDefs } from '../js/output/plot.js';
import { gerberFiles } from '../js/output/gerber.js';
import { checkFab, adaptFab, defaultFab, orderSheet } from '../js/output/fabspec.js';

const M = await loadModules(new URL('../', import.meta.url));

function board4() {
  const prj = createProject('ML');
  const pcb = ensurePcb(prj);
  pcb.settings.layers = 4;
  setOutlineRect(pcb, 30, 20);
  const put = (ref, fp, x, y, nets) => pcb.footprints.push({ id: 'f' + ref, ref, value: '', fpDef: JSON.parse(JSON.stringify(getFootprint(fp))), x: toNm(x), y: toNm(y), rot: 0, side: 'top', padNets: nets });
  put('R1', 'R_0805', 8, 10, { 1: 'SIG', 2: 'GND' });
  put('R2', 'R_0805', 22, 10, { 1: 'SIG', 2: 'GND' });
  return { prj, pcb };
}

test('層の一覧・反転・層数ごとの既定ルール', () => {
  assert.deepEqual(copperLayers(4), ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  assert.deepEqual(copperLayers(6).length, 6);
  const pcb = { settings: { layers: 4 } };
  assert.equal(mirrorLayer('In1.Cu', pcb), 'In2.Cu');
  assert.equal(mirrorLayer('F.Cu', pcb), 'B.Cu');
  assert.equal(baseRules(2).minTrackWidthMm, 0.127);
  assert.equal(baseRules(4).minTrackWidthMm, 0.09);
  assert.equal(baseRules(6).minViaDrillMm, 0.2);
  const { prj } = board4();
  assert.equal(drcRules(prj).minClearanceMm, 0.09, 'PCB の層数から既定が決まる');
  prj.board.rules.minClearanceMm = 0.1;
  assert.equal(drcRules(prj).minClearanceMm, 0.1, '利用者が変えた値が優先');
});

test('4層: 内層の GND ベタにビアでつなぎ、未配線0・DRCエラー0', () => {
  const { prj, pcb } = board4();
  const p = (ref, n) => allPads(pcb).find((q) => q.ref === ref && q.pad.num === n);
  addTrackPath(pcb, [p('R1', '1'), { x: p('R1', '1').x, y: 5 }, { x: p('R2', '1').x, y: 5 }, p('R2', '1')], 'F.Cu', toNm(0.2), 'SIG');
  addBoardZone(pcb, 'In1.Cu', 'GND');
  for (const r of ['R1', 'R2']) {
    const g = p(r, '2');
    addTrackPath(pcb, [g, { x: g.x + 1.5, y: g.y }], 'F.Cu', toNm(0.3), 'GND');
    const v = addVia(pcb, g.x + 1.5, g.y, 'GND'); v.diameter = toNm(0.45); v.drill = toNm(0.2);
  }
  const c = computePcbConnectivity(pcb, { rules: drcRules(prj) });
  assert.equal(c.unrouted, 0, JSON.stringify(c.ratsnest));
  const r = runDrc(prj, pcb);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.issues.filter((i) => i.level === 'error').map((i) => i.message)));
  // ビア 0.45/0.2 は 4層では OK、2層では NG
  pcb.settings.layers = 2;
  const r2 = runDrc(prj, pcb);
  assert.ok(r2.issues.some((i) => i.rule === 'via_size'));
  assert.ok(r2.issues.some((i) => i.rule === 'layer_missing'), '2層に減らすと内層のベタはエラー');
});

test('4層の Gerber: 内層 .g1 .g2（X2 Copper,L2,Inr）、ドリルは Plated,1,4', () => {
  const { prj, pcb } = board4();
  addBoardZone(pcb, 'In1.Cu', 'GND');
  addBoardZone(pcb, 'In2.Cu', 'SIG');
  addVia(pcb, 15, 15, 'GND'); addVia(pcb, 15, 4, 'SIG'); // ベタが島として消えないよう、各ネットにビア
  const plot = buildPlot(prj, pcb);
  const files = gerberFiles(plot, { project: 'ML', version: 't' });
  const g1 = files.find((f) => f.name.endsWith('.g1')), g2 = files.find((f) => f.name.endsWith('.g2'));
  assert.ok(g1 && g2);
  assert.ok(g1.content.includes('%TF.FileFunction,Copper,L2,Inr*%'));
  assert.ok(g2.content.includes('%TF.FileFunction,Copper,L3,Inr*%'));
  assert.ok(files.find((f) => f.name.endsWith('.gbl')).content.includes('Copper,L4,Bot'));
  assert.ok(files.find((f) => f.name.endsWith('PTH.drl')).content.includes('Plated,1,4,PTH'));
  assert.ok(g1.content.includes('G36*'), '内層のベタ');
  assert.deepEqual(layerDefs(6).filter((l) => /^g\d$/.test(l.ext)).map((l) => l.ext), ['g1', 'g2', 'g3', 'g4']);
});

test('ビアの処理: テンティングならレジスト開口なし、開口ならあり', () => {
  const { prj, pcb } = board4();
  addVia(pcb, 15, 15, 'GND');
  const count = () => buildPlot(prj, pcb).layers['F.Mask'].filter((q) => q.fn === 'ViaPad').length;
  assert.equal(count(), 0);
  prj.board.fab.viaProcess = 'untented';
  assert.equal(count(), 1);
});

test('レジストのブリッジ: 0.4mm ピッチ・幅0.25mm のパッドはレジストが残らないと注意、TSSOP(0.65mm)は問題なし', () => {
  const prj = createProject('MB');
  const pcb = ensurePcb(prj);
  setOutlineRect(pcb, 20, 20);
  const nets = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), `N${i + 1}`]));
  pcb.footprints.push({ id: 'u', ref: 'U1', value: '', fpDef: JSON.parse(JSON.stringify(getFootprint('TSSOP-8'))), x: toNm(10), y: toNm(10), rot: 0, side: 'top', padNets: nets });
  const fine = { id: 'X', name: 'X', pads: Array.from({ length: 4 }, (_, i) => ({ num: String(i + 1), x: i * 0.4, y: 0, w: 0.25, h: 1, shape: 'rect', type: 'smd' })), body: { w: 2, h: 1.2 }, courtyard: { x0: -0.5, y0: -1, x1: 1.8, y1: 1 } };
  pcb.footprints.push({ id: 'x', ref: 'U2', value: '', fpDef: fine, x: toNm(4), y: toNm(4), rot: 0, side: 'top', padNets: { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' } });
  pcb.footprints.push({ id: 'r', ref: 'R1', value: '', fpDef: JSON.parse(JSON.stringify(getFootprint('R_0805'))), x: toNm(10), y: toNm(16), rot: 0, side: 'top', padNets: { 1: 'A', 2: 'B' } });
  const r = runDrc(prj, pcb);
  const mb = r.issues.filter((i) => i.rule === 'mask_bridge');
  assert.equal(mb.length, 1, JSON.stringify(mb));
  assert.deepEqual(mb[0].refs, ['U2'], 'TSSOP(0.25mm の隙間 − 開口 0.05mm×2 = 0.15mm)と 0805 は残る');
  assert.match(mb[0].message, /3 か所/);
});

test('製造仕様: 層数に合わせた補正と矛盾の検出、注文一覧', () => {
  assert.equal(adaptFab(defaultFab(2), 6).finish, 'ENIG', '6層は HASL 不可');
  assert.equal(adaptFab({ ...defaultFab(4), thicknessMm: 0.6 }, 4).thicknessMm, 1.6);
  assert.equal(adaptFab(defaultFab(2), 4).stackup, 'JLC7628');
  assert.ok(checkFab({ ...defaultFab(6), finish: 'HASL' }, 6).some((x) => x.level === 'error'));
  assert.ok(checkFab({ ...defaultFab(2), maskColor: 'white', silkColor: 'white' }, 2).some((x) => /同じ色/.test(x.message)));
  assert.deepEqual(checkFab(defaultFab(4), 4), []);
  const s = orderSheet({ layers: 4, fab: defaultFab(4), board: { w: 30, h: 20 }, files: ['.GTL', '.G1', '.G2', '.GBL'], holes: 3, minTrack: 0.2, minDrill: 0.2, smdParts: 2 });
  assert.match(s.text, /Layers: 4/);
  assert.match(s.text, /JLC7628/);
  assert.match(s.text, /G1\(L2\) \/ G2\(L3\)/);
});

test('通し: テストC を 4層（内層 GND・+3V3）で', async () => {
  const r = await runPipeline(M, 'C', { layers: 4 });
  assert.equal(r.erc.errors, 0);
  assert.ok(r.gerber.files.includes('In1_Cu.g1') && r.gerber.files.includes('In2_Cu.g2'), JSON.stringify(r.gerber.files));
  for (const k of Object.keys(r.drc.byRule)) assert.ok(['error:unrouted', 'warning:footprint_unverified', 'warning:mask_bridge'].includes(k), JSON.stringify(r.drc.byRule));
});
