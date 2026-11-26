// Claude での回路設計を、品質を落とさずに安く回す段階の進め方
//
//  1. 設計（design）   … 既定 Opus。仕様の決定・部品の選定・回路の変更。指示文（部品一覧つき）はプロンプトキャッシュに置く。
//                        今の回路は 1 回だけ添え、前の回路（JSON）は送り直さない。小さな直しは「差分（patch）」で返させる（出力のトークンが減る）
//  2. 端末の中の検査   … 無料。形式の検査（validateSpec）と、回路図にして ERC。AI を呼ばずに直せるもの（ピンの二重の割り当て・消した部品の残り）は端末で直す
//  3. 修理（repair）   … 既定 Sonnet。検査で出た誤りだけを短い指示文で直させる（差分）。2 回で直らなければ設計のモデルで 1 回
//  4. 会話の要約（compact）… 既定 Haiku。古いやりとりが長くなったら 1 度だけ要約し、以後は要約を送る
//
// どの段階でどのモデルを何トークン使ったかを返す（画面に出す）。

import { callClaude, ClaudeError } from './claude.js';
import { RESPONSE_SCHEMA, PIN_RULES, PART_KINDS, validateSpec, projectFromSpec } from './spec.js';
import { runErc } from '../check/erc.js';

export const MODEL_IDS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

/** 段階ごとのモデルの組み合わせ */
export const PLANS = {
  auto: { label: '自動（設計 Opus・修理 Sonnet・要約 Haiku）推奨', design: MODEL_IDS.opus, repair: MODEL_IDS.sonnet, compact: MODEL_IDS.haiku },
  opus: { label: 'すべて Opus', design: MODEL_IDS.opus, repair: MODEL_IDS.opus, compact: MODEL_IDS.opus },
  sonnet: { label: '設計も Sonnet（安い・標準的な回路）', design: MODEL_IDS.sonnet, repair: MODEL_IDS.sonnet, compact: MODEL_IDS.haiku },
  haiku: { label: '設計も Haiku（いちばん安い・簡単な回路）', design: MODEL_IDS.haiku, repair: MODEL_IDS.sonnet, compact: MODEL_IDS.haiku },
};
/** 以前の設定（モデルの id）を段階の組み合わせに */
export function planOf(setting) {
  if (PLANS[setting]) return { id: setting, ...PLANS[setting] };
  const k = Object.entries(MODEL_IDS).find(([, v]) => v === setting)?.[0];
  return k === 'opus' ? { id: 'opus', ...PLANS.opus } : k === 'haiku' ? { id: 'haiku', ...PLANS.haiku } : k === 'sonnet' ? { id: 'sonnet', ...PLANS.sonnet } : { id: 'auto', ...PLANS.auto };
}

// ---------------- 返答の形（差分つき） ----------------
const C = RESPONSE_SCHEMA.properties.circuit;
const PART = C.properties.parts.items, NET = C.properties.nets.items;
export const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'questions', 'mode', 'circuit', 'patch'],
  properties: {
    reply: RESPONSE_SCHEMA.properties.reply,
    questions: RESPONSE_SCHEMA.properties.questions,
    mode: { type: 'string', enum: ['full', 'patch', 'none'], description: 'full = circuit に回路の全体。patch = 今の回路への差分を patch に（circuit は空）。none = 回路は変えない（質問だけ）' },
    circuit: C,
    patch: {
      type: 'object',
      additionalProperties: false,
      required: ['remove_parts', 'upsert_parts', 'remove_nets', 'upsert_nets', 'nc_add', 'nc_remove', 'requirements', 'notes'],
      properties: {
        remove_parts: { type: 'array', items: { type: 'string' }, description: '消す部品番号' },
        upsert_parts: { type: 'array', items: PART, description: '足す部品・変える部品（部品番号が同じなら置き換え）' },
        remove_nets: { type: 'array', items: { type: 'string' }, description: '消すネット名' },
        upsert_nets: { type: 'array', items: NET, description: '足すネット・変えるネット（名前が同じなら、ピンの一覧ごと置き換え）' },
        nc_add: { type: 'array', items: { type: 'string' } },
        nc_remove: { type: 'array', items: { type: 'string' } },
        requirements: { type: 'array', items: { type: 'string' }, description: '変えたときだけ、要件の全体（変えなければ空）' },
        notes: { type: 'array', items: { type: 'string' }, description: '変えたときだけ、注意書きの全体（変えなければ空）' },
      },
    },
  },
};
const EMPTY_CIRCUIT = { title: '', summary: '', requirements: [], parts: [], nets: [], nc: [], notes: [] };
const EMPTY_PATCH = { remove_parts: [], upsert_parts: [], remove_nets: [], upsert_nets: [], nc_add: [], nc_remove: [], requirements: [], notes: [] };

