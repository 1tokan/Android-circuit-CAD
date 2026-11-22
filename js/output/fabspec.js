// 基板の製造仕様（JLCPCB の注文フォームの項目に合わせる）
// 層数は PCB の設定（pcb.settings.layers）が持ち、ここでは層数以外の製造条件を扱う。
// 値の出典: JLCPCB Capabilities / PCB Stackup（2026年11月確認）

export const FAB_OPTIONS = {
  layers: [2, 4, 6],
  thicknessMm: { 2: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0], 4: [0.8, 1.0, 1.2, 1.6, 2.0], 6: [1.2, 1.6, 2.0] },
  stackup: { 2: [null], 4: ['JLC7628', 'JLC2313'], 6: ['JLC2313'] },
  outerCopperOz: [1, 2],
  innerCopperOz: [0.5, 1, 2],
  maskColor: ['green', 'purple', 'red', 'yellow', 'blue', 'white', 'black'],
  silkColor: ['white', 'black'],
  finish: ['HASL', 'LeadFreeHASL', 'ENIG'],
  viaProcess: ['tented', 'untented', 'plugged', 'epoxyFilled'],
};

export const LABELS = {
  maskColor: { green: '緑', purple: '紫', red: '赤', yellow: '黄', blue: '青', white: '白', black: '黒' },
  silkColor: { white: '白', black: '黒' },
  finish: { HASL: 'HASL（有鉛）', LeadFreeHASL: 'HASL（鉛フリー）', ENIG: 'ENIG（無電解金めっき）' },
  viaProcess: { tented: 'レジストで覆う（テンティング）', untented: '開口（覆わない）', plugged: '穴埋め（樹脂プラグ）', epoxyFilled: 'エポキシ充填＋蓋めっき' },
};

/** 画面・3D 表示用の色 */
export const COLORS = {
  mask: { green: '#1d5e2c', purple: '#4b2a6b', red: '#8f1d1d', yellow: '#c9a200', blue: '#1d3f8f', white: '#e8e8e4', black: '#151515' },
  silk: { white: '#f2f2f2', black: '#111111' },
  finish: { HASL: '#c8c8c8', LeadFreeHASL: '#c8c8c8', ENIG: '#d4af37' },
};

export function defaultFab(layers = 2) {
  return {
    thicknessMm: 1.6,
    stackup: layers === 4 ? 'JLC7628' : layers === 6 ? 'JLC2313' : null,
    outerCopperOz: 1,
    innerCopperOz: 0.5,
    maskColor: 'green',
    silkColor: 'white',
    finish: layers >= 6 ? 'ENIG' : 'LeadFreeHASL',
    viaProcess: 'tented',
  };
}

/** 層数を変えたときに、その層数で選べない値を直す */
export function adaptFab(fab, layers) {
  const f = { ...defaultFab(layers), ...fab };
  if (!FAB_OPTIONS.thicknessMm[layers].includes(f.thicknessMm)) f.thicknessMm = 1.6;
  if (!FAB_OPTIONS.stackup[layers].includes(f.stackup)) f.stackup = FAB_OPTIONS.stackup[layers][0];
  if (layers >= 6 && /HASL/.test(f.finish)) f.finish = 'ENIG';
  if (layers === 2) f.innerCopperOz = 0.5;
  if (f.silkColor === f.maskColor) f.silkColor = f.maskColor === 'white' ? 'black' : 'white';
  return f;
}

/**
 * 仕様の矛盾・注意
 * @returns [{ level, message }]
 */
export function checkFab(fab, layers) {
  const out = [];
  const err = (m) => out.push({ level: 'error', message: m });
  const warn = (m) => out.push({ level: 'warning', message: m });
  if (!FAB_OPTIONS.layers.includes(layers)) err(`層数 ${layers} は選べません（2・4・6層）`);
  else {
    if (!FAB_OPTIONS.thicknessMm[layers].includes(fab.thicknessMm)) err(`${layers}層で板厚 ${fab.thicknessMm}mm は選べません`);
    if (!FAB_OPTIONS.stackup[layers].includes(fab.stackup)) err(`${layers}層で積層構成 ${fab.stackup || 'なし'} は選べません`);
  }
  if (layers >= 6 && /HASL/.test(fab.finish)) err('6層以上は HASL を選べません（ENIG）');
  if (fab.maskColor === fab.silkColor) err('レジストとシルクが同じ色です（文字が読めません）');
  if (fab.innerCopperOz === 2 && !(layers === 4 && fab.thicknessMm === 1.6 && fab.stackup === 'JLC2313' && fab.outerCopperOz === 2)) {
    warn('内層 2oz は 4層・板厚1.6mm・JLC2313・外層2oz の組み合わせでのみ選べます');
  }
  if (fab.viaProcess === 'untented') warn('ビアを覆わないと、近くのパッドとはんだでつながりやすくなります');
  return out;
}

