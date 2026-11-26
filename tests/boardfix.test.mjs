// node --test tests/boardfix.test.mjs … 取付穴（ネジの頭の範囲）・角丸パッドの距離・サーマルのスポーク・シルクの切り取り・サンプルの検査結果
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModules } from './scenarios.js';

const M = await loadModules(new URL('../', import.meta.url).href);
const { shapeDist } = await import('../js/core/geom2d.js');
const { padShape, boardSilkSegments } = await import('../js/pcb/shapes.js');
const { spokeGeom } = await import('../js/pcb/zonefill.js');
const { starvedPads } = await import('../js/pcb/thermalfix.js');
const K = await import('../js/output/kicad.js');
const sample = () => M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
const emptyPcb = (w = 40, h = 30) => { const p = M.project.createProject('t'); const pcb = M.pcb.ensurePcb(p); M.pcb.setOutlineRect(pcb, w, h); return { p, pcb }; };

test('四隅の取付穴: M3（穴 3.2mm・頭の範囲 φ6）を角から 3.5mm に。二度目は増えない', () => {
  const { pcb } = emptyPcb();
  const a = M.pcb.addCornerHoles(pcb, { screw: 'M3' });
  assert.equal(a.length, 4);
  assert.deepEqual(a.map((h) => [M.pcb.toMm(h.x), M.pcb.toMm(h.y)]), [[3.5, 3.5], [36.5, 3.5], [36.5, 26.5], [3.5, 26.5]]);
  assert.ok(a.every((h) => M.pcb.toMm(h.drill) === 3.2 && M.pcb.toMm(h.keepout) === 6));
  assert.equal(M.pcb.addCornerHoles(pcb).length, 0);
  assert.equal(M.pcb.holeClearRadiusMm(a[0], 0.5), 3);
});

test('DRC: ネジの頭の範囲に入ったビア・部品はエラー、ベタはその範囲を塗らない', () => {
  const { p, pcb } = emptyPcb();
  M.pcb.addCornerHoles(pcb);
  M.pcb.addVia(pcb, 5.5, 5.5, 'GND'); // 穴の中心から 2.8mm（頭の範囲 3mm の内側、穴と銅の間隔は足りる）
  const z = M.pcb.addBoardZone(pcb, 'F.Cu', 'GND');
  const rules = M.drc.drcRules(p);
  const r = M.drc.runDrc(p, pcb);
  assert.ok(r.issues.some((i) => i.rule === 'hole_keepout'), JSON.stringify(r.issues.map((i) => i.rule)));
  const fill = M.zonefill.fillZone(pcb, z, rules);
  // 穴の中心から 2.9mm の点は塗られない
  const pt = { x: 3.5 + 2.9, y: 3.5 };
  assert.ok(!fill.polygons.some((poly) => M.zonefill.pointInPolyWithHoles(pt, poly)));
});

test('角丸パッドの距離は角の丸みを入れる（QFN の角どうしのレジストの橋）', () => {
  const inst = { x: 0, y: 0, rot: 0, side: 'top' };
  const a = padShape(inst, { x: -1.4375, y: 0.75, w: 0.875, h: 0.25, shape: 'roundrect' });
  const b = padShape(inst, { x: -0.75, y: 1.4375, w: 0.25, h: 0.875, shape: 'roundrect' });
  const ra = padShape(inst, { x: -1.4375, y: 0.75, w: 0.875, h: 0.25, shape: 'rect' });
  const rb = padShape(inst, { x: -0.75, y: 1.4375, w: 0.25, h: 0.875, shape: 'rect' });
  assert.ok(Math.abs(shapeDist(ra, rb) - Math.SQRT2 * 0.125) < 1e-9);
  // 角の半径 0.0625 の円どうし: 中心の距離 0.3536 − 0.125
  assert.ok(Math.abs(shapeDist(a, b) - (Math.hypot(0.25, 0.25) - 0.125)) < 1e-9, String(shapeDist(a, b)));
});

test('スポークの向き: 0° は縦横、45° は斜めで、先端は隙間の外', () => {
  const inst = { x: 0, y: 0, rot: 0, side: 'top' };
  const p = { inst, pad: { x: 0, y: 0, w: 0.6, h: 0.6 } };
  const P = { thermalGap: 0.25, spoke: 0.3, minWidth: 0.25 };
  const g0 = spokeGeom(p, P, 0), g45 = spokeGeom(p, P, 45);
  assert.equal(g0.tips.length, 4); assert.equal(g45.tips.length, 4);
  assert.ok(g0.tips.every((t) => Math.abs(t.x) < 1e-9 || Math.abs(t.y) < 1e-9));
  assert.ok(g45.tips.every((t) => Math.abs(Math.abs(t.x) - Math.abs(t.y)) < 1e-9));
  for (const t of [...g0.tips, ...g45.tips]) assert.ok(Math.max(Math.abs(t.x), Math.abs(t.y)) > 0.3 + 0.25);
});

test('基板の端からはみ出す部品の外形線は、基板の内側で切る（Gerber と KiCad で同じ）', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  const j1 = pcb.footprints.find((f) => f.ref === 'J1');
  const r = boardSilkSegments(pcb, j1);
  assert.ok(r.clipped);
  for (const s of r.segs) for (const q of [s.a, s.b]) { const b = M.pcb.fpToBoard(j1, q.x, q.y); assert.ok(b.x >= 0.06 - 1e-6, String(b.x)); }
});

test('サンプル: 60×34mm・四隅に M3・DRC のエラーも警告も 0・スポーク不足 0', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  assert.equal(M.pcb.boardSizeText(pcb), '60.0 × 34.0 mm');
  assert.equal(pcb.holes.length, 4);
  assert.ok(pcb.holes.every((h) => M.pcb.toMm(h.drill) === 3.2 && M.pcb.toMm(h.keepout) === 6));
  const r = M.drc.runDrc(prj, pcb);
  assert.equal(r.summary.errors, 0, r.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  assert.equal(r.summary.warnings, 0, r.issues.filter((i) => i.level === 'warning').map((i) => i.message).join('\n'));
  assert.equal(starvedPads(pcb, M.drc.drcRules(prj)).length, 0);
  // IC・USB-C はベタに直結
  assert.ok(pcb.footprints.filter((f) => /^U\d/.test(f.ref) || f.ref === 'J1').every((f) => f.zoneConnect === 'solid'));
});

test('KiCad 書き出し: 取付穴の keepout・直結の部品・スポークの向き・切った外形線の部品', () => {
  const prj = sample();
  const files = K.kicadFiles(prj, { version: 't' });
  const pcbText = files.find((f) => f.name.endsWith('.kicad_pcb')).content;
  assert.equal((pcbText.match(/\(keepout \(tracks not_allowed\) \(vias not_allowed\) \(pads allowed\) \(copperpour not_allowed\)/g) || []).length, 4);
  assert.ok((pcbText.match(/\(zone_connect 2\)/g) || []).length >= 10);
  assert.ok(/\(thermal_bridge_angle 90\)/.test(pcbText));
  assert.ok(files.some((f) => /PocketEDA\.pretty\/USB_C_HRO_TYPE-C-31-M-12_EdgeCut\.kicad_mod$/.test(f.name)));
  assert.ok(files.some((f) => /MountingHole_NPTH_3\.2mm_Keepout6mm\.kicad_mod$/.test(f.name)));
});
