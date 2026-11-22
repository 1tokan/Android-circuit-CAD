// node --test tests/pkggen.test.mjs  パッケージ名からのフットプリント自動生成
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFootprint } from '../js/library/pkggen.js';
import { getFootprint } from '../js/library/footprints.js';
import { guessFootprint, icPinCount, partSymbol, effectivePinMap, checkPinMap, normalizePart, partFootprint } from '../js/library/parts.js';

const pad = (fp, n) => fp.pads.find((p) => p.num === String(n));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function noOverlap(fp) {
  const ps = fp.pads;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], b = ps[j];
    if (a.num === b.num) continue; // 同番号（タブ等）は重なってよい
    const ox = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9;
    const oy = Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-9;
    if (ox && oy) return `${fp.name}: パッド${a.num}と${b.num}が重なっています`;
  }
  return null;
}

const NAMES = [
  ['ic', 'QFN-56-EP(7x7)'], ['ic', 'QFN-32(5x5)'], ['ic', 'QFN-20(3x3)'], ['ic', 'QFN-24(4x4)'], ['ic', 'LQFP-48(7x7)'], ['ic', 'LQFP-32(7x7)'],
  ['ic', 'LQFP-64(10x10)'], ['ic', 'LQFP-100(14x14)'], ['ic', 'TSSOP-20'], ['ic', 'SOP-8_L4.9-W3.9-P1.27-LS6.0-BL'], ['ic', 'SOIC-16-300mil'],
  ['ic', 'ESOP-8'], ['ic', 'MSOP-10'], ['ic', 'MSOP-8'], ['ic', 'SSOP-28'], ['ic', 'DFN-8(3x3)'], ['ic', 'SOT-23-6'], ['ic', 'SOT-23-8'],
  ['ic', 'SC-70-5'], ['ic', 'SOT-363'], ['ic', 'SOT-89-3'], ['ic', 'TO-252-2'], ['diode', 'SOD-123F'], ['diode', 'SMB'], ['diode', 'SMC'],
  ['diode', 'SOD-523'], ['resistor', '2512'], ['resistor', '0201'], ['capacitor', '1210'], ['capacitor', 'CASE-B-3528'],
  ['electrolytic', 'SMD,D8xL10.2mm'], ['ic', 'SMD3225-4P'], ['led', '5050'], ['connector', 'HDR-M-2.54_1x4'], ['connector', 'HDR-F-2.54_2x5'],
  ['inductor', 'SMD,4x4mm'],
];

test('代表的なパッケージ名から生成でき、パッドが重ならず、推定扱い', () => {
  for (const [k, n] of NAMES) {
    const fp = generateFootprint(k, n);
    assert.ok(fp, `${n} を生成できない`);
    assert.equal(fp.generated, true);
    assert.equal(fp.verified, false);
    assert.equal(noOverlap(fp), null);
    for (const p of fp.pads) assert.ok(p.w > 0 && p.h > 0 && Number.isFinite(p.x) && Number.isFinite(p.y), `${n} pad ${p.num}`);
    assert.equal(getFootprint(fp.id)?.id, fp.id, 'IDから再生成できる');
  }
});

test('QFN-56-EP(7x7): ピッチ0.4・辺14本・番号は左上から反時計回り・露出パッドは57番', () => {
  const fp = generateFootprint('ic', 'QFN-56-EP(7x7)');
  assert.equal(fp.pads.length, 57);
  assert.ok(near(pad(fp, 2).y - pad(fp, 1).y, 0.4));
  assert.ok(pad(fp, 1).x < 0 && pad(fp, 1).y < 0, '1番: 左辺の上');
  assert.ok(pad(fp, 15).y > 0 && pad(fp, 15).x < 0, '15番: 下辺の左');
  assert.ok(pad(fp, 29).x > 0 && pad(fp, 29).y > 0, '29番: 右辺の下');
  assert.ok(pad(fp, 43).y < 0 && pad(fp, 43).x > 0, '43番: 上辺の右');
  assert.ok(near(pad(fp, 57).x, 0) && near(pad(fp, 57).y, 0), '57番: 中央');
});

