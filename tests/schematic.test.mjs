// node --test tests/schematic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { xform, onSegment, onSegmentInterior } from '../js/schematic/geom.js';
import { getSymbol, KINDS } from '../js/schematic/symbols.js';
import {
  addComponent, addWirePath, addLabel, routeL, moveSelection, rotateSelection, mirrorSelection,
  deleteSelection, annotate, nextRef, hitTest, itemsInRect, isConnectable,
} from '../js/schematic/model.js';
import { computeConnectivity, pinPositions } from '../js/schematic/connectivity.js';
import { History } from '../js/core/history.js';

const emptySheet = () => ({ id: 's', name: 'S', components: [], wires: [], junctions: [], labels: [] });
const pinAt = (sh, ref, num) => pinPositions(sh).find((p) => p.ref === ref && p.pin === num);
const netOf = (conn, ref, pin) => conn.nets.find((n) => n.pins.some((p) => p.ref === ref && p.pin === pin));

test('全種別のシンボル: ピン先端が整数座標でピン番号が重複しない', () => {
  for (const k of KINDS) {
    for (const props of [k.props, { ...k.props, pinCount: 14 }, { ...k.props, pinCount: 3 }]) {
      const sym = getSymbol({ kind: k.kind, props });
      assert.ok(sym.pins.length > 0, k.kind);
      const nums = sym.pins.map((p) => p.num);
      assert.equal(new Set(nums).size, nums.length, `${k.kind} pin numbers unique`);
      for (const p of sym.pins) assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), `${k.kind} pin ${p.num}`);
      for (const p of sym.pins) assert.ok(p.type, `${k.kind} pin type`);
    }
  }
});

test('xform: 回転・反転はSVG transformと一致し、回転後もピンは整数', () => {
  const c = { x: 10, y: 5, rot: 90, mirror: false };
  assert.deepEqual(xform({ x: 4, y: 0 }, c), { x: 10, y: 9 });
  assert.deepEqual(xform({ x: 4, y: 0 }, { ...c, rot: 180 }), { x: 6, y: 5 });
  assert.deepEqual(xform({ x: 4, y: 0 }, { ...c, rot: 0, mirror: true }), { x: 6, y: 5 });
  assert.deepEqual(xform({ x: 2, y: -4 }, { x: 0, y: 0, rot: 270, mirror: false }), { x: -4, y: -2 });
});

test('線分判定: 端点・途中・外れ', () => {
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
  assert.ok(onSegment({ x: 0, y: 0 }, a, b));
  assert.ok(onSegment({ x: 5, y: 0 }, a, b));
  assert.ok(!onSegment({ x: 11, y: 0 }, a, b));
  assert.ok(!onSegmentInterior({ x: 10, y: 0 }, a, b));
  assert.ok(onSegmentInterior({ x: 3, y: 0 }, a, b));
});

test('自動採番: 種別ごとに連番、欠番の後ろから', () => {
  const sh = emptySheet();
  assert.equal(addComponent(sh, 'resistor', 0, 0).ref, 'R1');
  assert.equal(addComponent(sh, 'resistor', 10, 0).ref, 'R2');
  assert.equal(addComponent(sh, 'capacitor', 0, 10).ref, 'C1');
  assert.equal(addComponent(sh, 'electrolytic', 0, 20).ref, 'C2');
  assert.equal(addComponent(sh, 'led', 0, 30).ref, 'D1');
  assert.equal(addComponent(sh, 'gnd', 0, 40).ref, '#PWR1');
  sh.components[0].ref = 'R7';
  assert.equal(nextRef(sh, 'R'), 'R8');
});

test('振り直し: 上→下、左→右の順', () => {
  const sh = emptySheet();
  addComponent(sh, 'resistor', 20, 0);
  addComponent(sh, 'resistor', 0, 10);
  addComponent(sh, 'resistor', 0, 0);
  annotate(sh);
  const byPos = sh.components.map((c) => `${c.ref}@${c.x},${c.y}`).sort();
  assert.deepEqual(byPos, ['R1@0,0', 'R2@20,0', 'R3@0,10']);
});

