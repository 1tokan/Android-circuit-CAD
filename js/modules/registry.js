// 機能モジュールの登録簿。
// status: 'planned'（未実装） | 'partial'（一部実装） | 'ready'（実装・検証済み）
// UI はこの status を見て「未実装」表示を出す。完成していない機能を完成扱いしない。

export const MODULES = [
  { id: 'project',   name: 'プロジェクト管理・保存', stage: 1, status: 'ready' },
  { id: 'schematic', name: '回路図エディタ',         stage: 2, status: 'planned' },
  { id: 'library',   name: '電子部品ライブラリ',     stage: 3, status: 'planned' },
  { id: 'lcsc',      name: 'LCSC部品検索・管理',     stage: 3, status: 'planned' },
  { id: 'netlist',   name: 'ネットリスト生成',       stage: 3, status: 'planned' },
  { id: 'pcb',       name: 'PCBレイアウトエディタ',  stage: 4, status: 'planned' },
  { id: 'erc',       name: 'ERC（電気的ルール）',    stage: 5, status: 'planned' },
  { id: 'drc',       name: 'DRC（基板設計ルール）',  stage: 5, status: 'planned' },
  { id: 'gerber',    name: 'Gerber・Excellon生成',   stage: 6, status: 'planned' },
  { id: 'bomcpl',    name: 'BOM・CPL生成',           stage: 7, status: 'planned' },
];

// 画面上の作業領域（タブ）と、そこで使うモジュール
export const WORKSPACES = [
  { id: 'schematic', label: '回路図', icon: 'sch', modules: ['schematic', 'netlist'] },
  { id: 'pcb',       label: 'PCB',   icon: 'pcb', modules: ['pcb'] },
  { id: 'parts',     label: '部品',  icon: 'parts', modules: ['library', 'lcsc'] },
  { id: 'check',     label: '検査',  icon: 'check', modules: ['erc', 'drc'] },
  { id: 'output',    label: '出力',  icon: 'out', modules: ['gerber', 'bomcpl'] },
];

// 各作業領域の下部ツール（第2段階以降で有効化）
export const TOOLS = {
  schematic: [
    { id: 'select', label: '選択' }, { id: 'place', label: '部品' }, { id: 'wire', label: '配線' },
    { id: 'label', label: 'ラベル' }, { id: 'power', label: '電源' }, { id: 'rotate', label: '回転' },
    { id: 'mirror', label: 'ミラー' }, { id: 'delete', label: '削除' },
  ],
  pcb: [
    { id: 'select', label: '選択' }, { id: 'route', label: '配線' }, { id: 'via', label: 'ビア' },
    { id: 'zone', label: 'ベタ' }, { id: 'outline', label: '外形' }, { id: 'text', label: '文字' },
    { id: 'rotate', label: '回転' }, { id: 'delete', label: '削除' },
  ],
  parts: [{ id: 'search', label: '検索' }, { id: 'import', label: '取込' }, { id: 'add', label: '登録' }],
  check: [{ id: 'erc', label: 'ERC' }, { id: 'drc', label: 'DRC' }],
  output: [{ id: 'gerber', label: 'Gerber' }, { id: 'bom', label: 'BOM' }, { id: 'cpl', label: 'CPL' }],
};

export function moduleById(id) { return MODULES.find((m) => m.id === id); }

export function workspaceStatus(ws) {
  const st = ws.modules.map((id) => moduleById(id).status);
  if (st.every((s) => s === 'ready')) return 'ready';
  if (st.some((s) => s !== 'planned')) return 'partial';
  return 'planned';
}
