// KiCad 本体で書き出しを確かめる（KiCad 7 以上の kicad-cli と pcbnew の Python が要る。CI では動かさない）
// 使い方: node tests/tools/kicad-verify.mjs samples/usb-dac-amp.json /tmp/kicad-out
//  1) KiCad 一式を書き出す
//  2) kicad-cli で回路図からネットリストを作り、Pocket EDA のネットリストとつながり・部品を照合
//  3) python3 tests/tools/kicad-verify.py: 基板・ライブラリ・3D モデル・回路図との整合・DRC
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { kicadFiles } from '../../js/output/kicad.js';
import { buildSymbols, kicadNetNames } from '../../js/output/kicad-sch.js';
import { allPads } from '../../js/pcb/model.js';

const [src, out = '/tmp/kicad-out'] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.rmSync(out, { recursive: true, force: true });
const files = kicadFiles(p, { version: 'verify' });
for (const f of files) { fs.mkdirSync(`${out}/${f.name.split('/').slice(0, -1).join('/')}`, { recursive: true }); fs.writeFileSync(`${out}/${f.name}`, f.content); }
const dir = `${out}/${files[0].name.split('/')[0]}`;
const pcbFile = `${out}/${files.find((f) => f.name.endsWith('.kicad_pcb')).name}`;
const schFile = `${out}/${files.find((f) => f.name.endsWith('.kicad_sch')).name}`;
// 回路図 → ネットリスト（KiCad）
const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }; // 日本語のファイル名
execFileSync('kicad-cli', ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', `${out}/net.xml`, schFile], { stdio: 'pipe', env });
const xml = fs.readFileSync(`${out}/net.xml`, 'utf8');
// つながり: Pocket EDA のネット（パッド単位）ごとに、KiCad で同じネットにまとまり、余分が無いか
const kNet = new Map();
for (const m of xml.matchAll(/<net code="\d+" name="([^"]*)">([\s\S]*?)<\/net>/g)) {
  const name = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const nd of m[2].matchAll(/<node ref="([^"]*)" pin="([^"]*)"/g)) kNet.set(`${nd[1]}:${nd[2]}`, name);
}
const built = buildSymbols(p);
const names = kicadNetNames(p, built);
let bad = 0;
for (const n of built.nl.nets) {
  const ks = new Set(n.nodes.map((x) => kNet.get(`${x.ref}:${x.pad}`)));
  const want = names.byNet.get(n.name);
  if (ks.size !== 1 || !ks.has(want)) { bad++; console.log('NG net', n.name, [...ks], 'want', want); continue; }
  const members = [...kNet].filter(([, v]) => v === want).length;
  if (members !== n.nodes.length) { bad++; console.log('NG net members', n.name, members, n.nodes.length); }
}
for (const [k, v] of names.byPad) if (kNet.get(k) !== v) { bad++; if (bad < 20) console.log('NG pad name', k, kNet.get(k), v); }
console.log(`schematic nets ${built.nl.nets.length} pads named ${names.byPad.size} mismatches ${bad}`);
// 基板の正解
const pcb = p.pcb;
const pads = allPads(pcb).map((q) => {
  const net = q.net || '';
  return { ref: q.ref, num: q.pad.num, x: q.x, y: q.y, net, knet: net ? names.byNet.get(net) ?? net : '', layers: q.layers.length > 1 ? 'tht' : q.layers[0] };
});
fs.writeFileSync(`${out}/ref.json`, JSON.stringify({ pads, tracks: pcb.tracks.length, vias: pcb.vias.length, zones: pcb.zones.length, holes: pcb.holes.length, fps: pcb.footprints.length }));
const py = new URL('./kicad-verify.py', import.meta.url).pathname;
let r = '';
try { r = execFileSync('python3', [py, pcbFile, `${out}/ref.json`, `${out}/drc.rpt`, `${out}/net.xml`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, maxBuffer: 64 << 20 }); } catch (e) { r = `${e.stdout || ''}python: status ${e.status} signal ${e.signal}\n`; bad++; }
process.stdout.write(r);
const rpt = fs.readFileSync(`${out}/drc.rpt`, 'utf8');
const kinds = {};
for (const m of rpt.matchAll(/^\[(\w+)\]/gm)) kinds[m[1]] = (kinds[m[1]] || 0) + 1;
console.log('KiCad DRC', JSON.stringify(kinds), (rpt.match(/\*\* Found .*/g) || []).join(' / '));
console.log(`出力: ${dir}`);
process.exit(bad ? 1 : 0);
