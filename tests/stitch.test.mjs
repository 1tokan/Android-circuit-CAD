// node --test tests/stitch.test.mjs … GND のつなぎビアと、電源層の分割をまたぐ配線
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModules } from './scenarios.js';

const M = await loadModules(new URL('../', import.meta.url).href);
const { addStitchVias, planeSplitCrossings } = await import('../js/pcb/stitch.js');

test('サンプル: 表と裏の GND ベタがあり、つなぎビアを打っても DRC エラーが増えない', () => {
  const prj = M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
  const pcb = M.pcb.ensurePcb(prj);
  assert.ok(pcb.zones.some((z) => z.layer === 'F.Cu' && z.net === 'GND') && pcb.zones.some((z) => z.layer === 'B.Cu' && z.net === 'GND'));
  assert.ok(pcb.vias.filter((v) => v.stitch).length >= 50, 'サンプルにはつなぎビアが打ってある');
  const rules = M.drc.drcRules(prj);
  const before = M.drc.runDrc(prj, pcb).summary.errors;
  // 分割をまたぐ点を見つける
  const cross = planeSplitCrossings(pcb, rules);
  assert.ok(cross.length > 0 && cross.every((c) => c.from !== c.to));
  // 追加で打つ（格子を細かく）→ エラーは増えない・ビアはどれも GND のベタの中
  const n0 = pcb.vias.length;
  const r = addStitchVias(pcb, rules, { pitchMm: 2 });
  assert.equal(pcb.vias.length, n0 + r.added.length);
  M.zonefill.fillAllZones(pcb, rules);
  assert.equal(M.drc.runDrc(prj, pcb).summary.errors, before);
  // もう一度打っても、ほとんど増えない（同じ格子のマスには打たない。塗り直しで空きが変わった所だけ）
  const r2 = addStitchVias(pcb, rules, { pitchMm: 2 });
  assert.ok(r2.added.length <= Math.max(3, r.added.length * 0.05), String(r2.added.length));
});

test('つなぎビアは他のネットの配線・パッドの近くには打たない', () => {
  const prj = M.project.parseProject(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url), 'utf8'));
  const pcb = M.pcb.ensurePcb(prj);
  const rules = M.drc.drcRules(prj);
  const r = addStitchVias(pcb, rules, { pitchMm: 1.5, dryRun: true });
  for (const p of r.added) {
    for (const t of pcb.tracks) if (t.net !== 'GND') {
      const a = { x: t.a.x / 1e6, y: t.a.y / 1e6 }, b = { x: t.b.x / 1e6, y: t.b.y / 1e6 };
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-12, u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
      assert.ok(Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy) >= t.width / 2e6 + 0.225 + 0.127 - 1e-6);
    }
  }
});
