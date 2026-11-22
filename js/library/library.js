// 部品ライブラリのサービス層: 内蔵部品＋ユーザー部品（IndexedDB）をまとめて扱う。
// 同じIDのユーザー部品は内蔵部品より優先（内蔵部品を「コピーして編集」した場合など）。

import { BUILTIN_PARTS, normalizePart, searchParts } from './parts.js';
import * as store from '../core/storage.js';

export function createLibrary() {
  let user = [];
  let merged = [...BUILTIN_PARTS];
  const byId = new Map();

  function rebuild() {
    const ids = new Set(user.map((p) => p.id));
    merged = [...user, ...BUILTIN_PARTS.filter((p) => !ids.has(p.id))];
    byId.clear();
    merged.forEach((p) => byId.set(p.id, p));
  }

  return {
    async load() {
      const raw = await store.listUserParts();
      user = [];
      for (const r of raw) { try { user.push(normalizePart(r)); } catch { /* 壊れた行は無視 */ } }
      rebuild();
      return merged.length;
    },
    all: () => merged,
    get: (id) => byId.get(id) || null,
    isBuiltin: (id) => BUILTIN_PARTS.some((p) => p.id === id) && !user.some((p) => p.id === id),
    counts: () => ({ builtin: BUILTIN_PARTS.length, user: user.length, total: merged.length }),
    search: (q, f, limit) => searchParts(merged, q, f, limit),
    async upsert(parts) {
      const list = parts.map((p) => normalizePart(p));
      await store.putParts(list);
      const m = new Map(user.map((p) => [p.id, p]));
      list.forEach((p) => m.set(p.id, p));
      user = [...m.values()];
      rebuild();
      return list;
    },
    async remove(ids) {
      await store.deleteParts(ids);
      const s = new Set(ids);
      user = user.filter((p) => !s.has(p.id));
      rebuild();
    },
    userParts: () => user,
  };
}
