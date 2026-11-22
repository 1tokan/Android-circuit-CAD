// モジュール間の疎結合用イベントバス
export class EventBus {
  #map = new Map();
  on(type, fn) {
    if (!this.#map.has(type)) this.#map.set(type, new Set());
    this.#map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this.#map.get(type)?.delete(fn); }
  emit(type, detail) {
    for (const fn of [...(this.#map.get(type) || [])]) {
      try { fn(detail); } catch (e) { console.error(`[event:${type}]`, e); }
    }
  }
}

export const bus = new EventBus();
