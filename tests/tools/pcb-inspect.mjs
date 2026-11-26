// プロジェクトの基板を短く調べる（作業の記録を短くするため。大きな JSON を直接読まない）
// 使い方:
//   node tests/tools/pcb-inspect.mjs drc   <project.json> [規則の正規表現]   … DRC の結果を 1 行ずつ（既定: エラーと警告）
//   node tests/tools/pcb-inspect.mjs near  <project.json> C14.2 [半径mm]      … パッドの近くの別ネットの配線・ビア・パッド
//   node tests/tools/pcb-inspect.mjs spoke <project.json> C14.2               … サーマルのスポーク（0°・45° の先端が塗れているか）
//   node tests/tools/pcb-inspect.mjs png   <project.json> out.png [ネット,…] [x0,y0,x1,y1] … 配線の絵（指定のネットは黄色。範囲を切り出せる）
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadModules } from '../scenarios.js';

const M = await loadModules(new URL('../../', import.meta.url).href);
const zf = await import('../../js/pcb/zonefill.js');
const [cmd, file, a3, a4, a5] = process.argv.slice(2);
if (!cmd || !file) { console.log('使い方は先頭の注釈を見てください'); process.exit(1); }
const prj = M.project.parseProject(fs.readFileSync(file, 'utf8'));
const pcb = M.pcb.ensurePcb(prj);
const mm = M.pcb.toMm;
const padOf = (tag) => { const [ref, num] = tag.split('.'); const p = M.pcb.allPads(pcb).find((q) => q.ref === ref && q.pad.num === num); if (!p) throw new Error(`${tag} がありません`); return p; };
const segDist = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy); };

if (cmd === 'drc') {
  const r = M.drc.runDrc(prj, pcb);
  const re = new RegExp(a3 || '^(error|warning)');
  console.log(`基板 ${M.pcb.boardSizeText(pcb)}・エラー ${r.summary.errors}・警告 ${r.summary.warnings}・情報 ${r.summary.infos ?? '-'}`);
  for (const i of r.issues) if (re.test(`${i.level}:${i.rule}`)) console.log(`${i.level} ${i.rule} ${i.message}${i.at ? ` @(${i.at.x.toFixed(2)},${i.at.y.toFixed(2)})` : ''}`);
} else if (cmd === 'near') {
  const p = padOf(a3), R = Number(a4 || 1.3);
  console.log(`${a3} ${p.net} @(${p.x.toFixed(2)},${p.y.toFixed(2)}) ${p.pad.w}×${p.pad.h} 回転 ${p.inst.rot}`);
  for (const t of pcb.tracks) { if (t.net === p.net) continue; const d = segDist(p, { x: mm(t.a.x), y: mm(t.a.y) }, { x: mm(t.b.x), y: mm(t.b.y) }) - mm(t.width) / 2; if (d < R) console.log(` 配線 ${t.layer} ${t.net} 幅 ${mm(t.width)} 縁まで ${d.toFixed(2)}`); }
  for (const v of pcb.vias) { if (v.net === p.net) continue; const d = Math.hypot(mm(v.x) - p.x, mm(v.y) - p.y) - mm(v.diameter) / 2; if (d < R) console.log(` ビア ${v.net} 縁まで ${d.toFixed(2)}`); }
  for (const q of M.pcb.allPads(pcb)) if (q !== p && q.net !== p.net && Math.hypot(q.x - p.x, q.y - p.y) < R + 1) console.log(` パッド ${q.ref}.${q.pad.num} ${q.net} 中心まで ${Math.hypot(q.x - p.x, q.y - p.y).toFixed(2)}`);
} else if (cmd === 'spoke') {
  const p = padOf(a3);
  for (const z of pcb.zones.filter((q) => q.net === p.net && p.layers.includes(q.layer))) {
    const r = zf.fillZone(pcb, z, M.drc.drcRules(prj));
    const sc = r.spokeCount.find((s) => s.ref === p.ref && s.pad === p.pad.num);
    console.log(`${z.layer} ${z.net}: 数えた本数 ${sc?.spokes ?? '-'}（向き ${sc?.angle ?? '-'}°）`);
    for (const ang of [0, 45]) console.log(`  ${ang}°: ${zf.spokeGeom(p, r.params, ang).tips.map((t) => (r.polygons.some((poly) => zf.pointInPolyWithHoles(t, poly)) ? '○' : '×')).join('')}`);
  }
} else if (cmd === 'png') {
  const hl = new Set(String(a4 || '').split(',').filter(Boolean));
  const b = M.pcb.boardRect(pcb);
  const [x0, y0, x1, y1] = a5 ? a5.split(',').map(Number) : [b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1];
  const S = 30, o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * S}" height="${(y1 - y0) * S}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}"><rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="#103010"/>`];
  for (const h of M.pcb.boardHoles(pcb)) o.push(`<circle cx="${mm(h.x)}" cy="${mm(h.y)}" r="${(h.keepout ? mm(h.keepout) : mm(h.drill)) / 2}" fill="none" stroke="#fff" stroke-width="0.05"/><circle cx="${mm(h.x)}" cy="${mm(h.y)}" r="${mm(h.drill) / 2}" fill="#000"/>`);
  for (const t of pcb.tracks) o.push(`<line x1="${mm(t.a.x)}" y1="${mm(t.a.y)}" x2="${mm(t.b.x)}" y2="${mm(t.b.y)}" stroke="${hl.has(t.net) ? '#ff0' : t.layer === 'F.Cu' ? '#c33' : '#36c'}" stroke-opacity="0.8" stroke-width="${mm(t.width)}" stroke-linecap="round"/>`);
  for (const p of M.pcb.allPads(pcb)) { const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => M.pcb.fpToBoard(p.inst, p.pad.x + (sx * p.pad.w) / 2, p.pad.y + (sy * p.pad.h) / 2)); o.push(`<polygon points="${c.map((q) => `${q.x},${q.y}`).join(' ')}" fill="${hl.has(p.net) ? '#ff0' : p.net === 'GND' ? '#999' : '#c90'}"/>`); }
  for (const v of pcb.vias) o.push(`<circle cx="${mm(v.x)}" cy="${mm(v.y)}" r="${mm(v.diameter) / 2}" fill="${hl.has(v.net) ? '#ff0' : '#ddd'}"/>`);
  for (const f of pcb.footprints) { const c = M.pcb.fpBox(f); o.push(`<text x="${(c.x0 + c.x1) / 2}" y="${(c.y0 + c.y1) / 2}" font-size="0.6" fill="#fff" text-anchor="middle">${f.ref}</text>`); }
  o.push('</svg>');
  const svg = o.join('');
  let sharp = null;
  for (const base of [process.cwd() + '/', '/opt/npm-tools/']) { try { sharp = createRequire(base)('sharp'); break; } catch { /* 次へ */ } }
  if (sharp) await sharp(Buffer.from(svg)).png().toFile(a3);
  else fs.writeFileSync(a3.replace(/\.png$/, '.svg'), svg);
  console.log(sharp ? a3 : a3.replace(/\.png$/, '.svg'));
} else { console.log(`知らない命令: ${cmd}`); process.exit(1); }
