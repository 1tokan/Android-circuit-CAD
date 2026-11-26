// IndexedDB によるローカル保存
// stores:
//   projects : 最新版（keyPath: id）
//   backups  : 保存ごとの世代バックアップ（プロジェクトごとに最大 MAX_BACKUPS 件）
//   kv       : アプリ設定（最後に開いたプロジェクト等）
//   parts    : ユーザー部品ライブラリ（取込・手動登録した部品。内蔵部品は保存しない）

import { normalizeProject, summarize } from './project.js';

const DB_NAME = 'pocket-eda';
const DB_VERSION = 2; // v2: ユーザー部品ライブラリ(parts)を追加
export const MAX_BACKUPS = 10;

let dbPromise = null;

function req2p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export function openDB(idb = globalThis.indexedDB) {
  if (dbPromise) return dbPromise;
  if (!idb) return Promise.reject(new Error('このブラウザは IndexedDB に対応していません'));
  dbPromise = new Promise((resolve, reject) => {
    const r = idb.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) {
        const s = db.createObjectStore('projects', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('backups')) {
        const b = db.createObjectStore('backups', { keyPath: 'key', autoIncrement: true });
        b.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('parts')) {
        const p = db.createObjectStore('parts', { keyPath: 'id' });
        p.createIndex('lcsc', 'lcsc');
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    r.onerror = () => { dbPromise = null; reject(r.error); };
    r.onblocked = () => reject(new Error('別タブでDB更新が保留されています。他のタブを閉じてください'));
  });
  return dbPromise;
}

/** 保存（最新版の上書き＋世代バックアップ追加＋古い世代の削除を1トランザクションで） */
export async function saveProject(project) {
  const db = await openDB();
  const tx = db.transaction(['projects', 'backups'], 'readwrite');
  const data = JSON.parse(JSON.stringify(project)); // 関数や循環参照を持ち込まない
  tx.objectStore('projects').put(data);
  const backups = tx.objectStore('backups');
  backups.add({ projectId: data.id, savedAt: Date.now(), revision: data.revision, data });
  // 古い世代を削る
  const keys = await req2p(backups.index('projectId').getAllKeys(data.id));
  const excess = keys.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) backups.delete(keys[i]);
  await txDone(tx);
  return data;
}

export async function loadProject(id) {
  const db = await openDB();
  const raw = await req2p(db.transaction('projects').objectStore('projects').get(id));
  return raw ? normalizeProject(raw) : null;
}

export async function listProjects() {
  const db = await openDB();
  const all = await req2p(db.transaction('projects').objectStore('projects').getAll());
  return all.map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id) {
  const db = await openDB();
  const tx = db.transaction(['projects', 'backups'], 'readwrite');
  tx.objectStore('projects').delete(id);
  const b = tx.objectStore('backups');
  const keys = await req2p(b.index('projectId').getAllKeys(id));
  keys.forEach((k) => b.delete(k));
  await txDone(tx);
}

export async function listBackups(projectId) {
  const db = await openDB();
  const rows = await req2p(db.transaction('backups').objectStore('backups').index('projectId').getAll(projectId));
  return rows.map((r) => ({ key: r.key, savedAt: r.savedAt, revision: r.revision })).sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadBackup(key) {
  const db = await openDB();
  const r = await req2p(db.transaction('backups').objectStore('backups').get(key));
  return r ? normalizeProject(r.data) : null;
}

export async function getSetting(key, fallback = null) {
  const db = await openDB();
  const v = await req2p(db.transaction('kv').objectStore('kv').get(key));
  return v === undefined ? fallback : v;
}

export async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await txDone(tx);
}

/** ブラウザに保存領域の永続化を依頼（Androidで自動削除されにくくする） */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* 非対応 */ }
  return false;
}

// ---------------- 部品ライブラリ ----------------
export async function listUserParts() {
  const db = await openDB();
  return req2p(db.transaction('parts').objectStore('parts').getAll());
}

/** まとめて追加・上書き（同じIDは上書き） */
export async function putParts(parts) {
  const db = await openDB();
  const tx = db.transaction('parts', 'readwrite');
  const st = tx.objectStore('parts');
  for (const p of parts) st.put(JSON.parse(JSON.stringify(p)));
  await txDone(tx);
  return parts.length;
}

export async function deleteParts(ids) {
  const db = await openDB();
  const tx = db.transaction('parts', 'readwrite');
  ids.forEach((id) => tx.objectStore('parts').delete(id));
  await txDone(tx);
}

