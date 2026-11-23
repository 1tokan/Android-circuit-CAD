// 操作ログ（不具合の報告・再現用）
//
// 端末の中だけに残す（送信しない）。新しい順に最大 MAX 件。メニュー「ログ」で見る・書き出す。
//   kind: 'app'（起動・画面）| 'open'（プロジェクトを開く）| 'op'（編集。元に戻すの単位）| 'undo' | 'check'（検査の結果）
//         | 'io'（書き出し）| 'error'（例外・console.error）
// 編集のたびに、そのときの部品・配線・ビア・ベタの数を一緒に残す（どの操作で形が変わったかを追えるように）。

export const LOG_KEY = 'pocketeda.log.v1';
export const MAX = 600;
let buf = null;
let saveTimer = null;
let storage = null;

function store() {
  if (storage !== null) return storage;
  try { storage = globalThis.localStorage || false; } catch { storage = false; }
  return storage;
}
function load() {
  if (buf) return buf;
  buf = [];
  const s = store();
  if (s) { try { const a = JSON.parse(s.getItem(LOG_KEY) || '[]'); if (Array.isArray(a)) buf = a.slice(-MAX); } catch { buf = []; } }
  return buf;
}
function persist() {
  const s = store();
  if (!s) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { s.setItem(LOG_KEY, JSON.stringify(buf)); } catch {
      // 容量が足りないときは古い半分を捨てて保存し直す
      buf = buf.slice(-Math.floor(MAX / 2));
      try { s.setItem(LOG_KEY, JSON.stringify(buf)); } catch { /* 諦める */ }
    }
  }, 300);
}
/** すぐ保存（エラーの直後・書き出しの前） */
export function flushLog() {
  const s = store();
  clearTimeout(saveTimer);
  if (s) { try { s.setItem(LOG_KEY, JSON.stringify(load())); } catch { /* 無視 */ } }
}

/** 1 件追加。同じ種類・同じ文が 1 秒以内に続くときは回数だけ増やす（ドラッグなどで埋まらないように） */
export function log(kind, message, data) {
  const b = load();
  const now = Date.now();
  const last = b[b.length - 1];
  if (last && last.k === kind && last.m === message && now - last.t < 1000 && !data?.error) {
    last.n = (last.n || 1) + 1; last.t = now; if (data) last.d = data;
  } else {
    const e = { t: now, k: kind, m: String(message).slice(0, 500) };
    if (data !== undefined) e.d = data;
    b.push(e);
    if (b.length > MAX) b.splice(0, b.length - MAX);
  }
  if (kind === 'error') flushLog(); else persist();
}

/** 例外を残す（場所・メッセージ・スタックの先頭） */
export function logError(err, where = '') {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  log('error', `${where ? where + ': ' : ''}${e.message}`, { error: true, stack: String(e.stack || '').split('\n').slice(0, 6).join('\n') });
}

export function getLog() { return load().slice(); }
export function clearLog() { buf = []; flushLog(); }

/** プロジェクトの形の要約（編集のたびに残す） */
export function projectSummary(p) {
  if (!p) return null;
  const pcb = p.pcb || {};
  const comps = (p.schematic?.sheets || []).reduce((s, sh) => s + (sh.components?.length || 0), 0);
  return {
    id: p.id, rev: p.revision,
    sch: comps, fp: pcb.footprints?.length || 0, tr: pcb.tracks?.length || 0, via: pcb.vias?.length || 0, zone: pcb.zones?.length || 0,
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const brief = (d) => {
  if (!d) return '';
  if (d.error) return d.stack ? `\n      ${d.stack.replace(/\n/g, '\n      ')}` : '';
  let out = '';
  if (d.fp != null) out += `  [部品${d.fp}・配線${d.tr}・ビア${d.via}・ベタ${d.zone}・rev${d.rev}]`;
  if (d.errors && Object.keys(d.errors).length) out += `\n      エラーの種類: ${Object.entries(d.errors).map(([k, v]) => `${k}×${v}`).join(' ')}`;
  if (d.first?.length) out += d.first.map((m) => `\n      - ${m}`).join('');
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !['id', 'rev', 'sch', 'fp', 'tr', 'via', 'zone', 'errors', 'first'].includes(k)));
  if (Object.keys(rest).length) out += '  ' + JSON.stringify(rest).slice(0, 300);
  return out;
};

/** 文字にする（新しいものが下） */
export function formatLog(entries = getLog(), header = {}) {
  const head = Object.entries(header).map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = entries.map((e) => `${fmt(e.t)} ${e.k.padEnd(5)} ${e.m}${e.n > 1 ? ` ×${e.n}` : ''}${brief(e.d)}`).join('\n');
  return `${head ? head + '\n\n' : ''}${body}\n`;
}

/** console.error と未処理の例外・Promise の失敗を残す（一度だけ） */
let installed = false;
export function installErrorHooks(target = globalThis) {
  if (installed) return;
  installed = true;
  // 画面を離れる・アプリが裏へ回る・再読込のときは待たずに保存（Android は裏で止められることがある）
  target.addEventListener?.('pagehide', () => flushLog());
  target.document?.addEventListener?.('visibilitychange', () => { if (target.document.visibilityState === 'hidden') flushLog(); });
  target.addEventListener?.('error', (ev) => logError(ev.error || ev.message, `未処理の例外 ${ev.filename ? String(ev.filename).split('/').pop() + ':' + ev.lineno : ''}`));
  target.addEventListener?.('unhandledrejection', (ev) => logError(ev.reason, '未処理の Promise の失敗'));
  const orig = console.error.bind(console);
  console.error = (...a) => {
    try { log('error', a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 500), { error: true, stack: a.find((x) => x instanceof Error)?.stack?.split('\n').slice(0, 6).join('\n') }); } catch { /* 無視 */ }
    orig(...a);
  };
}