test('ピッチの推定（名前にPが無い場合）', () => {
  const pitch = (n) => { const fp = generateFootprint('ic', n); return Math.round((pad(fp, 2).y - pad(fp, 1).y) * 1000) / 1000; };
  assert.equal(pitch('QFN-32(5x5)'), 0.5);
  assert.equal(pitch('QFN-20(3x3)'), 0.4);
  assert.equal(pitch('QFN-24(4x4)'), 0.5);
  assert.equal(pitch('LQFP-32(7x7)'), 0.8);
  assert.equal(pitch('LQFP-48(7x7)'), 0.5);
  assert.equal(pitch('LQFP-100(14x14)'), 0.5);
  assert.equal(pitch('TSSOP-20'), 0.65);
  assert.equal(pitch('MSOP-10'), 0.5);
});

test('名前の寸法（P・LS）を優先し、幅広SOICは細幅と区別する', () => {
  const a = generateFootprint('ic', 'SSOP-20_L7.2-W5.3-P0.65-LS7.8-BL');
  assert.ok(near(pad(a, 2).y - pad(a, 1).y, 0.65));
  const narrow = getFootprint(guessFootprint('ic', 'SOIC-16'));
  const wide = getFootprint(guessFootprint('ic', 'SOIC-16-300mil'));
  assert.equal(narrow.id, 'SOIC-16');
  assert.ok(wide.generated);
  assert.ok(pad(wide, 1).x < pad(narrow, 1).x - 1.5, '幅広は端子間が広い');
});

test('SOT-23-5 / SOT-23-6 の番号（左上から反時計回り）と SOT-89 のタブ', () => {
  const s5 = generateFootprint('ic', 'SOT-23-5-X');
  void s5;
  const s6 = generateFootprint('ic', 'SOT-23-6');
  assert.ok(pad(s6, 1).x < 0 && pad(s6, 1).y < 0);
  assert.ok(pad(s6, 3).x < 0 && pad(s6, 3).y > 0);
  assert.ok(pad(s6, 4).x > 0 && pad(s6, 4).y > 0);
  assert.ok(pad(s6, 6).x > 0 && pad(s6, 6).y < 0);
  const s89 = generateFootprint('ic', 'SOT-89-3');
  assert.equal(s89.pads.filter((p) => p.num === '2').length, 2, 'タブは2番');
});

test('ピンヘッダ 2x5 は 1,2 が同じ行（奇数=左列）', () => {
  const h = generateFootprint('connector', 'HDR-F-2.54_2x5');
  assert.equal(h.pads.length, 10);
  assert.ok(near(pad(h, 1).y, pad(h, 2).y) && pad(h, 1).x < pad(h, 2).x);
  assert.ok(near(pad(h, 3).y - pad(h, 1).y, 2.54));
  assert.equal(pad(h, 1).type, 'tht');
});

test('ICのピン数はフットプリントのパッド番号数に合わせ、ピン対応エラーが出ない', () => {
  for (const pkg of ['QFN-32(5x5)', 'SOT-223', 'SOT-89-3', 'ESOP-8', 'LQFP-48(7x7)', 'DFN-8(3x3)', 'TO-252-2']) {
    const id = guessFootprint('ic', pkg);
    const p = normalizePart({ name: pkg, kind: 'ic', package: pkg, footprint: id, symbol: { kind: 'ic', pinCount: icPinCount(id, pkg) } });
    const sym = partSymbol(p), fp = partFootprint(p);
    assert.deepEqual(checkPinMap(sym, fp, effectivePinMap(sym, fp, null)).errors, [], pkg);
  }
});

test('生成できない名前は null（勝手な形を作らない）', () => {
  for (const n of ['SMD-41,18x25.5mm', 'USB-C-SMD_TYPE-C-31-M-12', 'QFN-56', 'BGA-100', '', 'XYZ']) assert.equal(generateFootprint('ic', n), null, n);
});
