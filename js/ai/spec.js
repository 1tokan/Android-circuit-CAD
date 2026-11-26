// 回路仕様（AI と回路図の間でやり取りする JSON）
//
// {
//   title, summary,
//   requirements: ["電源 5V（USB）", ...],                       … 仕様として決めたこと
//   parts: [{ ref, kind, value, package, lcsc, mpn, description, pins: [{ num, name, type }] }],
//   nets:  [{ name, pins: ["R1.1", "U1.3", ...] }],             … 「部品番号.ピン番号」
//   nc:    ["U1.5", ...],                                         … わざと何もつながないピン
//   notes: ["...", ...]                                           … 注意点・確認事項
// }
// ピン番号は回路図シンボルの番号（固定シンボルは下の PIN_RULES、IC・コネクタは pins で定義し、パッド番号と同じ）。

import { createProject } from '../core/project.js';
import { addComponent, addLabel } from '../schematic/model.js';
import { pinPositions, computeConnectivity, cmpRef } from '../schematic/connectivity.js';
import { getSymbol, kindInfo, KINDS } from '../schematic/symbols.js';
import { normalizePart, guessFootprint, partFootprint, partSymbol, icPinCount, BUILTIN_PARTS, normalizeLcsc } from '../library/parts.js';

export const SPEC_FORMAT = 'pocket-eda-circuit';
export const PART_KINDS = KINDS.filter((k) => !k.power).map((k) => k.kind);
const PIN_TYPES = ['passive', 'input', 'output', 'bidirectional', 'power_in', 'power_out', 'open_collector', 'nc'];

/** 固定シンボルのピン番号（AI への説明と検証に使う） */
export const PIN_RULES = {
  resistor: '1, 2', capacitor: '1, 2', inductor: '1, 2', electrolytic: '1=+, 2=-',
  diode: '1=K(カソード), 2=A(アノード)', led: '1=K(カソード), 2=A(アノード)', zener: '1=K, 2=A',
  npn: '1=B, 2=E, 3=C（SOT-23 の一般的な配置）', pnp: '1=B, 2=E, 3=C', nmos: '1=G, 2=S, 3=D（SOT-23）', pmos: '1=G, 2=S, 3=D',
  opamp: '1=OUT, 2=IN-, 3=IN+, 4=V-, 8=V+（SOIC-8 のデュアル品の A ユニット。B ユニット 5,6,7 は使わない）',
  pot: '1, 3=両端, 2=ワイパ', switch: '1, 2', battery: '1=+, 2=-',
  ic: 'pins で 1〜N を定義（N はパッド数。露出パッドも番号を付ける）', connector: 'pins で 1〜N を定義',
  schottky: '1=K, 2=A', tvs: '1=A1, 2=A2（双方向）', bridge: '1=~, 2=~（交流）, 3=+, 4=-',
  regulator: '1=GND, 2=VO(出力), 3=VI(入力)（AMS1117 の SOT-223 と同じ。78xx は部品データのピン対応で変える）',
  transformer: '1・2=1 次, 4・3=2 次（点は 1 と 4。値は「100V:12V」のような巻数比）', fuse: '1, 2', ferrite: '1, 2', thermistor: '1, 2',
  crystal: '1・3=水晶, 2・4=ケース（GND）', relay: '1=COM, 2・5=コイル, 3=NO, 4=NC', optocoupler: '1=A, 2=K（LED）, 3=E, 4=C（受光トランジスタ）',
  buzzer: '1=+, 2=-', speaker: '1=+, 2=-', testpoint: '1',
  vac: '1=+, 2=-（シミュレーション用・基板に載らない。値は SPICE の書き方 例: SIN(0 141 50) AC 1）', vdc: '1=+, 2=-（シミュレーション用。値 例: DC 5）', isrc: '1→2 の向きに部品の中を流れる（シミュレーション用。値 例: DC 1m）',
};