test('テストA相当: 電池-抵抗-LED-GND の接続とネット名', () => {
  const sh = emptySheet();
  const bt = addComponent(sh, 'battery', 0, 0);     // + (0,-4), - (0,4)
  const r = addComponent(sh, 'resistor', 10, -8);  // 1 (6,-8), 2 (14,-8)
  const d = addComponent(sh, 'led', 20, -8);       // A=2 (17,-8), K=1 (23,-8)
  const g = addComponent(sh, 'gnd', 0, 12);
  g.props.net = 'GND';
  addWirePath(sh, routeL({ x: 0, y: -4 }, { x: 6, y: -8 }, false));
  addWirePath(sh, [{ x: 14, y: -8 }, { x: 17, y: -8 }]);
  addWirePath(sh, [{ x: 23, y: -8 }, { x: 26, y: -8 }, { x: 26, y: 8 }, { x: 0, y: 8 }]);
  addWirePath(sh, [{ x: 0, y: 4 }, { x: 0, y: 12 }]);
  const conn = computeConnectivity(sh);
  assert.equal(netOf(conn, bt.ref, '1'), netOf(conn, r.ref, '1'));
  assert.equal(netOf(conn, r.ref, '2'), netOf(conn, d.ref, '2'));
  const gnd = netOf(conn, bt.ref, '2');
  assert.equal(gnd.name, 'GND');
  assert.ok(gnd.pins.some((p) => p.ref === d.ref && p.pin === '1'));
  assert.equal(conn.unconnectedPins.length, 0);
  assert.equal(conn.nets.length, 3);
  // GND配線 (0,8) は (0,4)-(0,12) の途中に乗る T 分岐 → ジャンクションあり
  assert.ok(conn.junctions.some((j) => j.x === 0 && j.y === 8));
});

test('交差しているだけの配線は接続しない／T分岐は接続する', () => {
  const sh = emptySheet();
  const r1 = addComponent(sh, 'resistor', 0, 0);  // pins (-4,0),(4,0)
  const r2 = addComponent(sh, 'resistor', 0, 20); // pins (-4,20),(4,20)
  // 横線 r1.2 → 右へ、縦線 r2.2 → 上へ。途中で十字に交差
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 20, y: 0 }]);
  addWirePath(sh, [{ x: 4, y: 20 }, { x: 10, y: 20 }, { x: 10, y: -10 }]);
  let conn = computeConnectivity(sh);
  assert.notEqual(netOf(conn, r1.ref, '2'), netOf(conn, r2.ref, '2'), '交差は非接続');
  assert.equal(conn.junctions.length, 0, '交差点にドットなし');
  // 縦線の端点を横線の途中に止める → T分岐で接続
  sh.wires[sh.wires.length - 1].b = { x: 10, y: 0 };
  conn = computeConnectivity(sh);
  assert.equal(netOf(conn, r1.ref, '2'), netOf(conn, r2.ref, '2'), 'T分岐は接続');
  assert.ok(conn.junctions.some((j) => j.x === 10 && j.y === 0));
});

test('T分岐は分岐点で配線が分割され、部品を動かしても分岐が外れない', () => {
  const sh = emptySheet();
  const r1 = addComponent(sh, 'resistor', 0, 0);   // r1.2 = (4,0)
  const r2 = addComponent(sh, 'resistor', 20, 0);  // r2.1 = (16,0)
  const r3 = addComponent(sh, 'resistor', 10, 12, {}); // r3.1 = (6,12)
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 16, y: 0 }]);
  addWirePath(sh, [{ x: 10, y: 0 }, { x: 10, y: 12 }, { x: 6, y: 12 }]);
  assert.equal(sh.wires.length, 4, '横線が (10,0) で2本に分割');
  moveSelection(sh, new Set([`c:${r1.id}`]), 0, -6);
  const conn = computeConnectivity(sh);
  const n = netOf(conn, r2.ref, '1');
  assert.ok(n.pins.some((p) => p.ref === r1.ref && p.pin === '2'), 'R1 も同じネット');
  assert.ok(n.pins.some((p) => p.ref === r3.ref && p.pin === '1'), 'R3 も同じネット');
  assert.ok(conn.junctions.some((j) => j.x === 10 && j.y === 0));
});