/**
 * 差分を回路に当てる。端末で直せる食い違いは直し、直したことを fixes に残す
 *  - 消した部品のピンはネット・nc から外す
 *  - 置き換えたネットに入ったピンは、ほかのネットから外す（1 つのピンは 1 つのネット）
 *  - ピンが無くなったネットは消す
 */
export function applyPatch(spec, patch) {
  const c = structuredClone(spec || EMPTY_CIRCUIT);
  const fixes = [];
  const p = { ...EMPTY_PATCH, ...(patch || {}) };
  // 同じ部品番号を消して入れ直した（差し替え）ときは、ピンを外さない
  const gone = new Set(p.remove_parts.filter((r) => !p.upsert_parts.some((x) => x.ref === r)));
  c.parts = c.parts.filter((x) => !gone.has(x.ref));
  for (const np of p.upsert_parts) { const i = c.parts.findIndex((x) => x.ref === np.ref); if (i >= 0) c.parts[i] = np; else c.parts.push(np); }
  const removedNets = new Set(p.remove_nets);
  c.nets = c.nets.filter((n) => !removedNets.has(n.name));
  for (const nn of p.upsert_nets) {
    const pins = new Set(nn.pins);
    for (const n of c.nets) {
      if (n.name === nn.name) continue;
      const before = n.pins.length;
      n.pins = n.pins.filter((s) => !pins.has(s));
      if (n.pins.length !== before) fixes.push(`${n.name} から ${before - n.pins.length} 本のピンを外した（${nn.name} へ移したため）`);
    }
    const i = c.nets.findIndex((x) => x.name === nn.name);
    if (i >= 0) c.nets[i] = nn; else c.nets.push(nn);
  }
  const live = (s) => !gone.has(String(s).split('.')[0]);
  for (const n of c.nets) { const b = n.pins.length; n.pins = n.pins.filter(live); if (b !== n.pins.length) fixes.push(`${n.name} から消した部品のピンを外した`); }
  c.nets = c.nets.filter((n) => n.pins.length);
  c.nc = [...new Set([...(c.nc || []).filter((s) => live(s) && !p.nc_remove.includes(s)), ...p.nc_add])];
  if (p.requirements.length) c.requirements = p.requirements;
  if (p.notes.length) c.notes = p.notes;
  return { circuit: c, fixes };
}

/**
 * 端末の中の検査（無料）: 形式 ＋ 回路図にして ERC のエラー
 * @returns {{ errors, warnings }}
 */
export function localCheck(c) {
  if (!c || typeof c !== 'object') return { errors: ['回路がありません'], warnings: [], format: 1 };
  const v = validateSpec(c);
  if (v.errors.length) return { ...v, format: v.errors.length };
  let erc = [];
  try {
    const { project } = projectFromSpec(c, { now: 0 });
    erc = runErc(project, { now: '' }).issues.filter((i) => i.level === 'error').map((i) => `ERC: ${i.message}`);
  } catch (e) { erc = [`回路図にできません: ${e.message}`]; }
  return { errors: erc, warnings: v.warnings, format: 0 };
}