/** 構造化出力（Claude API の output_config.format）の JSON Schema */
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'questions', 'circuit'],
  properties: {
    reply: { type: 'string', description: '利用者への日本語の説明（決めた仕様・選んだ部品の理由・前回からの変更点）' },
    questions: { type: 'array', items: { type: 'string' }, description: '仕様を決めるために利用者に確認したいこと（無ければ空）' },
    circuit: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary', 'requirements', 'parts', 'nets', 'nc', 'notes'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        requirements: { type: 'array', items: { type: 'string' } },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'kind', 'value', 'package', 'lcsc', 'mpn', 'description', 'pins'],
            properties: {
              ref: { type: 'string', description: '部品番号（R1, C1, U1, J1 …）' },
              kind: { type: 'string', enum: PART_KINDS },
              value: { type: 'string' },
              package: { type: 'string', description: 'LCSC/JLCPCB のパッケージ名（0805, SOT-23, SOIC-8, QFN-32-EP(5x5) …）' },
              lcsc: { type: 'string', description: '確信がある場合だけ LCSC 品番（C から始まる）。不明なら空文字' },
              mpn: { type: 'string' },
              description: { type: 'string' },
              pins: {
                type: 'array',
                description: 'ic と connector は全ピンを 1 から順に。ほかの種別は空配列',
                items: {
                  type: 'object', additionalProperties: false, required: ['num', 'name', 'type'],
                  properties: { num: { type: 'string' }, name: { type: 'string' }, type: { type: 'string', enum: PIN_TYPES } },
                },
              },
            },
          },
        },
        nets: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'pins'],
            properties: { name: { type: 'string', description: '電源は GND, +3V3, +5V, VBUS など。信号は意味のある名前' }, pins: { type: 'array', items: { type: 'string' } } },
          },
        },
        nc: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

export const isPowerNet = (n) => /^(GND|AGND|DGND|PGND|VBUS|VCC|VDD|VIN|VBAT|VSS)$|^\+\d/.test(String(n).trim());

/** 文字列（AI の返答・貼り付け）から JSON を取り出す */
export function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* 続けて探す */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* 続けて探す */ } }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('JSON が見つかりません');
}

/** 返答（{reply, questions, circuit}）でも回路仕様だけでも受け取れるようにする */
export function unwrap(obj) {
  if (obj && obj.circuit) return { reply: String(obj.reply || ''), questions: Array.isArray(obj.questions) ? obj.questions : [], circuit: obj.circuit };
  if (obj && Array.isArray(obj.parts)) return { reply: '', questions: [], circuit: obj };
  throw new Error('回路仕様（parts と nets）がありません');
}

/** 固定シンボルのピン番号の一覧 */
function symbolPins(p) {
  if (p._part) return partSymbol(p._part).pins.map((q) => q.num); // 部品データを直接渡したとき
  if (p.kind === 'ic' || p.kind === 'connector') return (p.pins || []).map((q) => String(q.num));
  return getSymbol({ kind: p.kind, props: {} }).pins.map((q) => q.num);
}

/**
 * 検証
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateSpec(c) {
  const errors = [], warnings = [];
  if (!c || !Array.isArray(c.parts) || !Array.isArray(c.nets)) return { errors: ['parts と nets が必要です'], warnings };
  const refs = new Map();
  for (const p of c.parts) {
    if (!/^[A-Z]+\d+$/.test(String(p.ref))) errors.push(`部品番号「${p.ref}」は英大文字＋数字にしてください`);
    if (refs.has(p.ref)) errors.push(`部品番号 ${p.ref} が重複しています`);
    if (!PART_KINDS.includes(p.kind)) errors.push(`${p.ref}: 種別「${p.kind}」は使えません`);
    else if ((p.kind === 'ic' || p.kind === 'connector') && !p._part && !(p.pins || []).length) errors.push(`${p.ref}: ${p.kind} はピンの一覧が必要です`);
    if (p.lcsc && !/^C\d{2,9}$/.test(normalizeLcsc(p.lcsc))) warnings.push(`${p.ref}: LCSC品番「${p.lcsc}」の形式が不正なので使いません`);
    refs.set(p.ref, p);
  }
  const used = new Map();
  for (const n of c.nets) {
    if (!String(n.name || '').trim()) errors.push('名前の無いネットがあります');
    if ((n.pins || []).length < 2 && !isPowerNet(n.name)) warnings.push(`ネット ${n.name} はピンが ${(n.pins || []).length} 個です`);
    for (const s of n.pins || []) {
      const [ref, num] = String(s).split('.');
      const p = refs.get(ref);
      if (!p) { errors.push(`ネット ${n.name}: 部品 ${ref} がありません（${s}）`); continue; }
      if (PART_KINDS.includes(p.kind) && !symbolPins(p).includes(num)) errors.push(`ネット ${n.name}: ${ref} にピン ${num} はありません（${PIN_RULES[p.kind] || ''}）`);
      if (used.has(s) && used.get(s) !== n.name) errors.push(`${s} が ${used.get(s)} と ${n.name} の両方につながっています`);
      used.set(s, n.name);
    }
  }
  for (const s of c.nc || []) if (used.has(s)) warnings.push(`${s} は未接続（nc）指定ですが ${used.get(s)} につながっています`);
  return { errors, warnings };
}

/**
 * 部品データを用意する（LCSC 品番・値＋パッケージが一致する既存の部品があれば使う）
 * @param library [part] 探す対象（プロジェクト・端末のライブラリ・内蔵）
 */
