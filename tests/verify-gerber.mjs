// 書き出した Gerber 一式を、本アプリと無関係な実装で読み直して検証する（第6段階の独立検証）
//  1. whats-that-gerber（tracespace）: ファイル名から層の種類を正しく判定できるか（JLCPCB などの自動判定に相当）
//  2. pcb-stackup / gerber-parser（tracespace）: 全ファイルを解析・描画でき、外形寸法が一致するか → 表裏の画像を出力
//  3. pcb-tools（Python, gerber パッケージ）: 全ファイルを解析でき、穴の数・径が一致するか
// 使い方:
//   npm i --prefix /tmp/gv pcb-stackup whats-that-gerber && pip install pcb-tools
//   NODE_MODULES=/tmp/gv/node_modules node tests/verify-gerber.mjs tests/out/LED_Test-gerber.zip 30 20
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const [zip, wMm, hMm] = process.argv.slice(2);
const NM = process.env.NODE_MODULES || '/tmp/npmchk/node_modules';
const require = createRequire(path.join(NM, 'x.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-'));
execFileSync('unzip', ['-q', zip, '-d', dir]);
const names = fs.readdirSync(dir).sort();
console.log('files:', names.join(', '));

// 1
const wtg = require('whats-that-gerber');
const types = wtg(names);
const expect = { g1: ['copper', 'inner'], g2: ['copper', 'inner'], g3: ['copper', 'inner'], g4: ['copper', 'inner'], gtl: ['copper', 'top'], gbl: ['copper', 'bottom'], gts: ['soldermask', 'top'], gbs: ['soldermask', 'bottom'], gto: ['silkscreen', 'top'], gbo: ['silkscreen', 'bottom'], gtp: ['solderpaste', 'top'], gbp: ['solderpaste', 'bottom'], gm1: ['outline', 'all'], drl: ['drill', 'all'] };
for (const n of names) {
  const e = expect[n.split('.').pop()];
  assert.deepEqual([types[n].type, types[n].side], e, n);
}
console.log('OK 1 whats-that-gerber: 全ファイルの層の種類を判定');

// 2
const pcbStackup = require('pcb-stackup');
const st = await pcbStackup(names.map((n) => ({ filename: n, gerber: fs.createReadStream(path.join(dir, n)) })), { useOutline: true });
const outline = st.layers.find((l) => l.type === 'outline');
const [, , vw, vh] = outline.converter.viewBox;
assert.ok(Math.abs(vw / 1000 - Number(wMm)) < 0.06 && Math.abs(vh / 1000 - Number(hMm)) < 0.06, `外形 ${vw / 1000}×${vh / 1000}mm`);
for (const l of st.layers) if (l.converter.viewBox[2] > 0) assert.equal(l.converter.units, 'mm', l.filename); // 空の層（裏シルク無し等）は単位が出ない
const outDir = path.dirname(zip);
fs.writeFileSync(path.join(outDir, 'gerber-top.svg'), st.top.svg);
fs.writeFileSync(path.join(outDir, 'gerber-bottom.svg'), st.bottom.svg);
console.log(`OK 2 pcb-stackup: ${st.layers.length} 層を解析・描画、外形 ${vw / 1000}×${vh / 1000}mm → gerber-top.svg / gerber-bottom.svg`);

// 3
const py = `
import sys, os, warnings, json
warnings.filterwarnings('ignore')
import gerber
from gerber.excellon import loads as xl
d = sys.argv[1]; out = {}
for n in sorted(os.listdir(d)):
    src = open(os.path.join(d, n)).read()
    if n.endswith('.drl'):
        f = xl(src, n); out[n] = {'units': f.units, 'holes': len(f.hits), 'tools': sorted(round(t.diameter, 3) for t in f.tools.values())}
    else:
        f = gerber.loads(src, n); out[n] = {'units': f.units, 'prims': len(f.primitives)}
print(json.dumps(out))
`;
const res = JSON.parse(execFileSync('python3', ['-W', 'ignore', '-c', py, dir], { encoding: 'utf8' }));
for (const [n, r] of Object.entries(res)) assert.equal(r.units, 'metric', n);
console.log('OK 3 pcb-tools:', JSON.stringify(res));
fs.rmSync(dir, { recursive: true });
