// 元に戻す・やり直す（スナップショット方式）
// 編集前の状態を JSON 文字列で積む。回路図程度の大きさなら十分軽い。

export class History {
  /**
   * @param {() => any} get 現在の状態を返す
   * @param {(state:any) => void} set 状態を置き換える
   */
  constructor(get, set, limit = 200) {
    this.get = get;
    this.set = set;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** fn を実行し、状態が変わっていれば履歴に積む。変化の有無を返す */
  record(fn, label = '') {
    const before = JSON.stringify(this.get());
    const result = fn();
    const after = JSON.stringify(this.get());
    if (before === after) return false;
    this.undoStack.push({ state: before, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return result === undefined ? true : result;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ state: JSON.stringify(this.get()), label: e.label });
    this.set(JSON.parse(e.state));
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ state: JSON.stringify(this.get()), label: e.label });
    this.set(JSON.parse(e.state));
    return e.label;
  }

  clear() { this.undoStack = []; this.redoStack = []; }
}
