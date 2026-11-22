// node --test tests/output.test.mjs … ベタ塗り・シルク文字・Gerber・Excellon・ZIP
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createProject } from '../js/core/project.js';
import { addComponent, addWirePath, addLabel } from '../js/schematic/model.js';
import { BUILTIN_PARTS, partFootprint } from '../js/library/parts.js';
import { generateNetlist } from '../js/netlist/netlist.js';
import { ensurePcb, importNetlist, allPads, addTrackPath, addVia, addHole, addText, addBoardZone, toNm, setOutlineRect } from '../js/pcb/model.js';
import { computePcbConnectivity } from '../js/pcb/connectivity.js';
import { fillZone, pointInPolyWithHoles, capsulePoly, ringArea } from '../js/pcb/zonefill.js';
import { textStrokes, textWidth, unsupportedChars } from '../js/pcb/text.js';
import { runDrc } from '../js/check/drc.js';
import { buildPlot, padAperture, LAYERS } from '../js/output/plot.js';
import { gerberFiles, writeExcellon } from '../js/output/gerber.js';
import { makeZip, crc32 } from '../js/output/zip.js';

const part = (pred) => BUILTIN_PARTS.find(pred);
function boardA() {
  const prj = createProject('Test A');
  const sh = prj.schematic.sheets[0];
  const place = (p, x, y) => { if (!prj.library.parts.includes(p)) prj.library.parts.push(p); return addComponent(sh, p.kind, x, y, { partId: p.id, value: p.value, footprint: p.footprint, ...(p.symbol.pinCount ? { pinCount: p.symbol.pinCount, pinNames: p.symbol.pinNames } : {}) }); };
  place(part((p) => p.name.startsWith('JST PH 2ピン')), -10, 0);
  place(part((p) => p.name.startsWith('抵抗 330Ω')), 4, -10);
  place(part((p) => p.name === 'LED 赤 0805'), 14, -10);
  addComponent(sh, 'gnd', -20, 10).props.net = 'GND';
  addWirePath(sh, [{ x: -14, y: -1 }, { x: -18, y: -1 }, { x: -18, y: -10 }, { x: 0, y: -10 }]);
  addWirePath(sh, [{ x: 8, y: -10 }, { x: 11, y: -10 }]);
  addWirePath(sh, [{ x: 17, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 6 }]);
  addLabel(sh, 20, 6, 'GND');
  addWirePath(sh, [{ x: -14, y: 1 }, { x: -20, y: 1 }, { x: -20, y: 10 }]);
  prj.netlist = generateNetlist(prj);
  const pcb = ensurePcb(prj);
  importNetlist(pcb, prj.netlist, (c) => partFootprint(prj.library.parts.find((p) => p.id === c.partId)));
  setOutlineRect(pcb, 30, 20);
  const at = (ref, x, y, rot = 0) => { const f = pcb.footprints.find((q) => q.ref === ref); f.x = toNm(x); f.y = toNm(y); f.rot = rot; };
  at('J1', 6, 10, 90); at('R1', 15, 6); at('D1', 23, 10);
  const pad = (ref, n) => allPads(pcb).find((p) => p.ref === ref && p.pad.num === n);
  const w = toNm(0.3);
  const P = { j1: pad('J1', '1'), j2: pad('J1', '2'), r1: pad('R1', '1'), r2: pad('R1', '2'), d1: pad('D1', '1'), d2: pad('D1', '2') };
  addTrackPath(pcb, [P.j1, { x: P.j1.x, y: 6 }, P.r1], 'F.Cu', w, P.j1.net);
  addTrackPath(pcb, [P.r2, { x: P.d2.x, y: 6 }, P.d2], 'F.Cu', w, P.r2.net);
  return { prj, pcb, P, pad };
}

