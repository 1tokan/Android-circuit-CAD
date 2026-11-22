// 自動保存: 変更通知(markDirty)から delay ms 静かになったら保存。
// 連続編集中でも maxWait ms を超えたら必ず保存する。
// ページ非表示（アプリ切替・画面OFF）時は即保存する。

export class AutoSaver {
  /**
   * @param {() => Promise<void>} saveFn 実際の保存処理
   * @param {{delay?:number, maxWait?:number, onState?:(s:string, err?:Error)=>void}} opt
   */
  constructor(saveFn, { delay = 1500, maxWait = 10000, onState = () => {} } = {}) {
    this.saveFn = saveFn;
    this.delay = delay;
    this.maxWait = maxWait;
    this.onState = onState;
    this.enabled = true;
    this.dirty = false;
    this.timer = null;
    this.firstDirtyAt = 0;
    this.saving = null;
  }

  markDirty() {
    this.dirty = true;
    this.onState('dirty');
    if (!this.enabled) return;
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstDirtyAt + this.maxWait - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** 未保存があれば保存する。保存中に変更があれば続けてもう一度保存する */
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.saving) { await this.saving; }
    if (!this.dirty) return false;
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.onState('saving');
    this.saving = (async () => {
      try {
        await this.saveFn();
        this.onState(this.dirty ? 'dirty' : 'saved');
      } catch (e) {
        this.dirty = true; // 失敗したら未保存に戻す
        this.onState('error', e);
        throw e;
      } finally {
        this.saving = null;
      }
    })();
    await this.saving;
    if (this.dirty && this.enabled) this.markDirty();
    return true;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (this.enabled && this.dirty) this.markDirty();
    if (!this.enabled) clearTimeout(this.timer);
  }

  /** ページ離脱・非表示で即保存 */
  attachLifecycle(win = globalThis) {
    const handler = () => { if (this.dirty) this.flush().catch(() => {}); };
    win.document?.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'hidden') handler();
    });
    win.addEventListener?.('pagehide', handler);
  }
}
