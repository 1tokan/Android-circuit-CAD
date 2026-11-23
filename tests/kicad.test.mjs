// node --test tests/kicad.test.mjs … KiCad 書き出しと、近すぎるビアのまとめ
// KiCad 本体での読み込み確認は tests/tools/kicad-verify.sh（KiCad 7 の pcbnew が要る）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModules } from './scenarios.js';

const M = await loadModules(new URL('../', import.meta.url).href);
const K = await import('../js/output/kicad.js');
const V = await import('../js/pcb/viafix.js');
const sample = () => M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));

/** S式の括弧の対応と、文字列の外の括弧の数 */
function balanced(text) {
  let d = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '(') d++; else if (c === ')') { d--; if (d < 0) return false; }
  }
  return d === 0 && !inStr;
}

test('サンプル: .kicad_pcb の中身の数がプロジェクトと一致する', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  const files = K.kicadFiles(prj, { version: 't' });
  assert.deepEqual(files.map((f) => f.name.split('.').pop()), ['kicad_pcb', 'kicad_pro', 'kicad_dru']);
  const t = files[0].content;
  assert.ok(t.startsWith(`(kicad_pcb (version ${K.KICAD_PCB_VERSION}) (generator pocket_eda)`));
  assert.ok(balanced(t), '括弧が対応している');
  const count = (re) => (t.match(re) || []).length;
  assert.equal(count(/^ {2}\(footprint "PocketEDA:(?!MountingHole_NPTH)/gm), pcb.footprints.length);
  assert.equal(count(/^ {2}\(footprint "PocketEDA:MountingHole_NPTH"/gm), pcb.holes.length);
  assert.equal(count(/^ {2}\(segment /gm), pcb.tracks.length);
  assert.equal(count(/^ {2}\(via /gm), pcb.vias.length);
  assert.equal(count(/^ {2}\(zone /gm), pcb.zones.length);
  assert.equal(count(/^ {4}\(pad /gm), pcb.footprints.reduce((s, f) => s + f.fpDef.pads.length, 0) + pcb.holes.length);
  // 4層: 内層 2 枚
  assert.match(t, /\(1 "In1\.Cu" signal\)\n {4}\(2 "In2\.Cu" signal\)\n {4}\(31 "B\.Cu" signal\)/);
  // ネット: 全ネットが番号つきで並ぶ。配線のネット番号は表のとおり
  const nets = new Map([...t.matchAll(/^ {2}\(net (\d+) "([^"]*)"\)/gm)].map((m) => [m[2], Number(m[1])]));
  for (const tr of pcb.tracks) assert.ok(nets.has(tr.net), tr.net);
  const gnd = nets.get('GND');
  assert.ok(t.includes(`(net ${gnd}) (tstamp`), 'GND の配線がある');
  // 設計ルール
  const pro = JSON.parse(files[1].content);
  const R = M.drc.drcRules(prj);
  assert.equal(pro.board.design_settings.rules.min_clearance, R.minClearanceMm);
  assert.equal(pro.board.design_settings.rules.min_track_width, R.minTrackWidthMm);
  assert.equal(pro.board.design_settings.rules.min_hole_to_hole, R.minSameNetHoleMm);
  assert.ok(balanced(files[2].content));
  assert.match(files[2].content, /constraint clearance \(min 0\.2mm\)/);
  // 同じ設計からは同じファイル（tstamp が決まった値）
  assert.equal(K.kicadFiles(prj, { version: 't' })[0].content, t);
});

test('裏面・回転した部品: KiCad の変換で戻すとパッドの位置が一致する', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  // 1 つを裏面・各角度にして確かめる
  const f = pcb.footprints.find((q) => q.fpDef.pads.length >= 3 && q.fpDef.pads.every((p) => p.type === 'smd'));
  for (const side of ['top', 'bottom']) for (const rot of [0, 90, 180, 270, 30]) {
    f.side = side; f.rot = rot;
    const t = K.kicadPcb(prj);
    const block = t.split('\n  (footprint ').find((b) => b.includes(`(property "PocketEDA_ID" "${f.id}")`));
    const at = block.match(/\n {4}\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/);
    const [fx, fy, fa] = [Number(at[1]), Number(at[2]), Number(at[3] || 0)];
    assert.match(block, new RegExp(`^"[^"]*" \\(layer "${side === 'bottom' ? 'B' : 'F'}\\.Cu"\\)`));
    const pads = [...block.matchAll(/\(pad "([^"]*)" smd \w+ \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\).*?\(layers "([FB])\.Cu"/g)];
    assert.equal(pads.length, f.fpDef.pads.length);
    const th = (fa * Math.PI) / 180;
    const want = M.pcb.allPads(pcb).filter((q) => q.inst === f);
    pads.forEach((m, k) => {
      const x = Number(m[2]), y = Number(m[3]);
      // KiCad: 盤面 = 部品の位置 + RotatePoint(部品内座標, 角度)（RotatePoint は x' = x cos + y sin, y' = −x sin + y cos）
      const bx = fx + x * Math.cos(th) + y * Math.sin(th), by = fy - x * Math.sin(th) + y * Math.cos(th);
      assert.ok(Math.hypot(bx - want[k].x, by - want[k].y) < 1e-5, `${side} ${rot}° pad ${m[1]}: ${bx},${by} ≠ ${want[k].x},${want[k].y}`);
      assert.equal(m[5], side === 'bottom' ? 'B' : 'F');
      assert.equal(Number(m[4] || 0), fa, 'パッドの角度は部品の角度（絶対）');
    });
  }
});

test('2層の小さな設計も書き出せる（内層なし・ネットなしのビア）', () => {
  const prj = M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
  const pcb = M.pcb.ensurePcb(prj);
  pcb.settings.layers = 2;
  pcb.zones = pcb.zones.filter((z) => !/^In/.test(z.layer));
  pcb.vias.push({ id: 'v_x', x: 1e6, y: 1e6, diameter: 6e5, drill: 3e5, net: null });
  const t = K.kicadPcb(prj);
  assert.ok(!/In1\.Cu/.test(t));
  assert.match(t, /\(via \(at 1 1\) \(size 0\.6\) \(drill 0\.3\) \(layers "F\.Cu" "B\.Cu"\) \(net 0\)/);
  assert.ok(balanced(t));
});

test('同じネットで近すぎるビア: DRC が見つけ、まとめると配線はつながったまま', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  const rules = M.drc.drcRules(prj);
  assert.equal(V.closeViaPairs(pcb, rules).length, 0, 'サンプルには無い');
  // 既存の配線つきビアの隣（中心 0.3mm）に同じネットのビアを打ち、表の短い配線でつなぐ
  const v0 = pcb.vias.find((v) => v.net === '+3V3' && pcb.tracks.some((t) => t.a.x === v.x && t.a.y === v.y || t.b.x === v.x && t.b.y === v.y));
  const v1 = { id: 'v_near', x: v0.x + 300000, y: v0.y, diameter: v0.diameter, drill: v0.drill, net: v0.net };
  pcb.vias.push(v1);
  M.zonefill.fillAllZones(pcb, rules);
  const d1 = M.drc.runDrc(prj, pcb);
  assert.ok(d1.issues.some((i) => i.rule === 'hole_to_hole' && /同じネット/.test(i.message)), '同じネットの穴の間隔を DRC が見つける');
  const r = V.mergeCloseVias(pcb, rules);
  assert.equal(r.merged, 1);
  assert.ok(pcb.vias.includes(v0) && !pcb.vias.includes(v1), '配線のある方を残す');
  M.zonefill.fillAllZones(pcb, rules);
  const d2 = M.drc.runDrc(prj, pcb);
  assert.equal(d2.summary.errors, 0);
  assert.equal(d2.summary.unrouted, 0);
});