/** 直しが良くなったか: 形式の誤りの数 → 全体の誤りの数 の順で比べる（形式が直って ERC が見えてきた場合も採る） */
export function improved(next, cur) {
  const nf = next.format ?? 0, cf = cur.format ?? 0;
  return nf !== cf ? nf < cf : next.errors.length < cur.errors.length;
}

// ---------------- 送る内容 ----------------
const roundText = (h) => (h.role === 'user' ? `利用者: ${h.text}` : `設計者: ${h.reply || ''}${h.questions?.length ? `\n（確認: ${h.questions.join(' / ')}）` : ''}`);

/**
 * 会話を 1 つの依頼にまとめる（前の回路の JSON は入れない。今の回路を 1 回だけ）
 * @param history [{ role, text | reply, questions }]
 * @param summary 古い会話の要約 { upTo, text } または null
 */
/** 要約の範囲を履歴の長さで頭打ちに（元に戻すなどで履歴が短くなったとき、直近のやりとりを落とさない） */
const upToOf = (history, summary) => Math.min(summary?.upTo ?? 0, Math.max(0, history.length - 4));

export function buildDesignMessage({ history = [], summary = null, request, currentSpec }) {
  const keepFrom = Math.max(upToOf(history, summary), history.length - 4); // 直近 2 往復はそのまま
  const old = summary?.text ? `## これまでの会話の要約\n${summary.text}\n\n` : '';
  const recent = history.slice(keepFrom).map(roundText).join('\n\n');
  const cur = currentSpec && currentSpec.parts?.length ? `## 今の回路（これを直す。小さな直しは mode = patch で差分だけ返す）\n${JSON.stringify(currentSpec)}\n\n` : '## 今の回路\n（まだ無い。mode = full で全体を返す）\n\n';
  return [{ role: 'user', content: `${old}${recent ? `## 直近のやりとり\n${recent}\n\n` : ''}${cur}## 今回の依頼\n${request}` }];
}

/** 要約が要るか（要約していない古いやりとりの文字数） */
export function needsCompaction(history, summary, limit = 4000) {
  const end = history.length - 4;
  if (end <= upToOf(history, summary)) return false;
  return history.slice(upToOf(history, summary), end).map(roundText).join('\n').length > limit;
}

const COMPACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } };
const COMPACT_SYSTEM = '回路設計の会話を、あとの設計に要る事柄だけ残して日本語で短く要約します。利用者が決めたこと・頼んだこと・断ったこと・未解決の質問を箇条書きで。回路の部品やネットの細部は書かない（回路は別に渡す）。';

export function repairSystem() {
  return `あなたは電子回路設計者です。回路仕様 JSON に、端末の検査で見つかった誤りがあります。誤りだけを直し、設計（部品の選定・回路の考え方）は変えないでください。
返答は mode = patch で、直す部品・ネットだけを patch に入れます（circuit は空、requirements・notes は変えなければ空）。reply には何を直したかを 1〜2 文で。
きまり:
- 部品の種別: ${PART_KINDS.join(', ')}
- ピン番号:
${Object.entries(PIN_RULES).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}
- 1 つのピンを 2 つのネットに入れない。ネットは「部品番号.ピン番号」の一覧。使わないピンは nc。ic と connector は全ピンを pins に書く。`;
}

// ---------------- 進める ----------------
/**
 * 1 回の依頼を、段階に分けて進める
 * @param o { apiKey, plan: planOf(...), system: 設計の指示文, history, summary, request, currentSpec, fetchImpl, signal, onStage(stage, model) }
 * @returns {{ reply, questions, circuit, mode, calls: [{ stage, model, usage }], check, fixes, summary }}
 */
