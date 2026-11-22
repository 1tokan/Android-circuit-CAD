// node --test tests/assembly.test.mjs … BOM・CPL（JLCPCB 形式）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../js/core/project.js';
import { getFootprint } from '../js/library/footprints.js';
import { generateFootprint } from '../js/library/pkggen.js';
import { ensurePcb, toNm, setOutlineRect, allPads } from '../js/pcb/model.js';
import { buildAssembly, bomCsv, cplCsv, packageRotation, bomPackageName } from '../js/output/assembly.js';
import { buildPlot } from '../js/output/plot.js';
import { gerberFiles } from '../js/output/gerber.js';

function board(parts) {
  const prj = createProject('T');
  const pcb = ensurePcb(prj);
  setOutlineRect(pcb, 50, 40);
  for (const [ref, fp, x, y, rot = 0, extra = {}] of parts) {
    const def = typeof fp === 'string' ? getFootprint(fp) : fp;
    pcb.footprints.push({ id: 'f' + ref, ref, value: extra.value ?? '10k', lcsc: extra.lcsc ?? 'C17414', fpDef: JSON.parse(JSON.stringify(def)), x: toNm(x), y: toNm(y), rot, side: extra.side || 'top', padNets: {}, dnp: !!extra.dnp, ...(extra.cplRotOffset ? { cplRotOffset: extra.cplRotOffset } : {}) });
  }
  return { prj, pcb };
}
const row = (a, ref) => a.cpl.find((c) => c.designator === ref);

test('CPL: 座標は mm・Y 上向き（Gerber と同じ）', () => {
  const { prj, pcb } = board([['R1', 'R_0805', 10, 5]]);
  const a = buildAssembly(prj, pcb);
  assert.deepEqual([row(a, 'R1').x, row(a, 'R1').y], [10, -5]);
  // Gerber のメタルマスクの2パッドの中点と一致
  const g = gerberFiles(buildPlot(prj, pcb), { project: 'T', version: 't' }).find((f) => f.layer === 'F.Paste').content;
  const pts = [...g.matchAll(/^X(-?\d+)Y(-?\d+)D03\*$/gm)].map((m) => [+m[1] / 1e6, +m[2] / 1e6]);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs((pts[0][0] + pts[1][0]) / 2 - 10) < 1e-9 && Math.abs((pts[0][1] + pts[1][1]) / 2 + 5) < 1e-9);
});

test('CPL: 回転（反時計回りが正）・パッケージ補正・裏面・手動補正', () => {
  const { prj, pcb } = board([
    ['R1', 'R_0805', 10, 10, 0], ['R2', 'R_0805', 10, 15, 90], // 画面で時計回り90° = KiCad の 270°
    ['U1', 'SOIC-8', 20, 10, 0], ['Q1', 'SOT-23', 30, 10, 0], ['C1', 'CP_Elec_5x5.4', 40, 10, 0],
    ['U2', generateFootprint('ic', 'QFN-32-EP(5x5)'), 20, 25, 0],
    ['R3', 'R_0805', 30, 25, 0, { side: 'bottom' }], ['R4', 'R_0805', 30, 30, 90, { side: 'bottom' }],
    ['U3', 'SOIC-8', 40, 25, 0, { cplRotOffset: 90 }],
  ]);
  const a = buildAssembly(prj, pcb);
  assert.equal(row(a, 'R1').rotation, 0);
  assert.equal(row(a, 'R2').rotation, 270);
  assert.equal(row(a, 'U1').rotation, 270, 'SOIC は KiCad 基準から 270°');
  assert.equal(row(a, 'Q1').rotation, 180, 'SOT-23 は 180°');
  assert.equal(row(a, 'C1').rotation, 180);
  assert.equal(row(a, 'U2').rotation, 90, 'QFN は 90°');
  assert.equal(row(a, 'R3').rotation, 180, '裏面: 180 - θ');
  assert.equal(row(a, 'R3').layer, 'Bottom');
  assert.equal(row(a, 'R4').rotation, 270, '裏面: θ=-90 → 180-(-90) = 270');
  assert.equal(row(a, 'U3').rotation, 0, '270 + 手動 90');
  assert.ok(a.problems.some((p) => /裏面/.test(p.message)));
});

test('補正表: 自動生成フットプリントはパッケージ名で照合', () => {
  assert.equal(packageRotation(generateFootprint('ic', 'TSSOP-20')).deg, 270);
  assert.equal(packageRotation(generateFootprint('ic', 'SOT-23-6')).deg, 180);
  assert.equal(packageRotation(getFootprint('R_0603')).deg, 0);
  assert.equal(bomPackageName(getFootprint('C_0603')), '0603');
  assert.equal(bomPackageName(getFootprint('SOIC-8')), 'SOIC-8');
});

test('BOM: 同じ値・パッケージ・LCSC品番をまとめ、DNP を除き、LCSC 無しはエラー', () => {
  const { prj, pcb } = board([
    ['R1', 'R_0805', 5, 5], ['R10', 'R_0805', 10, 5], ['R2', 'R_0805', 15, 5],
    ['C1', 'C_0603', 5, 10, 0, { value: '100n', lcsc: 'C14663' }],
    ['R3', 'R_0805', 20, 5, 0, { dnp: true }],
    ['U1', 'SOIC-8', 30, 20, 0, { value: 'LM358', lcsc: '' }],
  ]);
  const a = buildAssembly(prj, pcb);
  assert.equal(a.bom.length, 3);
  assert.deepEqual(a.bom.find((r) => r.lcsc === 'C17414').designators, ['R1', 'R2', 'R10'], '自然順');
  assert.ok(!a.cpl.some((c) => c.designator === 'R3') && !a.bom.some((r) => r.designators.includes('R3')), 'DNP は除外');
  assert.ok(a.problems.some((p) => p.level === 'error' && /LCSC品番が無い/.test(p.message)));
  const csv = bomCsv(a);
  assert.ok(csv.startsWith('﻿Comment,Designator,Footprint,LCSC Part #\r\n'));
  assert.ok(csv.includes('10k,"R1,R2,R10",0805,C17414\r\n'));
  const c = cplCsv(a);
  assert.ok(c.startsWith('﻿Designator,Mid X,Mid Y,Layer,Rotation\r\n'));
  assert.ok(c.includes('R1,5,-5,Top,0\r\n'));
  assert.ok(c.includes('U1,30,-20,Top,270\r\n'));
});

test('BOM: 部品代の目安（価格のある部品のみ）', () => {
  const { prj, pcb } = board([['R1', 'R_0805', 5, 5], ['R2', 'R_0805', 10, 5]]);
  prj.library.parts.push({ id: 'p1', lcsc: 'C17414', price: [{ qty: 1, usd: 0.01 }, { qty: 100, usd: 0.002 }], jlc: { type: 'basic' } });
  prj.netlist = { components: [{ ref: 'R1', partId: 'p1' }, { ref: 'R2', partId: 'p1' }] };
  const a = buildAssembly(prj, pcb, { boards: 10 });
  assert.equal(a.bom[0].jlcType, 'basic');
  assert.equal(a.bom[0].unitUsd, 0.01, '2個×10枚=20個 → 1個以上の単価');
  assert.equal(a.summary.partsUsd, 0.2);
});