// ---------------- ベタ ----------------
test('ベタ: 裏面GNDで J1-2（スルーホール）と D1-1（表SMD・ビア経由）がつながり、未配線0・DRCエラー0', () => {
  const { prj, pcb, P } = boardA();
  addBoardZone(pcb, 'B.Cu', 'GND');
  addVia(pcb, P.d1.x - 1.5, P.d1.y, 'GND');
  addTrackPath(pcb, [P.d1, { x: P.d1.x - 1.5, y: P.d1.y }], 'F.Cu', toNm(0.3), 'GND');
  const c = computePcbConnectivity(pcb, { rules: prj.board.rules });
  assert.equal(c.unrouted, 0, JSON.stringify(c.ratsnest));
  const r = runDrc(prj, pcb);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.issues.filter((i) => i.level === 'error').map((i) => i.message)));
  const z = fillZone(pcb, pcb.zones[0], prj.board.rules);
  assert.equal(z.polygons.length, 1, '島は1つ');
  // 別ネットのパッド J1-1 の中心はベタの外（穴の中）、同ネットの J1-2 の中心はスポークでベタの中
  assert.ok(!pointInPolyWithHoles(P.j1, z.polygons[0]));
  assert.ok(pointInPolyWithHoles(P.j2, z.polygons[0]));
  // サーマル: J1-2 の周りには隙間がある（パッド端から 0.15mm 外の点のうち、スポーク以外は塗られていない）
  const pad = P.j2.pad; // 縦長 1.2×1.75、部品は90°回転
  const probe = { x: P.j2.x + 0.5, y: P.j2.y + pad.w / 2 + 0.15 }; // 斜め方向（スポークの外）
  assert.ok(!pointInPolyWithHoles(probe, z.polygons[0]), 'サーマルの隙間');
});

test('ベタ: クリアランスで分断された島は取り除き、ラッツネストが残る', () => {
  const { prj, pcb } = boardA();
  // 表面に GND ベタを小さく作り、別ネット配線で囲って孤立させる
  pcb.zones.push({ id: 'zx', layer: 'F.Cu', net: 'GND', polygon: [[1, 13], [12, 13], [12, 19], [1, 19]].map(([x, y]) => ({ x: toNm(x), y: toNm(y) })), clearance: toNm(0.3) });
  addTrackPath(pcb, [{ x: 0.5, y: 16 }, { x: 13, y: 16 }], 'F.Cu', toNm(0.3), 'Net-X');
  const z = fillZone(pcb, pcb.zones[0], prj.board.rules);
  assert.equal(z.polygons.length, 0, 'どのGNDパッドにも触れない島は消える');
  assert.equal(z.islandsRemoved, 2, '配線で上下2つに分かれた島');
  const r = runDrc(prj, pcb);
  assert.ok(r.issues.some((i) => i.rule === 'zone_fill' && /島/.test(i.message)));
});

test('ベタ: 別ネットの銅とのクリアランスを守る（全辺を検算）', () => {
  const { prj, pcb, P } = boardA();
  addBoardZone(pcb, 'F.Cu', 'GND');
  const z = fillZone(pcb, pcb.zones[0], prj.board.rules);
  assert.ok(z.polygons.length >= 1);
  const r = runDrc(prj, pcb);
  assert.ok(!r.issues.some((i) => i.rule === 'zone_fill' && i.level === 'error'), JSON.stringify(r.issues.filter((i) => i.rule === 'zone_fill').map((i) => i.message)));
  assert.ok(!pointInPolyWithHoles(P.r1, z.polygons[0]) && !pointInPolyWithHoles({ x: P.j1.x, y: 6 }, z.polygons[0]));
});

test('外接多角形: 円の近似は真円より外側（クリアランスが減らない）', () => {
  const c = capsulePoly({ x: 0, y: 0 }, { x: 0, y: 0 }, 1);
  for (let i = 0; i < c.length - 1; i++) {
    const [a, b] = [c[i], c[i + 1]];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    assert.ok(Math.hypot(mx, my) >= 1 - 1e-9, '辺の中点も半径以上');
  }
  assert.ok(Math.abs(ringArea(c)) > Math.PI);
});

