// 機能モジュールの登録簿。
// status: 'planned'（未実装） | 'partial'（一部実装） | 'ready'（実装・検証済み）
// UI はこの status を見て「未実装」表示を出す。完成していない機能を完成扱いしない。

export const MODULES = [
  { id: 'project',   name: 'プロジェクト管理・保存', stage: 1, status: 'ready' },
  { id: 'schematic', name: '回路図エディタ',         stage: 2, status: 'ready' },
  { id: 'library',   name: '電子部品ライブラリ',     stage: 3, status: 'ready' },
  { id: 'lcsc',      name: 'LCSC部品検索・管理',     stage: 3, status: 'ready', note: '公式APIは非使用（CSV/JSON取込・手動登録・LCSCリンク）。非公式の jlcsearch で検索し、回路図の部品から 3 手で品番を割り当てる近道・品番なしをまとめて割り当てる機能あり（価格・在庫は検索時点）' },
  { id: 'netlist',   name: 'ネットリスト生成',       stage: 3, status: 'ready' },
  { id: 'pcb',       name: 'PCBレイアウトエディタ',  stage: 4, status: 'ready', note: '自動配線（グリッド A*・引き直し）・3D 表示（簡易形状）あり' },
  { id: 'erc',       name: 'ERC（電気的ルール）',    stage: 5, status: 'ready', note: '1シートのみ。汎用ICのピン属性は「双方向」扱い（検査結果に未検査項目を表示）' },
  { id: 'drc',       name: 'DRC（基板設計ルール）',  stage: 5, status: 'ready', note: '配線幅と電流（IPC-2221 の近似）を含む。ベタの細いくびれは未検査' },
  { id: 'signal',    name: '信号経路（USB・I2S・アナログ音声）', stage: 5, status: 'ready', note: 'つながり・左右・極性・役割は汎用。設定ピン・レベル・入力インピーダンスは登録した部品（PCM5102A・TPA6132A2・MAX98357A・USBLC6）のみ。ファームウェアは対象外' },
  { id: 'gerber',    name: 'Gerber・Excellon生成',   stage: 6, status: 'ready', note: 'RS-274X X2・Excellon・ZIP。ベタの塗りつぶし（クリアランス・サーマル・島除去）を含む' },
  { id: 'bomcpl',    name: 'BOM・CPL生成',           stage: 7, status: 'ready', note: 'JLCPCB形式。回転はパッケージ補正表＋部品ごとの手動補正（プレビューで要確認）' },
  { id: 'sim',       name: '回路シミュレーション（SPICE 相当）', stage: 13, status: 'partial', note: '動作点・直流スイープ（2 重まで）・AC・過渡、FFT・カーソル・測定・チューニング、SPICE（ngspice）ネットリスト書き出し、.model と R C L K V I E G D Q M X の .subckt の読込。回路図の交流・直流・電流源（基板に載らない）、トランス（結合係数つき）、ブリッジ・ショットキー・双方向 TVS。モデル: ダイオード・バイポーラ（Gummel-Poon の基本）・MOSFET レベル 1・オペアンプ（飽和つき）。レギュレータ・フォトカプラ・リレー・水晶はモデルなし（SPICE のサブ回路を割り当てれば計算に入る）。拡散容量（TT）は容量で近似するので、大きな TT は刻みが細かくなる。素子の容量だけで時定数が決まる回路は ngspice と数 % 差がある（容量モデルの違い）。未実装: 雑音解析・極零・伝達関数・感度、B 素子（式）・JFET・スイッチ素子・.param・.lib・BSIM などの高度な MOSFET モデル、温度の変更' },
  { id: 'kicad',     name: 'KiCad 書き出し',   stage: 7, status: 'ready', note: 'プロジェクト一式（.kicad_pcb・.kicad_sch・シンボル・フットプリント・簡易 3D・設計ルール）。KiCad 7.0.11 で読み込み・照合を確認。3D は簡易形状' },
];

// 画面上の作業領域（タブ）と、そこで使うモジュール
export const WORKSPACES = [
  { id: 'schematic', label: '回路図', icon: 'sch', modules: ['schematic', 'netlist'] },
  { id: 'pcb',       label: 'PCB',   icon: 'pcb', modules: ['pcb'] },
  { id: 'parts',     label: '部品',  icon: 'parts', modules: ['library', 'lcsc'] },
  { id: 'check',     label: '検査',  icon: 'check', modules: ['erc', 'drc', 'signal'] },
  { id: 'output',    label: '出力',  icon: 'out', modules: ['gerber', 'bomcpl', 'kicad'] },
  { id: 'sim',       label: 'シミュ', icon: 'sim', modules: ['sim'] },
];