test('同名ラベルは離れていても同一ネット、名前の衝突を検出', () => {
  const sh = emptySheet();
  const r1 = addComponent(sh, 'resistor', 0, 0);
  const r2 = addComponent(sh, 'resistor', 40, 40);
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 8, y: 0 }]);
  addLabel(sh, 8, 0, 'SDA');
  addLabel(sh, 44, 40, 'SDA'); // r2 のピン2に直接
  let conn = computeConnectivity(sh);
  const n = netOf(conn, r1.ref, '2');
  assert.equal(n.name, 'SDA');
  assert.ok(n.pins.some((p) => p.ref === r2.ref && p.pin === '2'));
  addLabel(sh, 6, 0, 'SCL'); // 同じ配線に別名
  conn = computeConnectivity(sh);
  assert.deepEqual(netOf(conn, r1.ref, '2').conflictingNames, ['SCL', 'SDA']);
});

test('ピン同士が直接重なれば接続、未接続ピンを報告', () => {
  const sh = emptySheet();
  const r1 = addComponent(sh, 'resistor', 0, 0);
  const r2 = addComponent(sh, 'resistor', 8, 0); // r1.2 (4,0) と r2.1 (4,0) が一致
  const conn = computeConnectivity(sh);
  assert.equal(netOf(conn, r1.ref, '2'), netOf(conn, r2.ref, '1'));
  assert.deepEqual(conn.unconnectedPins.map((p) => `${p.ref}.${p.pin}`).sort(), ['R1.1', 'R2.2']);
});

test('移動: 選択外の配線端点がピンに追従し、直角の折れ線を保つ', () => {
  const sh = emptySheet();
  const r = addComponent(sh, 'resistor', 0, 0);
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 10, y: 0 }]);
  moveSelection(sh, new Set([`c:${r.id}`]), 0, 3);
  assert.equal(sh.wires.length, 2, '折れ線（2本）になる');
  for (const w of sh.wires) assert.ok(w.a.x === w.b.x || w.a.y === w.b.y, '全て水平か垂直');
  const conn = computeConnectivity(sh);
  assert.ok(!conn.unconnectedPins.some((p) => p.pin === '2'), 'ピン2は接続を保つ');
  assert.ok(sh.wires.some((w) => (w.a.x === 4 && w.a.y === 3) || (w.b.x === 4 && w.b.y === 3)));
  // 同じ向きに動くだけなら1本のまま
  const sh2 = emptySheet();
  const r2 = addComponent(sh2, 'resistor', 0, 0);
  addWirePath(sh2, [{ x: 4, y: 0 }, { x: 10, y: 0 }]);
  moveSelection(sh2, new Set([`c:${r2.id}`]), -2, 0);
  assert.equal(sh2.wires.length, 1);
  assert.deepEqual(sh2.wires[0].a, { x: 2, y: 0 });
});

test('回転・ミラー: ピン位置の変化と接続の維持', () => {
  const sh = emptySheet();
  const r = addComponent(sh, 'resistor', 0, 0);
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 10, y: 0 }]);
  rotateSelection(sh, new Set([`c:${r.id}`]));
  assert.equal(r.rot, 90);
  assert.deepEqual({ x: pinAt(sh, 'R1', '2').x, y: pinAt(sh, 'R1', '2').y }, { x: 0, y: 4 });
  assert.ok(computeConnectivity(sh).nets.some((n) => n.pins.some((p) => p.pin === '2') && n.wires.length >= 1), '配線端が追従');
  // ミラー（4回で元に戻る性質の確認: ミラー2回で恒等）
  const before = JSON.stringify(sh);
  mirrorSelection(sh, new Set([`c:${r.id}`]));
  mirrorSelection(sh, new Set([`c:${r.id}`]));
  assert.equal(JSON.stringify(sh), before);
  // 回転したトランジスタのミラーは「シート上で左右反転」になる
  const q = addComponent(sh, 'npn', 30, 0);
  q.rot = 90;
  const b0 = pinAt(sh, q.ref, '1');
  mirrorSelection(sh, new Set([`c:${q.id}`]));
  const b1 = pinAt(sh, q.ref, '1');
  assert.equal(b1.y, b0.y, '上下は変わらない');
  assert.equal(b1.x - 30, 0 - (b0.x - 30) + 0, '左右が反転');
});

