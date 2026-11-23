// KiCanvas（KiCad ファイルのビューア。https://kicanvas.org/ MIT ライセンス）で、書き出した .kicad_pcb を読み直して表示する
// Pocket EDA とは別に作られた KiCad 形式の読み込み処理なので、書き出しが KiCad 形式として読めるかを端末だけで確かめられる。
// ・KiCanvas 本体は kicanvas.org から読み込む（ネット接続が要る。ファイルは送らない。中身はページに直接入れる）
// ・アプリのデータに触れないよう、sandbox の iframe（allow-scripts だけ。別のオリジン扱い）で動かす
// ・sandbox の中では localStorage が使えないので、KiCanvas の設定保存のために、メモリだけの代わりを入れる
// ・読み込めたら、KiCanvas が読んだ部品・配線・ビア・ベタの数を親画面へ知らせる（postMessage）

export const KICANVAS_URL = 'https://kicanvas.org/kicanvas/kicanvas.js';

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

/** iframe の srcdoc に入れるページ */
export function kicanvasPage(pcbText, fileName, { scriptUrl = KICANVAS_URL, timeoutMs = 45000 } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#1b1f23}kicanvas-embed{display:block;width:100%;height:100%}</style>
<script>
(function () {
  var post = function (m) { m.type = 'pocketeda-kicanvas'; parent.postMessage(m, '*'); };
  try { window.localStorage.getItem('x'); } catch (e) {
    var m = new Map();
    var s = { getItem: function (k) { return m.has(k) ? m.get(k) : null; }, setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); }, clear: function () { m.clear(); }, key: function (i) { return Array.from(m.keys())[i] || null; }, get length() { return m.size; } };
    try { Object.defineProperty(window, 'localStorage', { value: s, configurable: true }); } catch (e2) {}
  }
  window.addEventListener('error', function (e) { post({ stage: 'error', message: String(e.message || e.error || e) }); });
  window.addEventListener('unhandledrejection', function (e) { post({ stage: 'error', message: String((e.reason && e.reason.message) || e.reason) }); });
  window.__kcNetError = function () { post({ stage: 'neterror' }); };
  function deep(root, sel) {
    var hit = root.querySelector(sel); if (hit) return hit;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) if (all[i].shadowRoot) { var r = deep(all[i].shadowRoot, sel); if (r) return r; }
    return null;
  }
  var t0 = Date.now();
  var timer = setInterval(function () {
    var el = deep(document, 'kc-board-viewer');
    var board = el && el.viewer && el.viewer.board;
    if (board && board.footprints) {
      clearInterval(timer);
      post({ stage: 'loaded', version: board.version, footprints: board.footprints.length, pads: board.footprints.reduce(function (s, f) { return s + (f.pads ? f.pads.length : 0); }, 0),
        segments: board.segments.length, vias: board.vias.length, zones: board.zones.length, nets: board.nets.length, layers: board.layers.length });
    } else if (Date.now() - t0 > ${timeoutMs}) { clearInterval(timer); post({ stage: 'timeout' }); }
  }, 400);
})();
</script>
<script src="${escAttr(scriptUrl)}" onerror="__kcNetError()"></script>
</head><body>
<kicanvas-embed controls="full" controlslist="nodownload">
<kicanvas-source name="${escAttr(fileName)}" type="board">${escText(pcbText)}</kicanvas-source>
</kicanvas-embed>
</body></html>`;
}

/** KiCanvas が読んだ数と、書き出した設計の数を比べる */
export function compareCounts(msg, pcb) {
  const want = { footprints: pcb.footprints.length + pcb.holes.length, pads: pcb.footprints.reduce((s, f) => s + f.fpDef.pads.length, 0) + pcb.holes.length, segments: pcb.tracks.length, vias: pcb.vias.length, zones: pcb.zones.length };
  const label = { footprints: '部品（取付穴を含む）', pads: 'パッド', segments: '配線', vias: 'ビア', zones: 'ベタ' };
  const rows = Object.keys(want).map((k) => ({ key: k, label: label[k], want: want[k], got: msg[k], ok: msg[k] === want[k] }));
  return { ok: rows.every((r) => r.ok), rows };
}
