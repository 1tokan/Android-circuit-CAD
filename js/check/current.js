// 配線幅と電流（IPC-2221 の近似式）
// I = k × ΔT^0.44 × A^0.725（I: A、ΔT: 温度上昇 ℃、A: 断面積 mil²、k: 外層 0.048・内層 0.024）
// 断面積 = 線幅 × 銅厚（1oz = 1.378 mil = 0.035 mm）。ビアは穴の壁のめっき（円筒）を内層の導体とみなした目安。
// ネットごとの「最大電流」は利用者が設定する（project.board.current = { tempRiseC, nets: { 名前: A } }）。
// 設定したネットのすべての配線をその電流で判定する（枝ごとの電流は分からないので、安全側の判定）。

import { copperLayers, toMm } from '../pcb/model.js';

export const MIL = 0.0254;            // mm
export const OZ_MM = 0.035;           // 1oz の銅厚（mm）
export const VIA_PLATING_MM = 0.018;  // ビアの穴のめっき厚の目安（mm）
export const DEFAULT_TEMP_RISE = 10;  // ℃

/** 電流の設定（無ければ既定） */
export function currentSettings(project) {
  const c = project.board?.current || {};
  const nets = {};
  for (const [k, v] of Object.entries(c.nets || {})) if (Number(v) > 0) nets[k] = Number(v);
  return { tempRiseC: Number(c.tempRiseC) > 0 ? Number(c.tempRiseC) : DEFAULT_TEMP_RISE, nets };
}

/** 電流 I（A）を流すのに必要な線幅（mm） */
export function requiredWidthMm(I, { internal = false, oz = 1, tempRiseC = DEFAULT_TEMP_RISE } = {}) {
  if (!(I > 0)) return 0;
  const k = internal ? 0.024 : 0.048;
  const areaMil2 = Math.pow(I / (k * Math.pow(tempRiseC, 0.44)), 1 / 0.725);
  return (areaMil2 / (oz * 1.378)) * MIL;
}

/** 線幅 w（mm）で流せる電流（A） */
export function widthCapacityA(w, { internal = false, oz = 1, tempRiseC = DEFAULT_TEMP_RISE } = {}) {
  const k = internal ? 0.024 : 0.048;
  const areaMil2 = (w / MIL) * oz * 1.378;
  return k * Math.pow(tempRiseC, 0.44) * Math.pow(areaMil2, 0.725);
}

/** ビア1本で流せる電流の目安（A）。穴の壁のめっきの断面（π × 穴径 × めっき厚）を内層の導体とみなす */
export function viaCapacityA(drillMm, { tempRiseC = DEFAULT_TEMP_RISE, platingMm = VIA_PLATING_MM } = {}) {
  const areaMm2 = Math.PI * drillMm * platingMm;
  const areaMil2 = areaMm2 / (MIL * MIL);
  return 0.024 * Math.pow(tempRiseC, 0.44) * Math.pow(areaMil2, 0.725);
}

/** 層の銅厚（oz）。外層・内層は製造仕様から */
export function layerOz(project, layer) {
  const fab = project.board?.fab || {};
  return layer === 'F.Cu' || layer === 'B.Cu' ? (fab.outerCopperOz || 1) : (fab.innerCopperOz || 0.5);
}

/** ネットの、層ごとに必要な線幅（mm）。自動配線の線幅にも使う */
export function netWidthFor(project, net, layer = 'F.Cu') {
  const s = currentSettings(project);
  const I = s.nets[net];
  if (!I) return 0;
  return requiredWidthMm(I, { internal: !(layer === 'F.Cu' || layer === 'B.Cu'), oz: layerOz(project, layer), tempRiseC: s.tempRiseC });
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 電流の検査。DRC から呼ぶ
 * @returns [{ level, rule, message, refs, at }]
 */
export function checkCurrent(project, pcb) {
  const s = currentSettings(project);
  const out = [];
  if (!Object.keys(s.nets).length) return out;
  const cu = copperLayers(pcb);
  for (const [net, I] of Object.entries(s.nets)) {
    // 配線: 層ごとに、必要な幅より細い本数と最も細い幅
    const byLayer = new Map();
    for (const t of pcb.tracks) {
      if (t.net !== net || !cu.includes(t.layer)) continue;
      const need = netWidthFor(project, net, t.layer), w = toMm(t.width);
      if (w + 1e-6 >= need) continue;
      const b = byLayer.get(t.layer) || { n: 0, min: Infinity, need, at: null };
      b.n++;
      if (w < b.min) { b.min = w; b.at = { x: (toMm(t.a.x) + toMm(t.b.x)) / 2, y: (toMm(t.a.y) + toMm(t.b.y)) / 2 }; }
      byLayer.set(t.layer, b);
    }
    for (const [layer, b] of byLayer) {
      const cap = widthCapacityA(b.min, { internal: !(layer === 'F.Cu' || layer === 'B.Cu'), oz: layerOz(project, layer), tempRiseC: s.tempRiseC });
      out.push({
        level: 'warning', rule: 'track_current',
        message: `${net}（${I}A）: ${layer} の配線 ${b.n} 本が細い（最細 ${r3(b.min)}mm で流せる目安 ${r3(cap)}A、必要な幅 ${r3(b.need)}mm・温度上昇 ${s.tempRiseC}℃）。主な電流が流れない枝（パスコンへの引き出しなど）なら問題ありません`,
        refs: [], at: b.at && { x: b.at.x, y: b.at.y },
      });
    }
    // ビア: 1本あたりの目安を超えるのに、ビアの本数が足りない
    const vias = pcb.vias.filter((v) => v.net === net);
    if (vias.length) {
      const drill = Math.min(...vias.map((v) => toMm(v.drill)));
      const cap = viaCapacityA(drill, { tempRiseC: s.tempRiseC });
      const need = Math.ceil(I / cap);
      if (cap < I && vias.length < need) {
        out.push({ level: 'warning', rule: 'via_current', message: `${net}（${I}A）: ビア1本（穴 ${r3(drill)}mm）の目安は ${r3(cap)}A。電流の通り道に ${need} 本以上を並べてください（今 ${vias.length} 本）`, refs: [], at: { x: toMm(vias[0].x), y: toMm(vias[0].y) } });
      }
    }
  }
  return out;
}
