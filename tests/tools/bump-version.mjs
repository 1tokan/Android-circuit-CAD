// 版を 4 か所そろえて上げる（js/app.js・package.json・sw.js の CACHE・tests/e2e-check.mjs）
// 使い方: node tests/tools/bump-version.mjs 0.13.2   （引数なしなら patch を 1 上げる）
// 出力は 1 行だけ（トークンを使わないため）。どこかが書き換わらなければ失敗で終わる
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, ROOT), 'utf8');
const cur = JSON.parse(read('package.json')).version;
const next = process.argv[2] || cur.replace(/(\d+)$/, (d) => String(Number(d) + 1));
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`版の形が違います: ${next}`);
const esc = (v) => v.replace(/\./g, '\\.');
const edits = [
  ['js/app.js', /const APP_VERSION = '[^']+';/, `const APP_VERSION = '${next}';`],
  ['package.json', /"version": "[^"]+"/, `"version": "${next}"`],
  ['sw.js', /const CACHE = 'pocket-eda-v[^']+';/, `const CACHE = 'pocket-eda-v${next}';`],
  ['tests/e2e-check.mjs', /起動 \d+\\\.\d+\\\.\d+/, `起動 ${esc(next)}`],
];
for (const [f, re, to] of edits) {
  const s = read(f);
  if (!re.test(s)) throw new Error(`${f}: 版の場所が見つかりません`);
  fs.writeFileSync(new URL(f, ROOT), s.replace(re, to));
}
console.log(`版 ${cur} → ${next}（4 か所）`);
