// Claude API（Messages API）の呼び出し。利用者自身の API キーを使う（サーバーは置かない）。
// ブラウザから直接呼ぶため anthropic-dangerous-direct-browser-access ヘッダーが必要。
// 返答は構造化出力（output_config.format = json_schema）で JSON に固定する。
// 参考: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（標準・速い）' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（高性能）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（安い・簡単な回路向け）' },
];
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';

export class ClaudeError extends Error {
  constructor(kind, message) { super(message); this.name = 'ClaudeError'; this.kind = kind; }
}

/**
 * @param o { apiKey, model, system, messages:[{role, content}], schema, maxTokens, fetchImpl, signal }
 * @returns {{ json, usage, stopReason }}
 */
export async function callClaude({ apiKey, model, system, messages, schema, maxTokens = 32000, fetchImpl = (...a) => fetch(...a), signal }) {
  if (!apiKey) throw new ClaudeError('key', 'API キーがありません');
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages,
        output_config: { format: { type: 'json_schema', schema } },
      }),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ClaudeError('abort', '中止しました');
    throw new ClaudeError('network', '接続できません（オフライン、または通信が遮られています）');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 下で扱う */ }
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const kind = res.status === 401 ? 'auth' : res.status === 429 ? 'rate' : res.status === 529 || res.status >= 500 ? 'server' : 'request';
    const hint = { auth: 'API キーが正しくありません', rate: '呼び出しが多すぎるか、利用上限に達しました', server: 'Anthropic 側が混み合っています。少し待って再試行してください', request: 'リクエストが受け付けられませんでした' }[kind];
    throw new ClaudeError(kind, `${hint}（${msg}）`);
  }
  if (body?.stop_reason === 'refusal') throw new ClaudeError('refusal', 'Claude がこの依頼には答えられませんでした');
  if (body?.stop_reason === 'max_tokens') throw new ClaudeError('length', '返答が長すぎて途中で切れました。回路を分けて依頼してください');
  const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json;
  try { json = JSON.parse(text); } catch { throw new ClaudeError('format', '返答が JSON ではありませんでした'); }
  return { json, usage: body.usage || null, stopReason: body.stop_reason };
}
