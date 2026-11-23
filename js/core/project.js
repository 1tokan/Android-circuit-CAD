// プロジェクトデータモデル（純粋関数のみ。DOM・IndexedDBに依存しない）
// 保存形式: 独自JSON。schemaVersion でマイグレーションする。

export const FORMAT_ID = 'pocket-eda-project';
export const SCHEMA_VERSION = 2;

/** 衝突しにくいID（crypto.randomUUID が無い環境でも動く） */
export function newId(prefix = 'id') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  const rnd = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}_${rnd}`;
}

/**
 * 既定の基板設定。
 *  fab:   製造仕様（板厚・銅厚・色・表面処理など。層数は pcb.settings.layers が持つ）
 *  rules: 利用者が変えた設計ルールだけ（既定値は check/rules.js が層数に応じて決める）
 */
export function defaultBoardSettings() {
  return {
    fab: { thicknessMm: 1.6, stackup: null, outerCopperOz: 1, innerCopperOz: 0.5, maskColor: 'green', silkColor: 'white', finish: 'LeadFreeHASL', viaProcess: 'tented' },
    rules: {},
  };
}

/** 空のプロジェクトを作る */
export function createProject(name = '新規プロジェクト', now = Date.now()) {
  return {
    format: FORMAT_ID,
    schemaVersion: SCHEMA_VERSION,
    id: newId('prj'),
    name: String(name).trim() || '新規プロジェクト',
    createdAt: now,
    updatedAt: now,
    revision: 0,
    schematic: { sheets: [{ id: newId('sheet'), name: 'Sheet1', components: [], wires: [], junctions: [], labels: [] }] },
    library: { parts: [] },          // プロジェクト内で使う部品（LCSC品番を含む）
    netlist: null,                   // 回路図から生成。生成前は null
    pcb: { outline: [], footprints: [], tracks: [], vias: [], zones: [], texts: [], holes: [] },
    board: defaultBoardSettings(),
    checks: { erc: null, drc: null }, // 未実行は null（「検査済み」と誤表示しないため）
    settings: { grid: 1, autosave: true },
  };
}

/** 検証エラー */
export class ProjectFormatError extends Error {
  constructor(message) { super(message); this.name = 'ProjectFormatError'; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 旧バージョンのJSONを現行スキーマへ変換する。
 * 現在は v1 のみ。将来 v2 を作るときは migrations[1] = (p) => {...; p.schemaVersion = 2}
 */
const migrations = {
  // v1 → v2: 基板設定を「製造仕様(fab)」と「利用者が変えたルールだけ(rules)」に分ける。層数は PCB 設定へ
  1: (p) => {
    const b = isObj(p.board) ? p.board : {};
    const OLD_DEFAULTS = { minTrackWidthMm: 0.127, minClearanceMm: 0.127, minViaDrillMm: 0.3, minViaDiameterMm: 0.6, boardEdgeClearanceMm: 0.3 };
    const rules = {};
    for (const [k, v] of Object.entries(isObj(b.rules) ? b.rules : {})) if (OLD_DEFAULTS[k] !== v) rules[k] = v;
    const fab = { ...defaultBoardSettings().fab, ...(isObj(b.fab) ? b.fab : {}) };
    if (Number.isFinite(b.thicknessMm)) fab.thicknessMm = b.thicknessMm;
    if (Number.isFinite(b.copperOz)) fab.outerCopperOz = b.copperOz;
    const layers = [2, 4, 6].includes(b.layers) ? b.layers : 2;
    if (isObj(p.pcb) && isObj(p.pcb.settings) && !p.pcb.settings.layers) p.pcb.settings.layers = layers;
    return { ...p, board: { fab, rules }, schemaVersion: 2 };
  },
};

export function migrate(data) {
  let p = data;
  while (p.schemaVersion < SCHEMA_VERSION) {
    const fn = migrations[p.schemaVersion];
    if (!fn) throw new ProjectFormatError(`schemaVersion ${p.schemaVersion} からの移行手順がありません`);
    p = fn(p);
  }
  return p;
}

/**
 * 外部から来たJSON（インポート・DB読込）を検証し、欠けた項目を既定値で補う。
 * 壊れたデータは例外にする（黙って空プロジェクトにしない）。
 */
export function normalizeProject(data) {
  if (!isObj(data)) throw new ProjectFormatError('JSONの最上位がオブジェクトではありません');
  if (data.format !== FORMAT_ID) throw new ProjectFormatError('Pocket EDA のプロジェクトファイルではありません');
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
    throw new ProjectFormatError('schemaVersion が不正です');
  }
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new ProjectFormatError(`このファイルは新しいバージョン(v${data.schemaVersion})で作られています。アプリを更新してください`);
  }
  if (typeof data.id !== 'string' || !data.id) throw new ProjectFormatError('id がありません');

  const p = migrate(structuredCloneSafe(data));
  const base = createProject(p.name, p.createdAt ?? Date.now());

  const out = {
    ...base,
    ...p,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : base.name,
    revision: Number.isInteger(p.revision) && p.revision >= 0 ? p.revision : 0,
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : base.createdAt,
    updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : base.updatedAt,
    schematic: isObj(p.schematic) && Array.isArray(p.schematic.sheets) ? p.schematic : base.schematic,
    library: isObj(p.library) && Array.isArray(p.library.parts) ? p.library : base.library,
    pcb: isObj(p.pcb) ? { ...base.pcb, ...p.pcb } : base.pcb,
    board: isObj(p.board) ? {
      fab: { ...base.board.fab, ...(p.board.fab || {}) }, rules: { ...(p.board.rules || {}) },
      // ネットごとの最大電流と温度上昇（配線幅の検査・自動配線の線幅）
      ...(isObj(p.board.current) ? { current: { tempRiseC: Number(p.board.current.tempRiseC) || 10, nets: { ...(isObj(p.board.current.nets) ? p.board.current.nets : {}) } } } : {}),
    } : base.board,
    checks: isObj(p.checks) ? { ...base.checks, ...p.checks } : base.checks,
    settings: isObj(p.settings) ? { ...base.settings, ...p.settings } : base.settings,
  };
  return out;
}

/** 変更を記録（revision と updatedAt を進める） */
export function touch(project, now = Date.now()) {
  project.revision += 1;
  project.updatedAt = Math.max(now, project.updatedAt + 1);
  return project;
}

/** エクスポート用の文字列 */
export function serializeProject(project) {
  return JSON.stringify(project, null, 2);
}

/** インポート用。文字列→検証済みプロジェクト */
export function parseProject(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new ProjectFormatError('JSONとして読み込めません: ' + e.message); }
  return normalizeProject(data);
}

/** インポート時、既存と同じIDなら別プロジェクトとして複製する */
export function asCopy(project, now = Date.now()) {
  const p = structuredCloneSafe(project);
  p.id = newId('prj');
  p.name = `${project.name} (コピー)`;
  p.createdAt = now;
  p.updatedAt = now;
  return p;
}

/** 一覧表示用の要約 */
export function summarize(project) {
  const comps = project.schematic.sheets.reduce((n, s) => n + (s.components?.length || 0), 0);
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    revision: project.revision,
    componentCount: comps,
  };
}

/** ファイル名に使えない文字を置換 */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'project';
}

function structuredCloneSafe(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}