export async function designTurn(o) {
  const plan = o.plan || planOf('auto');
  const calls = [];
  const call = async (stage, model, system, messages, schema, maxTokens) => {
    o.onStage?.(stage, model);
    const r = await callClaude({ apiKey: o.apiKey, model, system, cache: true, messages, schema, maxTokens, fetchImpl: o.fetchImpl, signal: o.signal });
    calls.push({ stage, model, usage: r.usage });
    return r.json;
  };
  // 4. 古い会話の要約（必要なときだけ）
  let summary = o.summary || null;
  if (needsCompaction(o.history || [], summary)) {
    const end = o.history.length - 4;
    const text = [summary?.text ? `（前の要約）\n${summary.text}` : '', ...o.history.slice(upToOf(o.history, summary), end).map(roundText)].filter(Boolean).join('\n\n');
    const j = await call('compact', plan.compact, COMPACT_SYSTEM, [{ role: 'user', content: text }], COMPACT_SCHEMA, 2000);
    summary = { upTo: end, text: String(j.summary || '') };
  }
  // 1. 設計
  const a = await call('design', plan.design, o.system, buildDesignMessage({ history: o.history, summary, request: o.request, currentSpec: o.currentSpec }), DESIGN_SCHEMA, 32000);
  const reply = String(a.reply || ''), questions = Array.isArray(a.questions) ? a.questions : [];
  if (a.mode === 'none' || (a.mode === 'patch' && !o.currentSpec?.parts?.length && !a.patch?.upsert_parts?.length)) {
    return { reply, questions, circuit: o.currentSpec || null, mode: 'none', calls, check: null, fixes: [], summary };
  }
  let { circuit, fixes } = a.mode === 'patch' ? applyPatch(o.currentSpec, a.patch) : { circuit: a.circuit, fixes: [] };
  if (a.mode !== 'patch' && !circuit?.parts?.length) throw new ClaudeError('format', '回路が空でした');
  // 2. 端末の検査 → 3. 修理（Sonnet で 2 回まで、だめなら設計のモデルで 1 回）
  let check = localCheck(circuit);
  const tries = [plan.repair, plan.repair, plan.design];
  let repaired = 0, rejected = '';
  for (const model of tries) {
    if (!check.errors.length) break;
    const msg = `${rejected}## 検査で見つかった誤り（${check.errors.length}）\n${check.errors.slice(0, 30).map((e) => `- ${e}`).join('\n')}\n\n## 回路\n${JSON.stringify(circuit)}`;
    const r = await call('repair', model, repairSystem(), [{ role: 'user', content: msg }], DESIGN_SCHEMA, 16000);
    const next = r.mode === 'full' && r.circuit?.parts?.length ? { circuit: r.circuit, fixes: [] } : applyPatch(circuit, r.patch);
    const nc = localCheck(next.circuit);
    // 誤りが減らなかった直しは採らない
    if (improved(nc, check)) { circuit = next.circuit; fixes = [...fixes, ...next.fixes]; check = nc; repaired++; rejected = ''; }
    else rejected = `## 前回の直しは採らなかった\n誤りが減らなかった（直した後: ${nc.errors.slice(0, 5).join(' / ')}）。別のやり方で直す。\n前回の返答: ${String(r.reply || '').slice(0, 300)}\n\n`;
  }
  return { reply, questions, circuit, mode: a.mode, calls, check, fixes, repaired, summary };
}

/** 呼び出しの記録 → 表示用の文（段階・モデル・入力・キャッシュ・出力のトークン） */
export function usageText(calls) {
  const short = (m) => (m.includes('opus') ? 'Opus' : m.includes('sonnet') ? 'Sonnet' : m.includes('haiku') ? 'Haiku' : m);
  const st = { design: '設計', repair: '修理', compact: '要約' };
  return calls.map((c) => {
    const u = c.usage || {};
    const cache = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) ? `（キャッシュ 読 ${u.cache_read_input_tokens || 0}・書 ${u.cache_creation_input_tokens || 0}）` : '';
    return `${st[c.stage] || c.stage} ${short(c.model)}: 入力 ${u.input_tokens ?? '?'}${cache}・出力 ${u.output_tokens ?? '?'}`;
  }).join(' ／ ');
}
