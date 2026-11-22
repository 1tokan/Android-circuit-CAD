// 共通の小さな道具（複数のモジュールで同じものを持たないためにここへ集める）

/** HTML に埋め込む文字列のエスケープ */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Union-Find（接続の計算用） */
export class DSU {
  constructor() { this.p = new Map(); }
  add(a) { if (!this.p.has(a)) this.p.set(a, a); }
  find(a) {
    let r = a;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(a) !== r) { const n = this.p.get(a); this.p.set(a, r); a = n; }
    return r;
  }
  union(a, b) { const x = this.find(a), y = this.find(b); if (x !== y) this.p.set(x, y); }
}
