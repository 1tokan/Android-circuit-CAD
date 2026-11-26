// サンプルの配置・配線の値をいくつも試し、1 つの組み合わせを 1 行で表示する（作業の記録を短くするため）
// 使い方:
//   node tests/tools/sample-sweep.mjs '{"seed":[2,5,14],"H":[34,36]}'      … 値の組み合わせをすべて
//   node tests/tools/sample-sweep.mjs '[{"seed":14},{"seed":7,"J3Y":10.5}]' … 並べたものだけ
// 結果の JSON は /tmp/sample-sweep/<番号>.json（よい組み合わせは tests/tools/pcb-inspect.mjs で調べる）。
// 並列の数は CPU の数。値の意味は samples/build/usb-dac-amp.mjs の DEFAULTS
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const arg = JSON.parse(process.argv[2] || '{}');
const sets = Array.isArray(arg) ? arg : Object.entries(arg).reduce((acc, [k, vs]) => acc.flatMap((a) => (Array.isArray(vs) ? vs : [vs]).map((v) => ({ ...a, [k]: v }))), [{}]);
const dir = '/tmp/sample-sweep';
fs.mkdirSync(dir, { recursive: true });
const script = new URL('../../samples/build/usb-dac-amp.mjs', import.meta.url).pathname;

function run(p, i) {
  return new Promise((resolve) => {
    const out = `${dir}/${i}.json`, t0 = Date.now();
    const ch = spawn(process.execPath, [script], { env: { ...process.env, SAMPLE_PARAMS: JSON.stringify(p), SAMPLE_OUT: out }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    ch.stdout.on('data', (d) => { so += d; });
    ch.stderr.on('data', (d) => { se += d; });
    ch.on('close', (code) => {
      let line;
      try {
        const r = JSON.parse(so);
        const rules = Object.entries(r.drc.byRule || {}).filter(([, v]) => v.error || v.warning).map(([k, v]) => `${k}:${v.error || 0}/${v.warning || 0}`).join(' ');
        line = `#${i} ${JSON.stringify(p)} 未配線 ${r.route.failed.length}${r.route.failed.length ? `(${r.route.failed.map((f) => f.net).join(',')})` : ''} DRC E${r.drc.summary.errors}/W${r.drc.summary.warnings}${rules ? ` [${rules}]` : ''} スポーク不足 ${r.thermalFix ? `${r.thermalFix.before}→${r.thermalFix.after}` : '-'} ${Math.round((Date.now() - t0) / 1000)}s`;
      } catch { line = `#${i} ${JSON.stringify(p)} 失敗 code ${code}: ${se.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`; }
      console.log(line);
      resolve(line);
    });
  });
}

const n = Math.max(1, os.cpus().length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(n, sets.length) }, async () => { while (next < sets.length) { const i = next++; await run(sets[i], i); } }));
