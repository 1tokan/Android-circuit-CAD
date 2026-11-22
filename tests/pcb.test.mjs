// node --test tests/pcb.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../js/core/project.js';
import { addComponent, addWirePath, addLabel } from '../js/schematic/model.js';
import { BUILTIN_PARTS, partFootprint } from '../js/library/parts.js';
import { generateNetlist } from '../js/netlist/netlist.js';
import {
  ensurePcb, importNetlist, fpToBoard, boardToFp, allPads, routePath, addTrackPath, addVia, addBoardZone,
  hitTest, moveSelection, rotateSelection, flipSelection, deleteSelection, toNm, toMm, setOutlineRect, boardSizeText, pointInPad,
} from '../js/pcb/model.js';
import { computePcbConnectivity, snapTarget } from '../js/pcb/connectivity.js';

function projectA() {
  const prj = createProject('A');
  const sh = prj.schematic.sheets[0];
  const parts = {
    r: BUILTIN_PARTS.find((p) => p.name.startsWith('抵抗 330Ω')),
    led: BUILTIN_PARTS.find((p) => p.name === 'LED 赤 0805'),
    j: BUILTIN_PARTS.find((p) => p.name.startsWith('JST PH 2ピン')),
  };
  prj.library.parts.push(...Object.values(parts));
  const place = (part, x, y) => addComponent(sh, part.kind, x, y, { partId: part.id, value: part.value, footprint: part.footprint, pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames });
  place(parts.j, -10, 0); place(parts.r, 4, -10); place(parts.led, 14, -10);
  const g = addComponent(sh, 'gnd', -20, 10); g.props.net = 'GND';
  addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
  addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
  addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
  addLabel(sh, 20, 6, 'GND');
  addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  return prj;
}
const resolver = (prj) => (c) => partFootprint(prj.library.parts.find((p) => p.id === c.partId));

function boardA() {
  const prj = projectA();
  const nl = generateNetlist(prj);
  const pcb = ensurePcb(prj);
  const rep = importNetlist(pcb, nl, resolver(prj));
  return { prj, nl, pcb, rep };
}
const inst = (pcb, ref) => pcb.footprints.find((f) => f.ref === ref);
const padOf = (pcb, ref, num) => allPads(pcb).find((p) => p.ref === ref && p.pad.num === num);

test('座標変換: 回転・裏面反転と逆変換', () => {
  const f = { x: toNm(10), y: toNm(5), rot: 90, side: 'top' };
  const p = fpToBoard(f, 1, 0);
  assert.ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 6) < 1e-9, '90°回転で +x → +y');
  const back = boardToFp(f, p.x, p.y);
  assert.ok(Math.abs(back.x - 1) < 1e-9 && Math.abs(back.y) < 1e-9);
  const b = { x: 0, y: 0, rot: 0, side: 'bottom' };
  assert.ok(Math.abs(fpToBoard(b, 1, 0).x + 1) < 1e-9, '裏面は左右反転');
  assert.ok(Math.abs(boardToFp(b, -1, 0).x - 1) < 1e-9);
});

test('ネットリスト取込: 部品・パッドのネット・フットプリントの保存', () => {
  const { pcb, rep } = boardA();
  assert.deepEqual(rep.added.sort(), ['D1', 'J1', 'R1']);
  assert.equal(pcb.footprints.length, 3);
  assert.equal(inst(pcb, 'D1').fpDef.id, 'LED_0805');
  assert.equal(inst(pcb, 'D1').padNets['1'], 'GND');
  assert.equal(inst(pcb, 'J1').padNets['2'], 'GND');
  assert.equal(inst(pcb, 'R1').padNets['2'], inst(pcb, 'D1').padNets['2']);
  for (const f of pcb.footprints) assert.ok(toMm(f.y) > 40, '新しい部品は基板の下に並ぶ');
});

test('再取込: 位置を保ち、部品番号が変わっても回路図の部品IDで対応づける', () => {
  const { prj, pcb } = boardA();
  inst(pcb, 'R1').x = toNm(20); inst(pcb, 'R1').y = toNm(10); inst(pcb, 'R1').rot = 90;
  prj.schematic.sheets[0].components.find((c) => c.ref === 'R1').ref = 'R5';
  const rep = importNetlist(pcb, generateNetlist(prj), resolver(prj));
  assert.equal(rep.added.length, 0);
  const r = inst(pcb, 'R5');
  assert.ok(r, 'R5 として更新');
  assert.equal(toMm(r.x), 20); assert.equal(r.rot, 90);
  // 回路図から消すと PCB からも消える
  const sh = prj.schematic.sheets[0];
  sh.components = sh.components.filter((c) => c.ref !== 'D1');
  const rep2 = importNetlist(pcb, generateNetlist(prj), resolver(prj));
  assert.deepEqual(rep2.removed, ['D1']);
  assert.equal(pcb.footprints.length, 2);
});