// ---------------- 文字 ----------------
test('シルク文字: 幅・中央揃え・裏面は左右反転・出力できない文字', () => {
  assert.ok(Math.abs(textWidth('I', 2.1) - 0.8) < 1e-9, 'I の送り幅 8 単位 × 0.1');
  const s = textStrokes('R1', { x: 10, y: 5, size: 1, align: 'center', valign: 'baseline' });
  const xs = s.flat().map((p) => p.x), ys = s.flat().map((p) => p.y);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 10) < 0.3, '中央揃え');
  assert.ok(Math.max(...ys) <= 5 + 1e-9 && Math.min(...ys) >= 4 - 1e-9, 'ベースライン上、高さ1mm');
  const m = textStrokes('R', { x: 0, y: 0, size: 1, mirror: true, align: 'left' });
  assert.ok(Math.max(...m.flat().map((p) => p.x)) <= 1e-9, '裏面は左右反転');
  assert.deepEqual(unsupportedChars('LED 電源'), ['電', '源']);
});

// ---------------- Gerber ----------------
function parseGerber(src) {
  // 構文の自己検査（独立したパーサでの検証は tests/verify-gerber.mjs）
  const lines = src.trim().split('\n');
  assert.match(lines.at(-1), /^M02\*$/);
  assert.ok(src.includes('%FSLAX46Y46*%') && src.includes('%MOMM*%'));
  const defined = new Set([...src.matchAll(/%ADD(\d+)/g)].map((m) => m[1]));
  const used = new Set([...src.matchAll(/^D(\d+)\*$/gm)].map((m) => m[1]));
  for (const u of used) assert.ok(defined.has(u), `D${u} は定義済み`);
  assert.equal((src.match(/G36\*/g) || []).length, (src.match(/G37\*/g) || []).length);
  for (const m of src.matchAll(/^X(-?\d+)Y(-?\d+)D0([123])\*$/gm)) assert.ok(Number.isInteger(+m[1]) && Number.isInteger(+m[2]));
  const pts = [...src.matchAll(/^X(-?\d+)Y(-?\d+)D0[123]\*$/gm)].map((m) => ({ x: +m[1] / 1e6, y: +m[2] / 1e6 }));
  return { pts, defined };
}

test('Gerber: 全層を出力し、Y は上向き（反転）・外形は基板寸法どおり', () => {
  const { prj, pcb } = boardA();
  addBoardZone(pcb, 'B.Cu', 'GND');
  addHole(pcb, 27, 16.5, 3.2);
  addText(pcb, 15, 17, 'Pocket EDA', 'F.SilkS', 1.2);
  const plot = buildPlot(prj, pcb);
  const files = gerberFiles(plot, { project: 'Test A', version: '0.6.0', date: '2026-11-22T10:00:00Z' });
  const names = files.map((f) => f.name);
  for (const ext of ['gtl', 'gbl', 'gts', 'gbs', 'gto', 'gbo', 'gtp', 'gm1']) assert.ok(names.some((n) => n.endsWith('.' + ext)), ext);
  assert.ok(names.includes('Test_A-PTH.drl') && names.includes('Test_A-NPTH.drl'));
  assert.ok(!names.some((n) => n.endsWith('.gbp')), '裏に SMD が無ければ裏メタルマスクは出さない');
  for (const f of files.filter((x) => !x.name.endsWith('.drl'))) {
    const g = parseGerber(f.content);
    const l = LAYERS.find((q) => q.id === f.layer);
    assert.ok(f.content.includes(`%TF.FileFunction,${l.func}*%`));
    if (f.layer === 'Edge.Cuts') {
      const xs = g.pts.map((p) => p.x), ys = g.pts.map((p) => p.y);
      assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 30, -20, 0]);
    }
  }
  const cu = files.find((f) => f.layer === 'F.Cu').content;
  // R1 は (15,6) → Gerber では Y=-6
  assert.ok(/X14087500Y-6000000D03\*/.test(cu), 'R1-1 のパッド位置');
  const bcu = files.find((f) => f.layer === 'B.Cu').content;
  assert.ok(bcu.includes('G36*') && bcu.includes('%LPC*%'), 'ベタは領域で、穴は clear で抜く');
  const silk = files.find((f) => f.layer === 'F.SilkS').content;
  assert.ok((silk.match(/D01\*/g) || []).length > 30, 'シルク文字はストローク');
});

