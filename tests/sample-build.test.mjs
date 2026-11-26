// node --test tests/sample-build.test.mjs … 同梱サンプルが生成プログラムから作り直せること
// samples/usb-dac-amp.json を手で直していない（生成プログラムと食い違っていない）ことを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('samples/build/usb-dac-amp.mjs で作り直すと samples/usb-dac-amp.json と同じ・DRC/ERC エラーなし', () => {
  const script = new URL('../samples/build/usb-dac-amp.mjs', import.meta.url).pathname;
  let out;
  try { out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }); } catch (e) { out = e.stdout; }
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.drc.errors, 0, 'DRC エラー');
  assert.equal(r.drc.unrouted, 0, '未配線');
  assert.equal(r.erc.errors, 0, 'ERC エラー');
  assert.ok(r.same, 'samples/usb-dac-amp.json が生成結果と違う（node samples/build/usb-dac-amp.mjs で作り直す）');
});
