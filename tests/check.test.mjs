// node --test tests/check.test.mjs  … ERC / DRC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../js/core/project.js';
import { addComponent, addWirePath, addLabel } from '../js/schematic/model.js';
import { BUILTIN_PARTS, partFootprint } from '../js/library/parts.js';
import { listFootprints } from '../js/library/footprints.js';
import { generateFootprint } from '../js/library/pkggen.js';
import { generateNetlist } from '../js/netlist/netlist.js';
import { ensurePcb, importNetlist, allPads, addTrackPath, addVia, addHole, addText, toNm, toMm, setOutlineRect } from '../js/pcb/model.js';
import { runErc, ercStatus, ERC_RULES } from '../js/check/erc.js';
import { runDrc, drcStatus, DRC_RULES } from '../js/check/drc.js';
import { shapeDist, segSegDist } from '../js/core/geom2d.js';
import { padShape, silkSegments } from '../js/pcb/shapes.js';
import { pinPositions } from '../js/schematic/connectivity.js';

const part = (pred) => BUILTIN_PARTS.find(pred);
function placer(prj) {
  const sh = prj.schematic.sheets[0];
  return (p, x, y) => {
    if (!prj.library.parts.includes(p)) prj.library.parts.push(p);
    return addComponent(sh, p.kind, x, y, { partId: p.id, value: p.value, footprint: p.footprint, ...(p.symbol.pinCount ? { pinCount: p.symbol.pinCount, pinNames: p.symbol.pinNames } : {}) });
  };
}

/** テスト用回路A: J1(+,-) → R1 → D1 → GND */
function projectA() {
  const prj = createProject('A');
  const sh = prj.schematic.sheets[0];
  const place = placer(prj);
  place(part((p) => p.name.startsWith('JST PH 2ピン')), -10, 0);
  place(part((p) => p.name.startsWith('抵抗 330Ω')), 4, -10);
  place(part((p) => p.name === 'LED 赤 0805'), 14, -10);
  const g = addComponent(sh, 'gnd', -20, 10); g.props.net = 'GND';
  addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
  addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
  addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
  addLabel(sh, 20, 6, 'GND');
  addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  return prj;
}

const rulesOf = (r, level) => r.issues.filter((i) => !level || i.level === level).map((i) => i.rule);

// ---------------- ERC ----------------
test('ERC: 正しい回路Aはエラー・警告なし、検査項目と未検査項目を必ず返す', () => {
  const prj = projectA();
  const r = runErc(prj);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.issues));
  assert.equal(r.summary.warnings, 0, JSON.stringify(r.issues));
  assert.equal(r.checked.length, ERC_RULES.length);
  assert.ok(r.unchecked.length >= 3, '未検査の項目を明示する');
  prj.checks.erc = r;
  assert.equal(ercStatus(prj), 'current');
  prj.schematic.sheets[0].components[0].x += 1;
  assert.equal(ercStatus(prj), 'stale', '回路図が変わったら結果は古い扱い');
});

test('ERC: 未接続ピン・浮いた配線端・浮きラベル・電源記号', () => {
  const prj = projectA();
  const sh = prj.schematic.sheets[0];
  sh.wires = sh.wires.filter((w) => !(w.a.x === 8 || w.b.x === 8)); // R1-D1 間を切る
  addLabel(sh, 50, 50, 'FLOAT');
  addComponent(sh, 'power', 60, 60).props.net = '+5V';
  addWirePath(sh, [{ x: 30, y: 30 }, { x: 34, y: 30 }]);
  const r = runErc(prj);
  const rules = rulesOf(r);
  assert.ok(rules.filter((x) => x === 'pin_unconnected').length >= 2, 'R1.2 と D1.2 が未接続');
  assert.ok(rules.includes('dangling_label'));
  assert.ok(rules.includes('power_symbol_unconnected'));
  assert.equal(rules.filter((x) => x === 'wire_dangling').length, 2, '孤立した配線の両端');
  const unc = r.issues.find((i) => i.rule === 'pin_unconnected');
  assert.ok(unc.at && Number.isFinite(unc.at.x), '位置を持つ');
});

test('ERC: 電源の短絡・部品番号の重複と未採番', () => {
  const prj = projectA();
  const sh = prj.schematic.sheets[0];
  // GND ネットに +5V 電源記号を接続
  const p5 = addComponent(sh, 'power', -20, 10); p5.props.net = '+5V';
  sh.components.find((c) => c.ref === 'D1').ref = 'R1';
  sh.components.find((c) => c.ref === 'J1').ref = 'J?';
  const r = runErc(prj);
  const errs = rulesOf(r, 'error');
  assert.ok(errs.includes('power_short'), JSON.stringify(r.issues));
  assert.ok(errs.includes('ref_duplicate'));
  assert.ok(errs.includes('ref_format'));
});

