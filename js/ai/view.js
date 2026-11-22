// 「Claude で回路を作る」画面
// 目的を書く → Claude が仕様（requirements）・部品・ネット・注意点・確認事項を返す → 回路図に作図。
// 呼び出し方: ①利用者の API キーで直接 ②キー無し: claude.ai 用の依頼文をコピーし、返ってきた JSON を貼り付け
import { esc } from '../core/util.js';
import { callClaude, MODELS, ClaudeError } from './claude.js';
import { systemPrompt, userMessage, pasteablePrompt } from './prompt.js';
import { RESPONSE_SCHEMA, validateSpec, exportSpec, extractJson, unwrap } from './spec.js';
import { layerCount } from '../check/rules.js';

/**
 * @param ctx { root, getProject, mutate, applySpec(circuit, mode), ask, toast, getSetting, setSetting, close }
 */
export function createAiView(ctx) {
  const st = { busy: false, abort: null, key: '', model: MODELS[0].id, saveKey: false, loaded: false };

  async function loadSettings() {
    if (st.loaded) return;
    st.key = (await ctx.getSetting('anthropicApiKey', '')) || '';
    st.saveKey = !!st.key;
    st.model = (await ctx.getSetting('anthropicModel', MODELS[0].id)) || MODELS[0].id;
    st.loaded = true;
  }

  const history = () => ctx.getProject().ai?.history || [];
  const latest = () => [...history()].reverse().find((h) => h.role === 'assistant' && h.circuit);

  function circuitCard(h) {
    const c = h.circuit;
    const v = validateSpec(c);
    const parts = c.parts.map((p) => `<tr><td>${esc(p.ref)}</td><td>${esc(p.value)}</td><td>${esc(p.package)}</td><td>${p.lcsc ? esc(p.lcsc) : '<span class="note">—</span>'}</td></tr>`).join('');
    const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    return `<div class="check-card on ai-result">
      <div class="check-card-head"><b>${esc(c.title || '回路')}</b>${v.errors.length ? `<span class="err">要修正 ${v.errors.length}</span>` : '<span class="ok">作図できます</span>'}</div>
      <small>${esc(c.summary || '')}</small>
      ${c.requirements?.length ? `<h4>仕様</h4>${list(c.requirements)}` : ''}
      <h4>部品（${c.parts.length}）・ネット（${c.nets.length}）</h4>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>番号</th><th>値</th><th>パッケージ</th><th>LCSC</th></tr></thead><tbody>${parts}</tbody></table></div>
      ${c.notes?.length ? `<h4>注意点</h4>${list(c.notes)}` : ''}
      ${v.errors.length ? `<ul class="errs">${v.errors.slice(0, 10).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${v.warnings.length ? `<ul class="warns">${v.warnings.slice(0, 10).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      <div class="check-card-actions">
        <button class="btn primary" data-apply="replace" ${v.errors.length ? 'disabled' : ''}>この回路図に作図</button>
        <button class="btn" data-apply="new" ${v.errors.length ? 'disabled' : ''}>新しいプロジェクトに</button>
      </div>
      <p class="note">LCSC 品番の無い部品は、作図後に部品画面の検索で付けてください。AI の回路は必ず ERC とデータシートで確認してください。</p>
    </div>`;
  }

  function render() {
    const p = ctx.getProject();
    if (!p) return;
    const hist = history();
    const msgs = hist.map((h) => (h.role === 'user'
      ? `<div class="ai-msg user">${esc(h.text)}</div>`
      : `<div class="ai-msg assistant">${esc(h.reply || '')}${h.questions?.length ? `<div class="ai-q"><b>確認したいこと</b><ul>${h.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}${h.usage ? `<small class="note">入力 ${h.usage.input_tokens}・出力 ${h.usage.output_tokens} トークン（${esc(h.model || '')}）</small>` : h.pasted ? '<small class="note">claude.ai の返答を貼り付け</small>' : ''}</div>`)).join('');
    const last = latest();
    const hasCircuit = p.schematic.sheets[0].components.length > 0;
    ctx.root.innerHTML = `<div class="ai-wrap">
      <div class="ai-head"><b>Claude で回路を作る</b><button class="icon-btn" data-close aria-label="閉じる">✕</button></div>
      <details class="ai-settings" ${st.key ? '' : 'open'}><summary>${summaryText()}</summary>
        <label class="field"><span>Anthropic API キー</span><input type="password" id="ai-key" autocomplete="off" placeholder="sk-ant-..." value="${esc(st.key)}"></label>
        <label class="opt"><input type="checkbox" id="ai-save" ${st.saveKey ? 'checked' : ''}> この端末に保存する（保存しなければアプリを閉じると消えます）</label>
        <label class="field"><span>モデル</span><select id="ai-model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === st.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
        <p class="note">キーは Anthropic のコンソール（platform.claude.com）で作れます。料金は使った分だけキーの持ち主に請求されます。キーはこの端末からAnthropicへ直接送られ、ほかには送りません。キーが無くても、下の「claude.ai 用にコピー」で Claude のアプリに頼めます。</p>
      </details>
      <div class="ai-log">${msgs || `<p class="note">作りたい回路を書いてください。例:「USB-C から 5V を受けて 3.3V を作り、ESP32-S3 で I2C の温湿度センサーを読む。状態表示の LED を1個」${hasCircuit ? '<br>今の回路図を添えて送るので「この回路に〜を追加して」のような修正も頼めます。' : ''}</p>`}</div>
      ${last ? circuitCard(last) : ''}
      <div class="ai-input">
        <textarea id="ai-text" rows="3" placeholder="目的・条件・追加の指示">${esc(st.draft || '')}</textarea>
        <div class="check-card-actions">
          <button class="btn primary" data-send ${st.busy ? 'disabled' : ''}>${st.busy ? '考え中…' : 'Claude に送る'}</button>
          ${st.busy ? '<button class="btn" data-abort>中止</button>' : ''}
          <button class="btn" data-copy>claude.ai 用にコピー</button>
          <button class="btn" data-paste>返答を貼り付け</button>
          ${hist.length ? '<button class="btn" data-clear>会話を消す</button>' : ''}
        </div>
      </div>
    </div>`;
    bind();
    const log = ctx.root.querySelector('.ai-log');
    log.scrollTop = log.scrollHeight;
  }

  function summaryText() {
    return `接続の設定（${st.key ? `API キー設定済み・${esc(MODELS.find((m) => m.id === st.model)?.label || st.model)}` : 'API キー未設定'}）`;
  }
  function summary() {
    const el = ctx.root.querySelector('.ai-settings summary');
    if (el) el.innerHTML = summaryText();
  }

  function bind() {
    const $ = (s) => ctx.root.querySelector(s);
    $('[data-close]').onclick = () => ctx.close();
    $('#ai-text').oninput = (e) => { st.draft = e.target.value; };
    // 入力のたびに描き直すと、キー入力直後に押した「送る」ボタンが消えてしまうので、見出しだけ更新する
    $('#ai-key').oninput = (e) => { st.key = e.target.value.trim(); summary(); };
    $('#ai-key').onchange = async () => { if (st.saveKey) await ctx.setSetting('anthropicApiKey', st.key); };
    $('#ai-save').onchange = async (e) => { st.saveKey = e.target.checked; await ctx.setSetting('anthropicApiKey', st.saveKey ? st.key : null); };
    $('#ai-model').onchange = async (e) => { st.model = e.target.value; summary(); await ctx.setSetting('anthropicModel', st.model); };
    $('[data-send]').onclick = () => send();
    $('[data-abort]')?.addEventListener('click', () => st.abort?.abort());
    $('[data-copy]').onclick = () => copyPrompt();
    $('[data-paste]').onclick = () => pasteAnswer();
    $('[data-clear]')?.addEventListener('click', () => { ctx.mutate((q) => { q.ai = { ...(q.ai || {}), history: [] }; }, 'ai'); render(); });
    ctx.root.querySelectorAll('[data-apply]').forEach((b) => { b.onclick = () => apply(b.dataset.apply); });
  }

  function currentSpec() {
    const p = ctx.getProject();
    return p.schematic.sheets[0].components.length ? exportSpec(p) : null;
  }

  /** API に送る会話（最初の依頼に今の回路を添え、AI の返答は JSON のまま返す） */
  function apiMessages(text) {
    const msgs = [];
    let first = true;
    for (const h of history()) {
      if (h.role === 'user') { msgs.push({ role: 'user', content: first ? userMessage(h.text, h.context) : h.text }); first = false; }
      else msgs.push({ role: 'assistant', content: JSON.stringify({ reply: h.reply || '', questions: h.questions || [], circuit: h.circuit }) });
    }
    msgs.push({ role: 'user', content: first ? userMessage(text, currentSpec()) : text });
    return msgs;
  }

  async function send() {
    const text = (st.draft || '').trim();
    if (!text) { ctx.toast('依頼を書いてください', true); return; }
    if (!st.key) { ctx.toast('API キーを設定するか、「claude.ai 用にコピー」を使ってください', true); return; }
    const isFirst = !history().length;
    const messages = apiMessages(text);
    ctx.mutate((q) => { q.ai = { ...(q.ai || {}), history: [...(q.ai?.history || []), { role: 'user', text, at: Date.now(), ...(isFirst ? { context: currentSpec() } : {}) }] }; }, 'ai');
    st.draft = '';
    st.busy = true; st.abort = new AbortController();
    render();
    try {
      const r = await callClaude({ apiKey: st.key, model: st.model, system: systemPrompt({ layers: layerCount(ctx.getProject()) }), messages, schema: RESPONSE_SCHEMA, signal: st.abort.signal });
      const a = unwrap(r.json);
      ctx.mutate((q) => { q.ai.history.push({ role: 'assistant', ...a, usage: r.usage, model: st.model, at: Date.now() }); }, 'ai');
    } catch (e) {
      ctx.toast(e instanceof ClaudeError ? e.message : `失敗しました: ${e.message || e}`, true);
      // 失敗した依頼は会話から外し、入力欄に戻す
      ctx.mutate((q) => { q.ai.history.pop(); }, 'ai');
      st.draft = text;
    } finally {
      st.busy = false; st.abort = null;
      render();
    }
  }

  async function copyPrompt() {
    const text = (st.draft || '').trim() || '（ここに作りたい回路を書く）';
    const prompt = history().length
      ? `${pasteablePrompt(history().find((h) => h.role === 'user')?.text || text, latest()?.circuit || currentSpec(), { layers: layerCount(ctx.getProject()) })}\n\n## 追加の指示\n${text}`
      : pasteablePrompt(text, currentSpec(), { layers: layerCount(ctx.getProject()) });
    try { await navigator.clipboard.writeText(prompt); ctx.toast('依頼文をコピーしました。Claude のアプリに貼り付けて送り、返ってきた JSON を「返答を貼り付け」で入れてください'); }
    catch { await ctx.ask('依頼文', `<textarea class="ai-copy" rows="12" readonly>${esc(prompt)}</textarea>`, [{ label: '閉じる', value: '' }]); }
    if ((st.draft || '').trim()) ctx.mutate((q) => { q.ai = { ...(q.ai || {}), history: [...(q.ai?.history || []), { role: 'user', text: st.draft.trim(), at: Date.now(), viaPaste: true }] }; }, 'ai');
    st.draft = '';
    render();
  }

  async function pasteAnswer() {
    const pr = ctx.ask('Claude の返答を貼り付け', '<textarea id="ai-paste" rows="10" placeholder="```json … ``` をそのまま貼り付け"></textarea>', [{ label: 'キャンセル', value: '' }, { label: '読み込む', value: 'ok', cls: 'primary' }]);
    const ta = document.querySelector('#ai-paste');
    const r = await pr;
    if (r !== 'ok') return;
    try {
      const a = unwrap(extractJson(ta.value));
      ctx.mutate((q) => { q.ai = { ...(q.ai || {}), history: [...(q.ai?.history || []), { role: 'assistant', ...a, pasted: true, at: Date.now() }] }; }, 'ai');
      render();
    } catch (e) { ctx.toast(`読み込めません: ${e.message}`, true); }
  }

  async function apply(mode) {
    const c = latest()?.circuit;
    if (!c) return;
    if (mode === 'replace' && ctx.getProject().schematic.sheets[0].components.length) {
      const ok = await ctx.ask('今の回路図を置き換えます', '<p>回路図の部品・配線・ラベルを、この回路に置き換えます（元に戻すで戻せます）。PCB は「ネットリスト再読込」で更新されます。</p>', [{ label: 'キャンセル', value: '' }, { label: '置き換える', value: 'ok', cls: 'primary' }]);
      if (ok !== 'ok') return;
    }
    await ctx.applySpec(c, mode);
  }

  return {
    async open() { await loadSettings(); render(); },
    render,
  };
}