// 各作業領域の下部ツール
export const TOOLS = {
  schematic: [
    { id: 'select', label: '選択', icon: 'M5 3l12 8-5 1 3 6-2 1-3-6-4 4z' },
    { id: 'place', label: '部品', icon: 'M4 9h4M16 9h4M8 6h8v6H8zM12 14v6M9 17h6' },
    { id: 'wire', label: '配線', icon: 'M3 18h7V6h11' },
    { id: 'label', label: 'ラベル', icon: 'M3 12l5-5h13v10H8z' },
    { id: 'power', label: '電源', icon: 'M12 21V9M6 9h12M8 4h8' },
    { id: 'rotate', label: '回転', icon: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5', action: true },
    { id: 'mirror', label: 'ミラー', icon: 'M12 3v18M9 7l-5 5 5 5zM15 7l5 5-5 5z', action: true },
    { id: 'delete', label: '削除', icon: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', action: true },
  ],
  pcb: [
    { id: 'select', label: '選択', icon: 'M5 3l12 8-5 1 3 6-2 1-3-6-4 4z' },
    { id: 'route', label: '配線', icon: 'M4 18h6l6-6V5' },
    { id: 'via', label: 'ビア', icon: 'M12 7a5 5 0 1 0 0 10a5 5 0 0 0 0-10zM12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3z' },
    { id: 'zone', label: 'ベタ', icon: 'M4 4h16v16H4zM4 9l5-5M4 14L14 4M4 19L19 4M9 20l11-11M14 20l6-6' },
    { id: 'outline', label: '外形', icon: 'M4 4h16v16H4zM8 8h.01M16 8h.01M8 16h.01M16 16h.01' },
    { id: 'text', label: '文字', icon: 'M5 6h14M12 6v13M9 19h6' },
    { id: 'rotate', label: '回転', icon: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5', action: true },
    { id: 'delete', label: '削除', icon: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', action: true },
  ],
  parts: [
    { id: 'search', label: '検索', icon: 'M10 4a6 6 0 1 0 0 12a6 6 0 0 0 0-12zM15 15l5 5' },
    { id: 'import', label: '取込', icon: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
    { id: 'add', label: '登録', icon: 'M12 5v14M5 12h14' },
    { id: 'export', label: '書出', icon: 'M12 15V4M7 9l5-5 5 5M5 20h14' },
  ],
  check: [
    { id: 'erc', label: 'ERC実行', icon: 'M4 12h4l2-5 4 10 2-5h4' },
    { id: 'drc', label: 'DRC実行', icon: 'M4 4h16v16H4zM8 8h3v3H8zM13 13h3v3h-3zM11 9.5h4v3.5' },
    { id: 'sig', label: '信号経路', icon: 'M3 12h4l3-6 4 12 3-6h4M19 9l3 3-3 3' },
    { id: 'rules', label: 'ルール', icon: 'M5 6h14M5 12h14M5 18h14M9 4v4M15 10v4M8 16v4' },
  ],
  sim: [
    { id: 'run', label: '実行', icon: 'M7 4l12 8-12 8z' },
    { id: 'source', label: '信号源', icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM6 12c2-5 4-5 6 0s4 5 6 0' },
    { id: 'spice', label: 'SPICE', icon: 'M12 15V4M7 9l5-5 5 5M5 20h14' },
  ],
  output: [
    { id: 'gerber', label: 'Gerber書出', module: 'gerber', icon: 'M12 4v11M7 10l5 5 5-5M5 20h14' },
    { id: 'bom', label: 'BOM', module: 'bomcpl', icon: 'M5 5h14v14H5zM5 10h14M5 15h14M10 5v14' },
    { id: 'cpl', label: 'CPL', module: 'bomcpl', icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z' },
    { id: 'kicad', label: 'KiCad', module: 'kicad', icon: 'M5 4h10l4 4v12H5zM9 12h6M9 16h6' },
  ],
};

export function moduleById(id) { return MODULES.find((m) => m.id === id); }

export function workspaceStatus(ws) {
  const st = ws.modules.map((id) => moduleById(id).status);
  if (st.every((s) => s === 'ready')) return 'ready';
  if (st.some((s) => s !== 'planned')) return 'partial';
  return 'planned';
}
