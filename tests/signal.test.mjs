// node --test tests/signal.test.mjs … 信号経路の審査（USB・I2S・アナログ音声）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSignals, pinRole, parseValue, railVoltage } from '../js/check/signal.js';

const sample = () => JSON.parse(fs.readFileSync(new URL('../samples/usb-dac-amp.json', import.meta.url)));
const comp = (p, ref) => p.netlist.components.find((c) => c.ref === ref);
const pin = (p, ref, name) => comp(p, ref).pins.find((q) => q.name === name);
const has = (r, level, rule, re) => r.issues.some((i) => i.level === level && i.rule === rule && (!re || re.test(i.message)));

test('値とネット名の読み取り', () => {
  assert.equal(parseValue('470'), 470);
  assert.equal(parseValue('5.1k'), 5100);
  assert.ok(Math.abs(parseValue('2.2n') - 2.2e-9) < 1e-18);
  assert.equal(parseValue('4k7'), 4700);
  assert.equal(railVoltage('+5V_SPK'), 5);
  assert.equal(railVoltage('+3V3A'), 3.3);
  assert.equal(railVoltage('VBUS'), 5);
});

test('ピン名から役割', () => {
  const ic = { kind: 'ic' }, j = { kind: 'connector' };
  assert.deepEqual(pinRole(ic, { name: 'GPIO20/USB_D+' }), { sig: 'usb', pol: '+' });
  assert.deepEqual(pinRole(j, { name: 'D-' }), { sig: 'usb', pol: '-' });
  assert.equal(pinRole(ic, { name: 'BCK' }).role, 'bclk');
  assert.equal(pinRole(ic, { name: 'LRCLK' }).role, 'lrck');
  assert.equal(pinRole(ic, { name: 'DIN' }).role, 'din');
  assert.equal(pinRole(ic, { name: 'OUTR' }).ch, 'R');
  assert.deepEqual(pinRole(ic, { name: 'INL-' }), { sig: 'ain', ch: 'L', inv: true, noninv: false });
  assert.equal(pinRole(j, { name: 'T(L)' }).ch, 'L');
  assert.equal(pinRole(j, { name: 'R(R)' }).ch, 'R');
  assert.equal(pinRole(ic, { name: 'OUTP' }).diff, 'P');
});

test('サンプル: すべての経路がつながり、エラーなし（USB → U4 → I2S 3 組 → DAC・左右のアンプ → ジャック・スピーカー端子）', () => {
  const p = sample();
  const r = runSignals(p, p.pcb);
  assert.equal(r.summary.errors, 0, r.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  const titles = r.chains.map((c) => c.title);
  assert.ok(titles.some((t) => /^USB: J1 → U4/.test(t)));
  assert.equal(r.chains.filter((c) => c.kind === 'i2s').length, 3);
  assert.ok(titles.some((t) => /アナログ（左）: U5 → J2\.T\(L\)/.test(t)) && titles.some((t) => /アナログ（右）: U5 → J2\.R\(R\)/.test(t)));
  assert.ok(titles.some((t) => /スピーカー（左）: U7 → J3/.test(t)) && titles.some((t) => /スピーカー（右）: U8 → J4/.test(t)));
  assert.ok(has(r, 'info', 'i2s_channel', /U8: .*1\.02V → 右/));
  assert.ok(has(r, 'info', 'audio_filter', /ローパス: 153\.9kHz/));
  assert.ok(has(r, 'info', 'audio_filter', /ハイパス: 5\.9Hz/));
  assert.ok(has(r, 'info', 'i2s_fanout'), 'I2S を 3 組のピンに出すことはファームウェアの確認事項');
  // 見つけた問題: ヘッドホンの出力がフルスケールで最大出力の 9 割を超える
  assert.ok(has(r, 'warning', 'audio_level', /1\.05Vrms/));
});

test('取り違えを見つける: USB の D+/D−、ヘッドホンの左右、スピーカーアンプの左右、ミュート、CC', () => {
  let p = sample();
  pin(p, 'U4', 'GPIO20/USB_D+').net = 'USB_DN'; pin(p, 'U4', 'GPIO19/USB_D-').net = 'USB_DP';
  assert.ok(has(runSignals(p), 'error', 'usb_swap'));

  p = sample();
  pin(p, 'J2', 'T(L)').net = 'HP_R'; pin(p, 'J2', 'R(R)').net = 'HP_L';
  assert.ok(has(runSignals(p), 'error', 'audio_lr', /チップ = 左/));

  p = sample();
  comp(p, 'R11').value = '10k'; // SD_MODE = 4.5V → 左になり、左右とも左
  let r = runSignals(p);
  assert.ok(has(r, 'error', 'audio_lr', /U8 は 左/));
  assert.ok(has(r, 'warning', 'i2s_channel', /左と右がそろっていない/));

  p = sample();
  pin(p, 'U5', 'XSMT').net = 'GND';
  assert.ok(has(runSignals(p), 'error', 'i2s_strap', /常にミュート/));

  p = sample();
  for (const c of p.netlist.components) if (c.kind === 'resistor' && c.pins.some((q) => q.net === 'CC1')) c.pins.find((q) => q.net === 'CC1').net = 'X_CC1_OPEN';
  assert.ok(has(runSignals(p), 'error', 'usb_cc', /5\.1kΩ（Rd）がありません/));

  p = sample();
  pin(p, 'U7', 'LRCLK').net = 'AMPL_BCLK'; // LRCK と BCLK を取り違え
  assert.ok(has(runSignals(p), 'error', 'i2s_driver') || has(runSignals(p), 'error', 'i2s_role'));

  p = sample();
  comp(p, 'C26').value = '0.1u'; // 直流カットが小さすぎて低音が落ちる
  assert.ok(has(runSignals(p), 'warning', 'audio_filter', /ハイパス: 5\d\.\dHz（20Hz より高く/));
});
