// 同梱サンプル（USB DAC アンプ）の検査: 回路図 ERC・PCB DRC・製造データ・配置の要件
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModules } from './scenarios.js';

const M = await loadModules(new URL('../', import.meta.url).href);
const prj = M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
const pcb = M.pcb.ensurePcb(prj);
const toMm = M.pcb.toMm;
const fp = (ref) => pcb.footprints.find((f) => f.ref === ref);

test('サンプル: ERC エラー 0・回路図とネットリストが一致', () => {
  const erc = M.erc.runErc(prj);
  assert.equal(erc.summary.errors, 0, erc.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  const nl = M.netlist.generateNetlist(prj);
  assert.equal(nl.components.length, pcb.footprints.length);
});

test('サンプル: 4層・DRC エラー 0・未配線 0', () => {
  assert.equal(pcb.settings.layers, 4);
  M.zonefill.fillAllZones(pcb, M.drc.drcRules(prj));
  const drc = M.drc.runDrc(prj, pcb);
  assert.equal(drc.summary.errors, 0, drc.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  assert.equal(drc.summary.unrouted, 0);
});

test('サンプル: スピーカー端子 L/R は右端、3.5mm ジャックは上辺から差し込む向き', () => {
  const r = M.pcb.boardRect(pcb);
  for (const ref of ['J3', 'J4']) {
    const b = M.pcb.fpBox(fp(ref));
    assert.ok(Math.abs(b.x1 - r.x1) < 1.0, `${ref} が右端にない: ${b.x1} / ${r.x1}`);
  }
  assert.ok(toMm(fp('J3').y) < toMm(fp('J4').y), 'L（J3）が上、R（J4）が下');
  // ジャックの鼻先（KiCad の -y 側）が基板の上辺に来ている
  const j = fp('J2'), body = j.fpDef.body;
  const nose = M.pcb.fpToBoard(j, body.cx, body.cy - body.h / 2);
  assert.ok(Math.abs(nose.y - r.y0) < 1.0, `ジャックの差込口が上辺にない: ${nose.y}`);
  const jb = M.pcb.fpBox(j);
  assert.ok(jb.x1 - jb.x0 < 12, 'ジャックは幅方向（基板の長さを取らない向き）');
  // USB-C は左端
  assert.ok(M.pcb.fpBox(fp('J1')).x0 < r.x0 + 0.5);
});

test('サンプル: Gerber（内層 .g1/.g2・長穴 G85）と BOM/CPL が出せる', () => {
  const plot = M.plot.buildPlot(prj, pcb);
  const files = M.gerber.gerberFiles(plot, { project: 'USB-DAC-AMP', version: 'test' });
  const names = files.map((f) => f.name);
  for (const ext of ['.gtl', '.g1', '.g2', '.gbl', '.gm1', '-PTH.drl', '-NPTH.drl']) assert.ok(names.some((n) => n.endsWith(ext)), ext);
  const pth = files.find((f) => f.name.endsWith('-PTH.drl')).content;
  assert.match(pth, /G85/, 'USB-C の固定足は長穴');
  const asm = M.asm.buildAssembly(prj, pcb, { boards: 5 });
  assert.equal(asm.cpl.length, pcb.footprints.length);
  for (const ref of ['U4', 'U5', 'U6', 'U7', 'U8', 'J1', 'J2', 'J3', 'J4']) assert.ok(asm.bom.some((b) => b.designators.includes(ref) && b.lcsc), `${ref} の LCSC 品番`);
});

const capUf = (v) => { const m = /^([\d.]+)\s*([pnuµm]?)/.exec(String(v)); return m ? +m[1] * ({ p: 1e-6, n: 1e-3, u: 1, 'µ': 1, m: 1e3, '': 1e6 })[m[2]] : 0; };

test('サンプル: 電流の設定どおりの配線幅（track_current／via_current の警告なし）', () => {
  assert.ok(prj.board.current && prj.board.current.nets.VBUS >= 0.5, 'VBUS の電流が設定されている');
  for (const n of ['+5V_SPK', 'SPK_LP', 'SPK_LN', 'SPK_RP', 'SPK_RN']) assert.ok(prj.board.current.nets[n] > 0, n);
  M.zonefill.fillAllZones(pcb, M.drc.drcRules(prj));
  const drc = M.drc.runDrc(prj, pcb);
  const bad = drc.issues.filter((i) => i.rule === 'track_current' || i.rule === 'via_current');
  assert.equal(bad.length, 0, bad.map((i) => i.message).join('\n'));
});

test('サンプル: USB の規格（VBUS 直結の容量 10µF 以下・スピーカー電源はロードスイッチの後ろ・CC を検出）', () => {
  const onNet = (net) => pcb.footprints.filter((f) => Object.values(f.padNets || {}).includes(net));
  const vbusC = onNet('VBUS').filter((f) => /^C/.test(f.ref)).reduce((s, f) => s + capUf(f.value), 0);
  assert.ok(vbusC > 0 && vbusC <= 10, `VBUS 直結の容量 ${vbusC}µF`);
  const u9 = fp('U9');
  assert.equal(u9.padNets['1'], 'VBUS'); assert.equal(u9.padNets['6'], '+5V_SPK'); assert.equal(u9.padNets['3'], 'SPK_PWR');
  for (const ref of ['U7', 'U8']) assert.ok(Object.values(fp(ref).padNets).includes('+5V_SPK'), `${ref} は +5V_SPK から`);
  const u4 = Object.values(fp('U4').padNets);
  assert.ok(u4.includes('CC1') && u4.includes('CC2'), 'CC1/CC2 を ESP32 で読む');
});

test('サンプル: ゲイン 3dB 設定・ジャックの ESD 保護', () => {
  for (const [r, amp, net] of [['R16', 'U7', 'GAIN_L'], ['R17', 'U8', 'GAIN_R']]) {
    assert.equal(fp(r).value, '100k'); assert.equal(fp(amp).padNets['2'], net); assert.ok(Object.values(fp(r).padNets).includes(net));
  }
  assert.ok(Object.values(fp('D2').padNets).includes('HP_L')); assert.ok(Object.values(fp('D3').padNets).includes('HP_R'));
});

test('サンプル: 部品番号のシルクがほかの部品のパッドにかからない', async () => {
  const { refdesConflicts } = await import('../js/pcb/shapes.js');
  assert.equal(refdesConflicts(pcb), 0);
  const drc = M.drc.runDrc(prj, pcb);
  assert.equal(drc.issues.filter((i) => i.rule === 'silk_pad').length, 0);
});

test('部品番号の自動配置: パッドに重ねた番号を動かし、シルクの警告が消える', async () => {
  const { placeRefdes, refdesConflicts } = await import('../js/pcb/shapes.js');
  const q = M.project.parseProject(JSON.stringify(prj)), b = M.pcb.ensurePcb(q);
  const u5 = b.footprints.find((f) => f.ref === 'U5');
  const p1 = M.pcb.fpToBoard(u5, u5.fpDef.pads[0].x, u5.fpDef.pads[0].y);
  u5.hideRef = false; u5.refOffset = { dx: p1.x - toMm(u5.x), dy: p1.y - toMm(u5.y) + 0.5 }; // 1 番ピンのパッドの上
  assert.ok(refdesConflicts(b) >= 1);
  assert.ok(M.drc.runDrc(q, b).issues.some((i) => i.rule === 'silk_pad'), 'パッドにかかった番号は警告になる');
  const r = placeRefdes(b);
  assert.ok(r.moved.includes('U5'), JSON.stringify(r));
  assert.equal(refdesConflicts(b), 0);
  assert.equal(M.drc.runDrc(q, b).issues.filter((i) => i.rule === 'silk_pad').length, 0);
});