test('ERC: オペアンプの電源ピン未接続・入力開放・出力の衝突', () => {
  const prj = createProject('B');
  const sh = prj.schematic.sheets[0];
  const place = placer(prj);
  const op = part((p) => p.kind === 'opamp');
  place(op, 0, 0); // U1: 何もつながない
  let r = runErc(prj);
  const unc = r.issues.filter((i) => i.rule === 'pin_unconnected');
  assert.equal(unc.length, 5);
  assert.ok(unc.filter((i) => i.level === 'error').length >= 4, '入力・電源ピンの開放はエラー');

  // 2つのオペアンプの出力どうしをつなぐ
  const u2 = place(op, 0, 20);
  addWirePath(sh, [{ x: 6, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 6, y: 20 }]);
  // U1 の V+ を電源記号なしで U2 の V+ とつなぐ → 電源入力に供給なし
  addWirePath(sh, [{ x: 0, y: -4 }, { x: -10, y: -4 }, { x: -10, y: 16 }, { x: 0, y: 16 }]);
  r = runErc(prj);
  const errs = rulesOf(r, 'error');
  assert.ok(errs.includes('output_conflict'), JSON.stringify(r.issues.map((i) => i.message)));
  assert.ok(errs.includes('power_in_undriven'));
  // 電源記号を付ければ電源入力の誤りは消える
  addComponent(sh, 'power', -10, -4).props.net = '+5V';
  r = runErc(prj);
  assert.ok(!rulesOf(r).includes('power_in_undriven'), JSON.stringify(r.issues.filter((i) => i.rule === 'power_in_undriven')));
  assert.ok(u2.ref === 'U2');
});

test('ERC: 入力どうしだけのネットは警告、未使用ピン指定のピンは未接続でもよい', () => {
  const prj = createProject('C');
  const sh = prj.schematic.sheets[0];
  const place = placer(prj);
  const op = part((p) => p.kind === 'opamp');
  place(op, 0, 0); place(op, 0, 20);
  // U1 の IN+ と U2 の IN+ をつなぐ
  addWirePath(sh, [{ x: -6, y: -2 }, { x: -12, y: -2 }, { x: -12, y: 18 }, { x: -6, y: 18 }]);
  const r = runErc(prj);
  assert.ok(rulesOf(r, 'warning').includes('input_undriven'));
  // AMS1117 の 4 番ピン（pinMap で空 = 未使用）
  const prj2 = createProject('E');
  placer(prj2)(part((p) => p.mpn === 'AMS1117-3.3'), 0, 0);
  const r2 = runErc(prj2);
  const pins = r2.issues.filter((i) => i.rule === 'pin_unconnected').map((i) => i.message);
  assert.equal(pins.length, 3, pins.join('\n'));
  assert.ok(!pins.some((m) => m.includes('.4')), '未使用指定のピン4は報告しない');
});

test('ERC: 電源ピン名とネットの食い違い', () => {
  const prj = createProject('E');
  const sh = prj.schematic.sheets[0];
  const ldo = placer(prj)(part((p) => p.mpn === 'AMS1117-3.3'), 0, 0);
  const pins = (ldo.props.pinNames || '').split(',');
  assert.equal(pins[2], 'VIN');
  // IC の各ピン先端に電源記号を直接置く（VIN を GND に、GND を +5V に）
  const pp = pinPositions(sh).filter((q) => q.compId === ldo.id);
  const at = (num) => pp.find((p) => p.pin === num);
  const g = addComponent(sh, 'gnd', at('3').x, at('3').y); g.props.net = 'GND';
  const v = addComponent(sh, 'power', at('1').x, at('1').y); v.props.net = '+5V';
  const r = runErc(prj);
  const w = r.issues.filter((i) => i.rule === 'power_name_mismatch');
  assert.equal(w.length, 2, JSON.stringify(r.issues.map((i) => i.message)));
});


// ---------------- 形状計算 ----------------
test('形状: 線分間距離・カプセル・四角形', () => {
  assert.equal(segSegDist({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 3 }, { x: 10, y: 3 }), 3);
  assert.equal(segSegDist({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), 0, '交差');
  const cap = (x1, y1, x2, y2, r) => ({ type: 'cap', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, r });
  assert.ok(Math.abs(shapeDist(cap(0, 0, 10, 0, 0.5), cap(0, 2, 10, 2, 0.5)) - 1) < 1e-12);
  const sq = { type: 'poly', pts: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }] };
  assert.ok(Math.abs(shapeDist(sq, cap(3, -5, 3, 5, 0.5)) - 1.5) < 1e-12);
  assert.ok(Math.abs(shapeDist(sq, cap(0, 0, 0, 0, 0.1)) + 0.1) < 1e-12, '内側は 0 から半径を引いた負の値（重なり）');
  const sq2 = { type: 'poly', pts: sq.pts.map((p) => ({ x: p.x + 2.5, y: p.y + 0.5 })) };
  assert.ok(Math.abs(shapeDist(sq, sq2) - 0.5) < 1e-12);
});

