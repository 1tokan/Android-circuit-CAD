// KiCad 本体で書き出しを確かめる（KiCad 7 以上の pcbnew Python が要る。CI では動かさない）
// 使い方: node tests/tools/kicad-verify.mjs samples/usb-dac-amp.json /tmp/kicad-out
//  → .kicad_pcb などを書き出し、Pocket EDA 側のパッド位置・ネット・数を ref.json に書き、
//    python3 tests/tools/kicad-verify.py で KiCad に読み込ませて照合・ゾーン塗り・DRC（drc.rpt）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { kicadFiles } from '../../js/output/kicad.js';
import { allPads } from '../../js/pcb/model.js';

const [src, out = '/tmp/kicad-out'] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(src, 'utf8'));
const files = kicadFiles(p, { version: 'verify' });
for (const f of files) { fs.mkdirSync(`${out}/${f.name.split('/')[0]}`, { recursive: true }); fs.writeFileSync(`${out}/${f.name}`, f.content); }
const pcb = p.pcb;
const pads = allPads(pcb).map((q) => ({ ref: q.ref, num: q.pad.num, x: q.x, y: q.y, net: q.net || '', layers: q.layers.length > 1 ? 'tht' : q.layers[0] }));
fs.writeFileSync(`${out}/ref.json`, JSON.stringify({ pads, tracks: pcb.tracks.length, vias: pcb.vias.length, zones: pcb.zones.length, holes: pcb.holes.length, fps: pcb.footprints.length }));
const py = new URL('./kicad-verify.py', import.meta.url).pathname;
process.stdout.write(execFileSync('python3', [py, `${out}/${files[0].name}`, `${out}/ref.json`, `${out}/drc.rpt`], { encoding: 'utf8' }));
console.log(`DRC の結果: ${out}/drc.rpt`);
