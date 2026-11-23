// 設計ルール（DRC・ベタ塗り・製造データで共通）
// 既定値は JLCPCB 標準品の製造能力（2026年11月確認）。層数で変わる値は baseRules で切り替える。
// プロジェクトの board.rules には「利用者が変えた値」だけを入れる（既定値をコピーして持たない＝食い違いを作らない）。

/** 1〜2層の既定 */
const RULES_2L = {
  minTrackWidthMm: 0.127,      // 配線幅
  minClearanceMm: 0.127,       // 銅どうしの間隔（配線-配線・パッド-パッド・ビア）
  minPadClearanceMm: 0.2,      // パッド-配線、パッド-ビア
  boardEdgeClearanceMm: 0.3,   // 銅と基板外形（外層）
  innerEdgeClearanceMm: 0.3,   // 銅と基板外形（内層。2層では使わない）
  minViaDrillMm: 0.3,
  minViaDiameterMm: 0.5,
  minViaAnnularMm: 0.1,        // (外径-穴径)/2
  minAnnularRingMm: 0.13,      // スルーホールパッドのランド幅
  minPthDrillMm: 0.2,
  maxDrillMm: 6.35,
  minHoleToHoleMm: 0.5,        // 異なるネットの穴どうし（穴の縁から縁）
  minSameNetHoleMm: 0.254,     // 同じネットの穴どうし（JLCPCB「Via to Via clearance (Same nets)」。近すぎるとドリルが折れる・穴がつながる）
  minNpthToCopperMm: 0.254,    // 取付穴（非メッキ）と銅
  minSilkToPadMm: 0.15,        // シルクとパッド
  minSilkWidthMm: 0.153,       // シルクの線幅
  minSilkTextHeightMm: 1.0,    // シルク文字の高さ
  maskExpansionMm: 0.05,       // ソルダーマスクの開口（パッドより片側この分大きく）
  minMaskBridgeMm: 0.1,        // パッド間に残すレジストの最小幅（これより細いと製造時に除かれる）
};

/** 4・6層の既定（細い配線・小さいビアが使える。内層は外形から離す） */
const RULES_ML = {
  ...RULES_2L,
  minTrackWidthMm: 0.09,
  minClearanceMm: 0.09,
  minViaDrillMm: 0.2,
  minViaDiameterMm: 0.45,
  innerEdgeClearanceMm: 0.4,
};

/** 層数に応じた既定のルール */
export function baseRules(layers = 2) {
  return { ...(layers >= 4 ? RULES_ML : RULES_2L) };
}

/** 2層の既定（後方互換のための名前。層数が分かるところでは baseRules を使う） */
export const DRC_DEFAULTS = Object.freeze({ ...RULES_2L });

/** プロジェクトの層数（PCB 設定が持つ） */
export function layerCount(project) {
  return project?.pcb?.settings?.layers || 2;
}

/** プロジェクトの実効ルール = 層数の既定 ＋ 利用者が変えた値 */
export function drcRules(project) {
  return { ...baseRules(layerCount(project)), ...(project?.board?.rules || {}) };
}

/** ルールの一部を既定値で補う（層数が分からないとき） */
export function withDefaults(rules = {}) {
  return { ...RULES_2L, ...rules };
}