test('フットプリント: すべての内蔵・生成フットプリントで別番号のパッドが重ならない', () => {
  const fps = [...listFootprints()];
  for (const [k, pkg] of [['ic', 'QFN-32-EP(5x5)'], ['ic', 'LQFP-48(7x7)'], ['ic', 'TSSOP-16'], ['ic', 'SOP-16'], ['ic', 'SOIC-16-300mil'], ['ic', 'MSOP-10'], ['connector', 'Header 2x5'], ['connector', 'Header 1x6'], ['ic', 'SOT-23-6'], ['ic', 'DFN-8(3x3)'], ['ic', 'ESOP-8']]) {
    const f = generateFootprint(k, pkg);
    if (f) fps.push(f);
  }
  assert.ok(fps.length > 40);
  const fake = { x: 0, y: 0, rot: 0, side: 'top' };
  for (const fp of fps) {
    for (let i = 0; i < fp.pads.length; i++) for (let j = i + 1; j < fp.pads.length; j++) {
      const a = fp.pads[i], b = fp.pads[j];
      if (a.num === b.num) continue;
      const gap = shapeDist(padShape(fake, a), padShape(fake, b));
      assert.ok(gap >= 0.1, `${fp.id}: パッド${a.num}と${b.num}の間隔 ${gap.toFixed(3)}mm`);
    }
    // シルク線は自分のパッドに 0.15mm 以上近づかない
    for (const s of silkSegments(fp)) for (const p of fp.pads) {
      const d = shapeDist(padShape(fake, p), { type: 'cap', a: s.a, b: s.b, r: 0 });
      assert.ok(d >= 0.149, `${fp.id}: シルクとパッド${p.num}の間隔 ${d.toFixed(3)}`);
    }
  }
});

// ---------------- DRC ----------------
function boardA() {
  const prj = projectA();
  prj.netlist = generateNetlist(prj);
  const pcb = ensurePcb(prj);
  importNetlist(pcb, prj.netlist, (c) => partFootprint(prj.library.parts.find((p) => p.id === c.partId)));
  setOutlineRect(pcb, 30, 20);
  const at = (ref, x, y, rot = 0) => { const f = pcb.footprints.find((q) => q.ref === ref); f.x = toNm(x); f.y = toNm(y); f.rot = rot; };
  at('J1', 6, 10, 90); at('R1', 15, 6); at('D1', 23, 10);
  return { prj, pcb };
}
const pad = (pcb, ref, num) => allPads(pcb).find((p) => p.ref === ref && p.pad.num === num);
function routeA(pcb) {
  const w = toNm(0.3);
  const j1 = pad(pcb, 'J1', '1'), j2 = pad(pcb, 'J1', '2'), r1 = pad(pcb, 'R1', '1'), r2 = pad(pcb, 'R1', '2'), d1 = pad(pcb, 'D1', '1'), d2 = pad(pcb, 'D1', '2');
  addTrackPath(pcb, [j1, { x: j1.x, y: 6 }, r1], 'F.Cu', w, j1.net);
  addTrackPath(pcb, [r2, { x: d2.x, y: 6 }, d2], 'F.Cu', w, r2.net);
  addTrackPath(pcb, [j2, { x: j2.x, y: 15 }, { x: d1.x, y: 15 }, d1], 'F.Cu', w, j2.net);
  return { j1, j2, r1, r2, d1, d2 };
}

test('DRC: 配置・配線済みの回路Aは誤りなし（未照合フットプリントの注意だけ）', () => {
  const { prj, pcb } = boardA();
  routeA(pcb);
  const r = runDrc(prj, pcb);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.issues.map((i) => i.message), null, 1));
  assert.deepEqual([...new Set(rulesOf(r, 'warning'))], ['footprint_unverified'], JSON.stringify(r.issues.map((i) => i.message)));
  assert.equal(r.checked.length, DRC_RULES.length);
  assert.ok(r.unchecked.some((u) => u.includes('ベタ')), 'ベタの未検査を明示');
  prj.checks.drc = r;
  assert.equal(drcStatus(prj, pcb), 'current');
  pcb.footprints[0].x += toNm(1);
  assert.equal(drcStatus(prj, pcb), 'stale');
});