test('Gerber: 回転したパッドは角の座標で、角丸は RoundRect マクロ', () => {
  const inst = { x: 0, y: 0, rot: 45, side: 'top' };
  const ap = padAperture(inst, { x: 0, y: 0, w: 2, h: 1, shape: 'rect' });
  assert.equal(ap.kind, 'OutlineRect');
  const rr = padAperture({ ...inst, rot: 90 }, { x: 0, y: 0, w: 2, h: 1, shape: 'roundrect' });
  assert.equal(rr.kind, 'RoundRect');
  assert.equal(rr.r, 0.25);
  const r90 = padAperture({ ...inst, rot: 90 }, { x: 0, y: 0, w: 2, h: 1, shape: 'rect' });
  assert.deepEqual(r90, { kind: 'R', w: 1, h: 2 }, '90°回転は縦横を入れ替える');
  const mask = padAperture({ ...inst, rot: 0 }, { x: 0, y: 0, w: 2, h: 1, shape: 'circle' }, 0.05);
  assert.equal(mask.d, 2.1, 'レジスト開口は片側0.05mm');
});

test('Excellon: 小数点つき mm・工具径の昇順・Y反転', () => {
  const s = writeExcellon([{ x: 6, y: 9, d: 0.75 }, { x: 27, y: 16.5, d: 0.3 }, { x: 0, y: 0, d: 0.75 }], true, { version: 't', date: 'd' });
  assert.match(s, /^M48$/m);
  assert.match(s, /^METRIC$/m);
  assert.match(s, /^T1C0\.300$/m);
  assert.match(s, /^T2C0\.750$/m);
  assert.match(s, /^X27\.000Y-16\.500$/m);
  assert.match(s, /^X6\.000Y-9\.000$/m);
  assert.match(s, /^X0\.000Y0\.000$/m, '-0 にしない');
  assert.match(s, /M30\n$/);
});

// ---------------- ZIP ----------------
test('ZIP: CRC32 と、展開して元の内容に戻る', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [{ name: 'a.gtl', content: 'G04 test*\nM02*\n' }, { name: 'b.drl', content: 'M48\nM30\n' }];
  const zip = makeZip(files, new Date(2026, 10, 22, 12, 0, 0));
  const dv = new DataView(zip.buffer);
  // 終端レコード
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  // ローカルヘッダを順に読む
  let p = 0;
  for (const f of files) {
    assert.equal(dv.getUint32(p, true), 0x04034b50);
    const n = dv.getUint16(p + 26, true), size = dv.getUint32(p + 18, true);
    const name = new TextDecoder().decode(zip.subarray(p + 30, p + 30 + n));
    const data = new TextDecoder().decode(zip.subarray(p + 30 + n, p + 30 + n + size));
    assert.equal(name, f.name);
    assert.equal(data, f.content);
    assert.equal(dv.getUint32(p + 14, true), crc32(new TextEncoder().encode(f.content)));
    p += 30 + n + size;
  }
  assert.ok(zlib.crc32 ? zlib.crc32('123456789') === 0xcbf43926 : true);
});

test('DRC はベタの塗りつぶし結果を独立に検算する（壊れた塗りつぶしを検出）', () => {
  const { prj, pcb, P } = boardA();
  addBoardZone(pcb, 'F.Cu', 'GND');
  const c = computePcbConnectivity(pcb, { rules: prj.board.rules });
  const f = c.fills.get(pcb.zones[0].id);
  // わざと R1-1（別ネット）を覆う四角を足す（キャッシュを直接書き換え）
  f.polygons.push([[[P.r1.x - 1, P.r1.y - 1], [P.r1.x + 1, P.r1.y - 1], [P.r1.x + 1, P.r1.y + 1], [P.r1.x - 1, P.r1.y + 1], [P.r1.x - 1, P.r1.y - 1]]]);
  const r = runDrc(prj, pcb);
  assert.ok(r.issues.some((i) => i.rule === 'zone_fill' && i.level === 'error'), '間隔不足・埋まりを検出');
  f.polygons.pop();
});