function resolvePart(sp, library) {
  if (sp._part) return { part: sp._part, reused: true };
  const lcsc = normalizeLcsc(sp.lcsc || '');
  const validLcsc = /^C\d{2,9}$/.test(lcsc) ? lcsc : '';
  const hit = (validLcsc && library.find((p) => p.lcsc === validLcsc && p.kind === sp.kind))
    || (sp.kind !== 'ic' && sp.kind !== 'connector' && library.find((p) => p.kind === sp.kind && p.value === sp.value && String(p.package).toUpperCase() === String(sp.package).toUpperCase()));
  if (hit) return { part: hit, reused: true };
  const fp = guessFootprint(sp.kind, sp.package);
  const raw = {
    name: `${sp.value || sp.mpn || sp.kind} ${sp.package || ''}`.trim(),
    kind: sp.kind, value: sp.value, package: sp.package, mpn: sp.mpn, lcsc: validLcsc, description: sp.description,
    footprint: fp, source: 'ai',
  };
  if (sp.kind === 'ic' || sp.kind === 'connector') {
    const pins = [...sp.pins].sort((a, b) => Number(a.num) - Number(b.num));
    const n = Math.max(pins.length, fp ? icPinCount(fp, sp.package) : 0);
    raw.symbol = { kind: sp.kind, pinCount: n, pinNames: Array.from({ length: n }, (_, i) => pins.find((p) => Number(p.num) === i + 1)?.name || '').join(',') };
  }
  return { part: normalizePart(raw), reused: false };
}

/**
 * 回路仕様を回路図にする（シートを置き換える）
 * 配置: 部品を外形の大きさに合わせて左上から並べ、各ピンの先端にネットラベル（電源・GND は電源記号）を置いて接続する。
 * @returns {{ placed, newParts, reusedParts, warnings }}
 */
