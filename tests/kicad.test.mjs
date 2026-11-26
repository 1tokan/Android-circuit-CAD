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
  const byExt = (e) => files.find((f) => f.name.endsWith(e));
  for (const e of ['.kicad_pro', '.kicad_pcb', '.kicad_sch', '.kicad_dru', '/PocketEDA.kicad_sym', '/sym-lib-table', '/fp-lib-table']) assert.ok(byExt(e), e);
  const t = byExt('.kicad_pcb').content;
  assert.ok(t.startsWith(`(kicad_pcb (version ${K.KICAD_PCB_VERSION}) (generator pocket_eda)`));
  assert.ok(balanced(t), '括弧が対応している');
  const count = (re) => (t.match(re) || []).length;
  assert.equal(count(/^ {2}\(footprint "PocketEDA:(?!MountingHole_NPTH)/gm), pcb.footprints.length);
  assert.equal(count(/^ {2}\(footprint "PocketEDA:MountingHole_NPTH_[\d.]+mm"/gm), pcb.holes.length);
  assert.equal(count(/^ {2}\(segment /gm), pcb.tracks.length);
  assert.equal(count(/^ {2}\(via /gm), pcb.vias.length);
  assert.equal(count(/^ {2}\(zone /gm), pcb.zones.length);
  assert.equal(count(/^ {4}\(pad /gm), pcb.footprints.reduce((s, f) => s + f.fpDef.pads.length + (f.fpDef.npth || []).length, 0) + pcb.holes.length);
  // 4層: 内層 2 枚
  assert.match(t, /\(1 "In1\.Cu" signal\)\n {4}\(2 "In2\.Cu" signal\)\n {4}\(31 "B\.Cu" signal\)/);
  // ネット: 全ネットが番号つきで並ぶ。配線のネット番号は表のとおり
  const nets = new Map([...t.matchAll(/^ {2}\(net (\d+) "([^"]*)"\)/gm)].map((m) => [m[2], Number(m[1])]));
  for (const tr of pcb.tracks) assert.ok(nets.has(tr.net) || nets.has(`/${tr.net}`), tr.net); // ネットラベルのネットは KiCad と同じく / が付く
  const gnd = nets.get('GND');
  assert.ok(t.includes(`(net ${gnd}) (tstamp`), 'GND の配線がある');
  // 設計ルール
  const pro = JSON.parse(byExt('.kicad_pro').content);
  const R = M.drc.drcRules(prj);
  assert.equal(pro.board.design_settings.rules.min_clearance, R.minClearanceMm);
  assert.equal(pro.board.design_settings.rules.min_track_width, R.minTrackWidthMm);
  assert.equal(pro.board.design_settings.rules.min_hole_to_hole, R.minSameNetHoleMm);
  assert.ok(balanced(byExt('.kicad_dru').content));
  assert.match(byExt('.kicad_dru').content, /constraint clearance \(min 0\.2mm\)/);
  assert.match(byExt('.kicad_dru').content, /\(constraint min_resolved_spokes 2\)/, 'KiCad 7 はスポークの本数を数だけで書く（(min 2) は読めない）');
  // 同じ設計からは同じファイル（tstamp が決まった値）
  assert.equal(K.kicadFiles(prj, { version: 't' }).find((f) => f.name.endsWith('.kicad_pcb')).content, t);
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

test('一式: ライブラリ・3D モデル・回路図とのつながり', () => {
  const prj = sample();
  const pcb = M.pcb.ensurePcb(prj);
  const files = K.kicadFiles(prj, { version: 't' });
  const pcbText = files.find((f) => f.name.endsWith('.kicad_pcb')).content;
  const sch = files.find((f) => f.name.endsWith('.kicad_sch')).content;
  const symLib = files.find((f) => f.name.endsWith('.kicad_sym')).content;
  for (const f of files.filter((x) => /\.(kicad_pcb|kicad_sch|kicad_sym|kicad_mod)$|lib-table$/.test(x.name))) assert.ok(balanced(f.content), f.name);
  // 基板の部品はすべてライブラリにある名前・3D モデルもある
  const mods = new Set(files.filter((f) => f.name.endsWith('.kicad_mod')).map((f) => f.name.split('/').pop().replace('.kicad_mod', '')));
  const wrls = new Set(files.filter((f) => f.name.endsWith('.wrl')).map((f) => f.name.split('/').pop().replace('.wrl', '')));
  const used = [...pcbText.matchAll(/^ {2}\(footprint "PocketEDA:([^"]+)"/gm)].map((m) => m[1]);
  assert.equal(used.length, pcb.footprints.length + pcb.holes.length);
  for (const u of used) assert.ok(mods.has(u), u);
  for (const m of pcbText.matchAll(/\(model "\$\{KIPRJMOD\}\/PocketEDA\.3dshapes\/([^"]+)\.wrl"/g)) assert.ok(wrls.has(m[1]), m[1]);
  assert.ok(wrls.size >= 10);
  // 回路図の部品（電源記号を除く）は基板の部品とパス（シンボルの uuid）でつながる
  const symUuids = new Set([...sch.matchAll(/\(symbol \(lib_id "PocketEDA:(?!PWR_)[^"]+"\)[\s\S]*?\(uuid ([0-9a-f-]+)\)/g)].map((m) => m[1]));
  const paths = [...pcbText.matchAll(/\(path "\/([0-9a-f-]+)"\)/g)].map((m) => m[1]);
  assert.equal(paths.length, pcb.footprints.length);
  for (const pth of paths) assert.ok(symUuids.has(pth), pth);
  // 回路図の Footprint 欄はライブラリの名前
  for (const m of sch.matchAll(/\(property "Footprint" "PocketEDA:([^"]+)"/g)) assert.ok(mods.has(m[1]), m[1]);
  // 回路図に埋め込んだシンボルとライブラリのシンボルは同じ名前の集まり
  const inSch = new Set([...sch.matchAll(/^ {4}\(symbol "PocketEDA:([^"]+)"/gm)].map((m) => m[1]));
  const inLib = new Set([...symLib.matchAll(/^ {2}\(symbol "([^"]+)"/gm)].map((m) => m[1]));
  assert.deepEqual([...inSch].sort(), [...inLib].sort());
  // ネットラベルのネットは KiCad と同じく / から始まる名前、電源はそのまま
  assert.match(pcbText, /\(net \d+ "\/I2S_BCLK"\)/);
  assert.match(pcbText, /\(net \d+ "GND"\)/);
  assert.match(pcbText, /\(net \d+ "\+3V3"\)/);
});

test('回路図の向き: Pocket EDA の回転・反転 → KiCad の角度・mirror', async () => {
  const S = await import('../js/output/kicad-sch.js');
  // KiCad 7.0.11 で全種類のピン位置を確かめた対応（反転ありは回転の向きが逆）
  assert.deepEqual(S.kicadOrient({ rot: 90, mirror: false }), { angle: 270, mirror: false });
  assert.deepEqual(S.kicadOrient({ rot: 90, mirror: true }), { angle: 90, mirror: true });
  assert.deepEqual(S.kicadOrient({ rot: 180, mirror: true }), { angle: 180, mirror: true });
  assert.deepEqual(S.kicadOrient({ rot: 0, mirror: false }), { angle: 0, mirror: false });
  // SVG のパス → 折れ線（相対の円弧・2 次曲線・閉じる）
  const polys = S.flattenPath('M-2.4 0 a0.6 0.6 0 0 1 1.2 0 Q0 1 1 0 Z');
  assert.equal(polys.length, 1);
  const last = polys[0].at(-1);
  assert.deepEqual([last.x, last.y], [-2.4, 0], 'Z で始点へ戻る');
  assert.ok(polys[0].some((p) => p.y < -0.5), '円弧は上へふくらむ（sweep=1）');
});

test('名前の無いネット: KiCad と同じ名前（受動以外のピンを優先・文字列順）', async () => {
  const S = await import('../js/output/kicad-sch.js');
  const prj = M.project.createProject('n');
  const sh = prj.schematic.sheets[0];
  const r1 = M.model.addComponent(sh, 'resistor', 20, 10), r2 = M.model.addComponent(sh, 'resistor', 40, 10);
  M.model.addWirePath(sh, [{ x: 24, y: 10 }, { x: 36, y: 10 }]);
  const op = M.model.addComponent(sh, 'opamp', 80, 10);
  const c1 = M.model.addComponent(sh, 'capacitor', 100, 20);
  M.model.addWirePath(sh, [{ x: 86, y: 10 }, { x: 98, y: 10 }, { x: 98, y: 20 }]);
  const built = S.buildSymbols(prj);
  const names = S.kicadNetNames(prj, built);
  const byPad = (ref, pad) => names.byPad.get(`${ref}:${pad}`);
  assert.equal(byPad(r1.ref, '2'), `Net-(${r1.ref}-Pad2)`, 'R1 < R2 の文字列順');
  assert.equal(byPad(c1.ref, '1'), `Net-(${op.ref}-OUT)`, '受動のコンデンサより出力ピン');
  assert.equal(byPad(r1.ref, '1'), `unconnected-(${r1.ref}-Pad1)`);
  assert.equal(byPad(op.ref, '3'), `unconnected-(${op.ref}-+-Pad3)`);
});

test('3D モデル（VRML）: 箱と円柱、単位 0.1 インチ', async () => {
  const { vrmlModel } = await import('../js/output/vrml.js');
  const fp = M.fps.getFootprint('R_0805');
  const w = vrmlModel(fp, '10k');
  assert.match(w, /^#VRML V2\.0 utf8/);
  assert.equal((w.match(/Shape \{/g) || []).length, 3, '本体と両端の電極');
  // 本体の長さ 2mm × 0.7 = 1.4mm → 0.5512 単位（x は ±0.2756）
  assert.match(w, /-0\.27559 /);
  const dip = vrmlModel(M.fps.getFootprint('DIP-8'), '');
  assert.ok((dip.match(/Shape \{/g) || []).length >= 9, '本体＋ピン 8 本');
});