test('ラッツネスト: 配線するとその接続が消え、全部つなぐと0', () => {
  const { pcb } = boardA();
  // 部品を基板内に配置
  Object.assign(inst(pcb, 'J1'), { x: toNm(10), y: toNm(20) });
  Object.assign(inst(pcb, 'R1'), { x: toNm(25), y: toNm(10) });
  Object.assign(inst(pcb, 'D1'), { x: toNm(40), y: toNm(10) });
  let c = computePcbConnectivity(pcb);
  assert.equal(c.unrouted, 3, '3ネット×(2パッド-1)');
  const w = pcb.settings.trackWidth;
  const r2 = padOf(pcb, 'R1', '2'), d2 = padOf(pcb, 'D1', '2');
  addTrackPath(pcb, routePath(r2, d2, '45'), 'F.Cu', w, r2.net);
  c = computePcbConnectivity(pcb);
  assert.equal(c.unrouted, 2);
  assert.ok(!c.ratsnest.some((r) => r.net === r2.net), '配線済みネットはラッツネストから除外');
  // J1(THT) ピン1 → R1 ピン1 を 裏面で途中ビア経由
  const j1 = padOf(pcb, 'J1', '1'), r1 = padOf(pcb, 'R1', '1');
  addTrackPath(pcb, [j1, { x: j1.x, y: 14 }], 'B.Cu', w, j1.net);
  addVia(pcb, j1.x, 14, j1.net);
  addTrackPath(pcb, routePath({ x: j1.x, y: 14 }, r1, '45'), 'F.Cu', w, j1.net);
  c = computePcbConnectivity(pcb);
  assert.equal(c.unrouted, 1, 'ビアで層をまたいで接続');
  // GND はベタ（表）でつなぐ（推定）
  addBoardZone(pcb, 'F.Cu', 'GND');
  c = computePcbConnectivity(pcb);
  assert.equal(c.unrouted, 0);
  assert.deepEqual(c.shorts, []);
});

test('別ネットのパッドを配線でつなぐと短絡として検出', () => {
  const { pcb } = boardA();
  const a = padOf(pcb, 'R1', '1'), b = padOf(pcb, 'R1', '2');
  addTrackPath(pcb, [a, b], 'F.Cu', pcb.settings.trackWidth, a.net);
  const c = computePcbConnectivity(pcb);
  assert.equal(c.shorts.length, 1);
});

test('層が違えばつながらない（表のSMDパッドに裏の配線）', () => {
  const { pcb } = boardA();
  const a = padOf(pcb, 'R1', '2'), b = padOf(pcb, 'D1', '2');
  addTrackPath(pcb, [a, b], 'B.Cu', pcb.settings.trackWidth, a.net);
  assert.equal(computePcbConnectivity(pcb).unrouted, 3);
});

test('45°経路と90°経路', () => {
  const p = routePath({ x: 0, y: 0 }, { x: 10, y: 4 }, '45');
  assert.deepEqual(p, [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 10, y: 4 }]);
  const q = routePath({ x: 0, y: 0 }, { x: 10, y: 4 }, '45', true);
  assert.deepEqual(q, [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 10, y: 4 }]);
  for (const path of [p, q]) for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x), dy = Math.abs(path[i].y - path[i - 1].y);
    assert.ok(dx === 0 || dy === 0 || Math.abs(dx - dy) < 1e-9, '水平・垂直・45°のみ');
  }
  assert.deepEqual(routePath({ x: 0, y: 0 }, { x: 3, y: 3 }, '45'), [{ x: 0, y: 0 }, { x: 3, y: 3 }]);
  assert.deepEqual(routePath({ x: 0, y: 0 }, { x: 3, y: 5 }, '90'), [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }]);
});

test('吸着・ヒットテスト・変形・削除・外形', () => {
  const { pcb } = boardA();
  const r1 = inst(pcb, 'R1');
  const p = padOf(pcb, 'R1', '1');
  const s = snapTarget(pcb, { x: p.x + 0.2, y: p.y }, 0.5, 'F.Cu');
  assert.equal(s.kind, 'pad'); assert.equal(s.net, p.net);
  assert.equal(hitTest(pcb, { x: toMm(r1.x), y: toMm(r1.y) }, 0.2), `f:${r1.id}`);
  const x0 = r1.x, y0 = r1.y;
  moveSelection(pcb, new Set([`f:${r1.id}`]), 1.5, -2);
  assert.equal(r1.x - x0, toNm(1.5)); assert.equal(r1.y - y0, toNm(-2));
  rotateSelection(pcb, new Set([`f:${r1.id}`]));
  assert.equal(r1.rot, 90);
  flipSelection(pcb, new Set([`f:${r1.id}`]));
  assert.equal(r1.side, 'bottom');
  assert.ok(allPads(pcb).filter((x) => x.ref === 'R1').every((x) => x.layers[0] === 'B.Cu'), '裏面のSMDパッドは裏銅');
  r1.locked = true;
  assert.equal(moveSelection(pcb, new Set([`f:${r1.id}`]), 1, 0), false, 'ロック中は動かない');
  deleteSelection(pcb, new Set([`f:${r1.id}`]));
  assert.ok(inst(pcb, 'R1'), 'ロック中は削除しない');
  setOutlineRect(pcb, 80.5, 60);
  assert.equal(boardSizeText(pcb), '80.5 × 60.0 mm');
});

test('パッド形状の内外判定（円・長円・角）', () => {
  const f = { x: 0, y: 0, rot: 0, side: 'top' };
  assert.ok(pointInPad(f, { x: 0, y: 0, w: 1, h: 1, shape: 'circle' }, 0.49, 0));
  assert.ok(!pointInPad(f, { x: 0, y: 0, w: 1, h: 1, shape: 'circle' }, 0.4, 0.4));
  assert.ok(pointInPad(f, { x: 0, y: 0, w: 1, h: 1, shape: 'rect' }, 0.49, 0.49));
  assert.ok(pointInPad(f, { x: 0, y: 0, w: 1.2, h: 2, shape: 'oval' }, 0, 0.95));
  assert.ok(!pointInPad(f, { x: 0, y: 0, w: 1.2, h: 2, shape: 'oval' }, 0.55, 0.95));
});