export function applySpec(project, c, { library = [], now = Date.now() } = {}) {
  const v = validateSpec(c);
  if (v.errors.length) { const e = new Error(v.errors.slice(0, 8).join('\n')); e.errors = v.errors; throw e; }
  const sheet = project.schematic.sheets[0];
  sheet.components = []; sheet.wires = []; sheet.labels = []; sheet.junctions = [];
  const lib = [...(project.library?.parts || []), ...library, ...BUILTIN_PARTS];
  const byRef = new Map();
  const newParts = [], reusedParts = [];
  // 棚詰め（1 グリッド = 1.27mm）
  const MAXW = 140, GAP = 10;
  let x = 0, y = 0, rowH = 0;
  const ordered = [...c.parts].sort((a, b) => order(a) - order(b) || cmpRef(a.ref, b.ref));
  for (const sp of ordered) {
    const { part, reused } = resolvePart(sp, lib);
    if (!project.library.parts.some((p) => p.id === part.id)) project.library.parts.push(part);
    (reused ? reusedParts : newParts).push(sp.ref);
    const props = {
      partId: part.id, value: sp.value || part.value, footprint: partFootprint(part)?.id || part.footprint || '',
      lcsc: part.lcsc || '', mpn: part.mpn || sp.mpn || '',
      ...(part.symbol?.pinCount ? { pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames || '' } : {}),
    };
    const sym = getSymbol({ kind: part.kind, props });
    const w = sym.bbox.x1 - sym.bbox.x0 + 2 * GAP, h = sym.bbox.y1 - sym.bbox.y0 + 2 * GAP;
    if (x + w > MAXW && x > 0) { x = 0; y += rowH; rowH = 0; }
    const comp = addComponent(sheet, part.kind, Math.round(x - sym.bbox.x0 + GAP), Math.round(y - sym.bbox.y0 + GAP), props);
    comp.ref = sp.ref;
    byRef.set(sp.ref, comp);
    x += w; rowH = Math.max(rowH, h);
  }
  const pins = pinPositions(sheet);
  const pinOf = (s) => { const [ref, num] = s.split('.'); const comp = byRef.get(ref); return pins.find((p) => p.compId === comp?.id && p.pin === num); };
  for (const n of c.nets) {
    const name = String(n.name).trim();
    for (const s of n.pins) {
      const p = pinOf(s);
      if (!p) continue;
      if (isPowerNet(name)) addComponent(sheet, /GND|VSS/.test(name) ? 'gnd' : 'power', p.x, p.y, { net: name });
      else addLabel(sheet, p.x, p.y, name);
    }
  }
  // 未接続（nc）指定は部品データの「未使用ピン」に反映
  for (const s of c.nc || []) {
    const [ref, num] = s.split('.');
    const comp = byRef.get(ref);
    const part = comp && project.library.parts.find((p) => p.id === comp.props.partId);
    if (part && (part.kind === 'ic' || part.kind === 'connector') && part.source === 'ai') {
      part.pinMap = part.pinMap || Object.fromEntries(getSymbol(comp).pins.map((q) => [q.num, [q.num]]));
      part.pinMap[num] = [];
    }
  }
  project.ai = { ...(project.ai || {}), spec: c, appliedAt: now };
  return { placed: byRef.size, newParts, reusedParts, warnings: v.warnings };
}

// 並び順: コネクタ → 電源（IC 以外の能動）→ IC → 受動部品
function order(p) { return { connector: 0, battery: 0, ic: 1, opamp: 1, npn: 2, pnp: 2, nmos: 2, pmos: 2, switch: 3, led: 4, diode: 4, zener: 4 }[p.kind] ?? 5; }

/** 今の回路図を回路仕様にする（AI に修正を頼むとき） */
export function exportSpec(project) {
  const sheet = project.schematic.sheets[0];
  const partsById = new Map((project.library?.parts || []).map((p) => [p.id, p]));
  const comps = sheet.components.filter((c) => !kindInfo(c.kind)?.power).sort((a, b) => cmpRef(a.ref, b.ref));
  const conn = computeConnectivity(sheet);
  const parts = comps.map((c) => {
    const part = partsById.get(c.props?.partId);
    const sym = getSymbol(c);
    return {
      ref: c.ref, kind: c.kind, value: String(c.props?.value ?? ''), package: part?.package || c.props?.footprint || '',
      lcsc: part?.lcsc || c.props?.lcsc || '', mpn: part?.mpn || c.props?.mpn || '', description: part?.description || '',
      pins: c.kind === 'ic' || c.kind === 'connector' ? sym.pins.map((p) => ({ num: p.num, name: p.name || '', type: p.type })) : [],
    };
  });
  const nets = conn.nets.filter((n) => n.pins.length >= 2 || n.named).map((n) => ({ name: n.name, pins: n.pins.map((p) => `${p.ref}.${p.pin}`) }));
  const nc = [];
  for (const c of comps) {
    const part = partsById.get(c.props?.partId);
    for (const [num, pads] of Object.entries(part?.pinMap || {})) if (!pads.length) nc.push(`${c.ref}.${num}`);
  }
  const prev = project.ai?.spec;
  return { title: prev?.title || project.name, summary: prev?.summary || '', requirements: prev?.requirements || [], parts, nets, nc, notes: prev?.notes || [] };
}

/** 回路仕様から新しいプロジェクトを作る */
export function projectFromSpec(c, opt = {}) {
  const prj = createProject(c.title || 'AI 回路');
  const report = applySpec(prj, c, opt);
  return { project: prj, report };
}