/** 積層構成の説明（JLCPCB 公表の 1.6mm 構成。他の板厚は注文画面で確認） */
export function stackupText(layers, fab) {
  if (layers === 2) return `2層 FR-4 ${fab.thicknessMm}mm（銅 ${fab.outerCopperOz}oz）`;
  if (layers === 4 && fab.stackup === 'JLC7628' && fab.thicknessMm === 1.6) {
    return 'L1 銅35µm / PP 7628 0.2mm / L2 銅17.5µm / コア 1.065mm / L3 銅17.5µm / PP 7628 0.2mm / L4 銅35µm';
  }
  if (layers === 6 && fab.stackup === 'JLC2313' && fab.thicknessMm === 1.6) {
    return 'L1 35µm / PP 2313 0.1 / L2 17.5µm / コア 0.565 / L3 17.5µm / PP 2116 0.127 / L4 17.5µm / コア 0.565 / L5 17.5µm / PP 2313 0.1 / L6 35µm（mm）';
  }
  return `${layers}層 ${fab.stackup} ${fab.thicknessMm}mm（各層の厚さは JLCPCB の積層構成表で確認）`;
}

/** 注文フォームに写すための一覧（日本語の説明＋JLCPCB の項目名） */
export function orderSheet({ layers, fab, board, files, holes, minTrack, minDrill, smdParts }) {
  const L = LABELS;
  const rows = [
    ['Base Material', 'FR-4', '基材'],
    ['Layers', String(layers), '層数'],
    ['Dimensions', `${board.w.toFixed(2)} x ${board.h.toFixed(2)} mm`, '外形寸法'],
    ['PCB Thickness', `${fab.thicknessMm} mm`, '板厚'],
    ...(layers >= 4 ? [['Impedance Control / Layer Stackup', fab.stackup, '積層構成'], ['Inner Copper Weight', `${fab.innerCopperOz} oz`, '内層銅厚']] : []),
    ['Outer Copper Weight', `${fab.outerCopperOz} oz`, '外層銅厚'],
    ['PCB Color', fab.maskColor, `レジスト色（${L.maskColor[fab.maskColor]}）`],
    ['Silkscreen', fab.silkColor, `シルク色（${L.silkColor[fab.silkColor]}）`],
    ['Surface Finish', fab.finish, L.finish[fab.finish]],
    ['Via Covering', { tented: 'Tented', untented: 'Untented', plugged: 'Plugged', epoxyFilled: 'Epoxy Filled & Capped' }[fab.viaProcess], L.viaProcess[fab.viaProcess]],
    ['Min via hole / trace', `${minDrill ? minDrill.toFixed(2) : '-'} mm / ${minTrack ? minTrack.toFixed(3) : '-'} mm`, '最小穴径・最小配線幅（確認用）'],
    ['Holes', String(holes), '穴の数（確認用）'],
    ['Assembly (SMD parts)', String(smdParts), '実装部品数（PCBA を頼む場合）'],
  ];
  const text = [
    `Pocket EDA 製造仕様（JLCPCB 注文フォーム用）`,
    ...rows.map(([k, v, j]) => `${k}: ${v}    # ${j}`),
    `Stackup detail: ${stackupText(layers, fab)}`,
    `Gerber files: ${files.join(', ')}`,
    layers >= 4 ? `Layer order: GTL(L1) / ${Array.from({ length: layers - 2 }, (_, i) => `G${i + 1}(L${i + 2})`).join(' / ')} / GBL(L${layers})` : '',
  ].filter(Boolean).join('\n');
  return { rows, text };
}