test('DRC: 未配置・未配線を検出', () => {
  const prj = projectA();
  prj.netlist = generateNetlist(prj);
  const pcb = ensurePcb(prj);
  importNetlist(pcb, prj.netlist, (c) => partFootprint(prj.library.parts.find((p) => p.id === c.partId)));
  const r = runDrc(prj, pcb);
  assert.equal(r.issues.filter((i) => i.rule === 'outside_board' && i.level === 'error').length, 3);
  assert.equal(r.issues.filter((i) => i.rule === 'unrouted').length, 3);
  assert.ok(!rulesOf(r).includes('silk_outside'), '未配置の部品のシルクは重ねて報告しない');
});

test('DRC: 細い配線・小さいビア・間隔不足・短絡・基板端', () => {
  const { prj, pcb } = boardA();
  const P = routeA(pcb);
  // 細い配線
  addTrackPath(pcb, [{ x: 2, y: 2 }, { x: 4, y: 2 }], 'F.Cu', toNm(0.1), P.j1.net);
  // 小さいビア（外径0.45/穴0.3）
  const v = addVia(pcb, 27, 3, P.j2.net); v.diameter = toNm(0.45);
  // R1 パッド2（D1-2 ネット）の 0.1mm 横を GND の配線
  const r2 = P.r2;
  const hw = r2.pad.w / 2;
  addTrackPath(pcb, [{ x: r2.x + hw + 0.1 + 0.15, y: r2.y - 3 }, { x: r2.x + hw + 0.1 + 0.15, y: r2.y + 3 }], 'B.Cu', toNm(0.3), P.j2.net);
  addTrackPath(pcb, [{ x: r2.x + hw + 0.1 + 0.15, y: r2.y - 3 }, { x: r2.x + hw + 0.1 + 0.15, y: r2.y + 3 }], 'F.Cu', toNm(0.3), P.j2.net);
  // 短絡: J1-1 ネットの配線を D1-1(GND) パッドに重ねる
  addTrackPath(pcb, [{ x: P.d1.x, y: P.d1.y }, { x: P.d1.x + 0.1, y: P.d1.y - 2 }], 'F.Cu', toNm(0.3), P.j1.net);
  // 基板端すれすれの配線
  addTrackPath(pcb, [{ x: 0.1, y: 18 }, { x: 5, y: 18 }], 'F.Cu', toNm(0.3), P.j2.net);
  const r = runDrc(prj, pcb);
  const errs = rulesOf(r, 'error');
  assert.ok(errs.includes('track_width'));
  assert.ok(errs.includes('via_size'));
  const clr = r.issues.filter((i) => i.rule === 'clearance');
  assert.equal(clr.length, 1, '同じ層の F.Cu だけが対象（B.Cu の配線は SMD パッドと干渉しない）' + JSON.stringify(clr));
  assert.ok(errs.includes('short'));
  assert.ok(errs.includes('edge_clearance'));
  assert.ok(rulesOf(r, 'warning').includes('dangling_track'));
  for (const i of r.issues.filter((x) => x.level === 'error')) if (i.rule !== 'netlist_sync') assert.ok(i.at, `${i.rule} は位置を持つ`);
});

test('DRC: 取付穴と銅・穴どうしの間隔、シルク', () => {
  const { prj, pcb } = boardA();
  routeA(pcb);
  const j1 = pad(pcb, 'J1', '1');
  addHole(pcb, j1.x + 2.2, j1.y, 3.2); // パッドの近く
  addText(pcb, pad(pcb, 'R1', '1').x, pad(pcb, 'R1', '1').y, 'LED', 'F.SilkS', 1); // パッドの上の文字
  addText(pcb, 40, 5, 'OUT', 'F.SilkS', 1);
  const r = runDrc(prj, pcb);
  const rules = rulesOf(r);
  assert.ok(rules.includes('npth_clearance'));
  assert.ok(rules.includes('hole_to_hole'));
  assert.ok(rules.includes('silk_pad'));
  assert.ok(rules.includes('silk_outside'));
});

test('DRC: ルールはプロジェクトの設定で変えられる', () => {
  const { prj, pcb } = boardA();
  routeA(pcb);
  prj.board.rules.minTrackWidthMm = 0.4;
  const r = runDrc(prj, pcb);
  assert.ok(r.issues.filter((i) => i.rule === 'track_width').length >= 3);
  assert.equal(r.rules.minTrackWidthMm, 0.4);
});

test('形状: 指摘位置は交点・最も近い所', async () => {
  const { nearestPoint } = await import('../js/core/geom2d.js');
  const cap = (x1, y1, x2, y2, r) => ({ type: 'cap', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, r });
  assert.deepEqual(nearestPoint(cap(0, 5, 20, 5, 0.15), cap(12, 0, 12, 10, 0.15)), { x: 12, y: 5 });
  const p = nearestPoint(cap(0, 0, 10, 0, 0.1), cap(4, 1, 4, 9, 0.1));
  assert.ok(Math.abs(p.x - 4) < 1e-9 && Math.abs(p.y - 0.5) < 1e-9);
});