test('削除・ヒットテスト・範囲選択', () => {
  const sh = emptySheet();
  const r = addComponent(sh, 'resistor', 0, 0);
  const [w] = addWirePath(sh, [{ x: 4, y: 0 }, { x: 4, y: 10 }]);
  assert.equal(hitTest(sh, { x: 0.3, y: 0.2 }, 0.5), `c:${r.id}`);
  assert.equal(hitTest(sh, { x: 4.2, y: 6 }, 0.5), `w:${w.id}`);
  assert.equal(hitTest(sh, { x: 20, y: 20 }, 0.5), null);
  const inBox = itemsInRect(sh, { x: -5, y: -2 }, { x: 5, y: 2 });
  assert.deepEqual([...inBox], [`c:${r.id}`], '一部だけ入る配線は含めない');
  deleteSelection(sh, new Set([`c:${r.id}`]));
  assert.equal(sh.components.length, 0);
  assert.equal(sh.wires.length, 1);
});

test('配線: 長さ0と重複を作らない、終点判定', () => {
  const sh = emptySheet();
  addComponent(sh, 'resistor', 0, 0);
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 4, y: 0 }]);
  assert.equal(sh.wires.length, 0);
  addWirePath(sh, [{ x: 4, y: 0 }, { x: 8, y: 0 }]);
  addWirePath(sh, [{ x: 8, y: 0 }, { x: 4, y: 0 }]);
  assert.equal(sh.wires.length, 1);
  assert.ok(isConnectable(sh, { x: -4, y: 0 }), 'ピン');
  assert.ok(isConnectable(sh, { x: 6, y: 0 }), '配線の途中');
  assert.ok(!isConnectable(sh, { x: 6, y: 1 }));
  assert.deepEqual(routeL({ x: 0, y: 0 }, { x: 3, y: 5 }, true), [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }]);
  assert.deepEqual(routeL({ x: 0, y: 0 }, { x: 3, y: 5 }, false), [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 3, y: 5 }]);
});

test('History: 元に戻す・やり直す、変化なしは積まない', () => {
  let doc = { sheet: emptySheet() };
  const h = new History(() => doc.sheet, (s) => { doc.sheet = s; });
  h.record(() => addComponent(doc.sheet, 'resistor', 0, 0), '配置');
  h.record(() => addComponent(doc.sheet, 'led', 10, 0), '配置');
  assert.equal(h.record(() => {}, 'noop'), false);
  assert.equal(doc.sheet.components.length, 2);
  h.undo();
  assert.equal(doc.sheet.components.length, 1);
  h.undo();
  assert.equal(doc.sheet.components.length, 0);
  assert.equal(h.undo(), null);
  h.redo();
  assert.equal(doc.sheet.components[0].ref, 'R1');
  h.record(() => addComponent(doc.sheet, 'capacitor', 0, 10), '配置');
  assert.equal(h.canRedo(), false, '新しい編集でやり直し履歴は消える');
});

test('部品を動かす・回すと、ピンにじかに付いたネットラベルと電源記号も一緒に動く（接続が外れない）', () => {
  const sh = emptySheet();
  const r = addComponent(sh, 'resistor', 100, 100);
  const pins = pinPositions(sh).filter((p) => p.compId === r.id);
  const p1 = pins.find((p) => p.pin === '1'), p2 = pins.find((p) => p.pin === '2');
  addLabel(sh, p1.x, p1.y, 'SIG');
  const g = addComponent(sh, 'gnd', p2.x, p2.y);
  // 別の部品のピンと共有しているラベルは動かさない
  const c = addComponent(sh, 'capacitor', 300, 100);
  const cp = pinPositions(sh).find((p) => p.compId === c.id && p.pin === '1');
  addLabel(sh, cp.x, cp.y, 'SIG');
  const before = computeConnectivity(sh).nets.map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(',')).sort();
  moveSelection(sh, new Set([`c:${r.id}`]), 40, 60);
  rotateSelection(sh, new Set([`c:${r.id}`]));
  const after = computeConnectivity(sh).nets.map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(',')).sort();
  assert.deepEqual(after, before);
  assert.notDeepEqual([g.x, g.y], [p2.x, p2.y], 'GND 記号も動いた');
  assert.equal(sh.labels.filter((l) => l.x === cp.x && l.y === cp.y).length, 1, 'C の SIG ラベルは元の位置のまま');
});
