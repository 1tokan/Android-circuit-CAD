// 設計ルールの既定値（DRC・ベタ塗り・製造データで共通）
// 既定値は JLCPCB の 1〜2 層標準品の製造能力（2026年11月確認）。プロジェクトの board.rules で上書きできる。

export const DRC_DEFAULTS = {
  minTrackWidthMm: 0.127,      // 配線幅（1〜2層）
  minClearanceMm: 0.127,       // 銅どうしの間隔（配線-配線・パッド-パッド・ビア）
  minPadClearanceMm: 0.2,      // パッド-配線、パッド-ビア
  boardEdgeClearanceMm: 0.3,   // 銅と基板外形
  minViaDrillMm: 0.3,
  minViaDiameterMm: 0.5,
  minViaAnnularMm: 0.1,        // (外径-穴径)/2
  minAnnularRingMm: 0.13,      // スルーホールパッドのランド幅
  minPthDrillMm: 0.2,
  maxDrillMm: 6.35,
  minHoleToHoleMm: 0.5,        // 異なるネットの穴どうし（穴の縁から縁）
  minNpthToCopperMm: 0.254,    // 取付穴（非メッキ）と銅
  minSilkToPadMm: 0.15,        // シルクとパッド
  minSilkWidthMm: 0.153,       // シルクの線幅
  minSilkTextHeightMm: 1.0,    // シルク文字の高さ
  maskExpansionMm: 0.05,       // ソルダーマスクの開口（パッドより片側この分大きく）
};

/** プロジェクトの実効ルール */
export function drcRules(project) {
  return { ...DRC_DEFAULTS, ...(project.board?.rules || {}) };
}
/** ルールの一部（board.rules そのものなど）を既定値で補う */
export function withDefaults(rules = {}) {
  return { ...DRC_DEFAULTS, ...rules };
}

