// ネットリスト生成エンジン
// 回路図の電気的接続（connectivity.js）と、部品ごとのピン↔パッド対応から、
// 「どの部品のどのパッドがどのネットにつながるか」を作る。PCBエディタはこれを読み込む。
// 電源記号・GND記号は部品ではないので出力しない（ネット名にだけ反映）。

import { computeConnectivity, cmpRef } from '../schematic/connectivity.js';
import { getSymbol, kindInfo } from '../schematic/symbols.js';
import { getFootprint } from '../library/footprints.js';
import { effectivePinMap, checkPinMap, partFootprint } from '../library/parts.js';

export const NETLIST_FORMAT = 'pocket-eda-netlist';

/** 文字列の FNV-1a ハッシュ（回路図が変わったかの判定用） */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** ネットリストの元になる情報（回路図と、使っている部品データ）のハッシュ */
export function sourceHash(project) {
  const sh = project.schematic;
  const ids = new Set(sh.sheets.flatMap((s) => s.components.map((c) => c.props?.partId).filter(Boolean)));
  const parts = (project.library?.parts || []).filter((p) => ids.has(p.id));
  return hash(JSON.stringify([sh, parts]));
}

/** 部品の実効フットプリント（部品データ優先 → 回路図の属性） */
export function componentFootprint(comp, part) {
  if (part) return partFootprint(part) || getFootprint(comp.props?.footprint);
  return getFootprint(comp.props?.footprint);
}

/**
 * @param project プロジェクト
 * @returns ネットリスト（problems に誤りと注意を含む。errors があっても生成はする）
 */
export function generateNetlist(project, { now = new Date().toISOString() } = {}) {
  const sheet = project.schematic.sheets[0];
  const partsById = new Map((project.library?.parts || []).map((p) => [p.id, p]));
  const problems = [];
  const err = (message, ref) => problems.push({ level: 'error', ref, message });
  const warn = (message, ref) => problems.push({ level: 'warning', ref, message });

  const conn = computeConnectivity(sheet);
  const comps = sheet.components.filter((c) => !kindInfo(c.kind)?.power && !kindInfo(c.kind)?.virtual);
  // シミュレーション用の信号源（交流・直流・電流源）は基板・BOM に載せず、別の一覧に入れる
  const virt = sheet.components.filter((c) => kindInfo(c.kind)?.virtual);

  // 部品番号の検査
  const seen = new Map();
  for (const c of [...comps, ...virt]) {
    if (!/^[A-Z]+\d+$/.test(c.ref)) err(`部品番号 ${c.ref} が「英字＋数字」になっていません`, c.ref);
    if (seen.has(c.ref)) err(`部品番号 ${c.ref} が重複しています`, c.ref);
    seen.set(c.ref, c);
  }

  // ピン → ネット名
  const pinNet = new Map();
  conn.nets.forEach((n) => n.pins.forEach((p) => pinNet.set(`${p.compId}:${p.pin}`, n.name)));

  const components = [];
  const padOf = new Map(); // compId:pin -> [pads]
  for (const c of comps.sort((a, b) => cmpRef(a.ref, b.ref))) {
    const part = c.props?.partId ? partsById.get(c.props.partId) : null;
    if (c.props?.partId && !part) warn(`${c.ref}: 部品データ ${c.props.partId} がプロジェクトにありません`, c.ref);
    const sym = getSymbol(c);
    const fp = componentFootprint(c, part);
    const pm = effectivePinMap(sym, fp, part?.pinMap || null);
    if (!fp) err(`${c.ref}: フットプリント「${part?.footprint?.id || part?.footprint || c.props?.footprint || '未設定'}」が見つかりません`, c.ref);
    else {
      const chk = checkPinMap(sym, fp, pm);
      chk.errors.forEach((m) => err(`${c.ref}: ${m}`, c.ref));
      if (fp.generated) warn(`${c.ref}: フットプリント「${fp.name}」はパッケージ名から自動生成した推定です。データシートの推奨ランドと照合してください`, c.ref);
      else if (!fp.verified) warn(`${c.ref}: フットプリント ${fp.id} の寸法は KiCad 公式データと未照合です（データシートの推奨ランドで確認）`, c.ref);
    }
    if (!c.props?.dnp && !(part?.lcsc || c.props?.lcsc)) warn(`${c.ref}: LCSC品番が未設定です（JLCPCBで実装するには必要）`, c.ref);
    if (part && !part.lcscVerified && part.lcsc) warn(`${c.ref}: LCSC品番 ${part.lcsc} は未確認です`, c.ref);
    const pins = sym.pins.map((p) => {
      const pads = pm.map[p.num] || [];
      padOf.set(`${c.id}:${p.num}`, pads);
      return { num: p.num, name: p.name, type: p.type, pads, net: pinNet.get(`${c.id}:${p.num}`) || null, nc: pm.nc.has(p.num) };
    });
    components.push({
      ref: c.ref, compId: c.id, kind: c.kind, value: c.props?.value ?? '',
      footprint: fp?.id || null, footprintVerified: !!fp?.verified, footprintGenerated: !!fp?.generated,
      lcsc: part?.lcsc || c.props?.lcsc || '', mpn: part?.mpn || c.props?.mpn || '', manufacturer: part?.manufacturer || c.props?.manufacturer || '',
      partId: part?.id || null, dnp: !!c.props?.dnp, pins,
    });
  }

  const simSources = virt.sort((a, b) => cmpRef(a.ref, b.ref)).map((c) => ({
    ref: c.ref, compId: c.id, kind: c.kind, value: c.props?.value ?? '',
    pins: getSymbol(c).pins.map((p) => ({ num: p.num, name: p.name, net: pinNet.get(`${c.id}:${p.num}`) || null })),
  }));

  // ネット（パッド単位のノード）
  const nets = [];
  let code = 1;
  for (const n of conn.nets) {
    const nodes = [];
    for (const p of n.pins) {
      const pads = padOf.get(`${p.compId}:${p.pin}`) || [];
      for (const pad of pads) nodes.push({ ref: p.ref, pin: p.pin, pad });
    }
    if (n.conflictingNames) err(`ネット名が衝突しています: ${n.conflictingNames.join(' / ')}（${n.conflictingNames[0]} を採用）`);
    if (n.pins.length === 1 && !n.named) continue; // 1ピンだけの無名ネットは「未接続ピン」として下で報告
    if (n.pins.length === 1 && n.named) warn(`ネット ${n.name} にはピンが1つしかありません（${n.pins[0].ref}.${n.pins[0].pin}）`);
    if (!n.pins.length) { warn(`ネット ${n.name} にはピンがありません`); continue; }
    nodes.sort((a, b) => cmpRef(a.ref, b.ref) || cmpRef(a.pad, b.pad));
    nets.push({ code: code++, name: n.name, nodes });
  }

  // 未接続ピン（NC指定のピンは除く）
  for (const p of conn.unconnectedPins) {
    if (p.isPower) { warn(`電源記号が何にも接続されていません`); continue; }
    const c = components.find((x) => x.ref === p.ref);
    const pin = c?.pins.find((x) => x.num === p.pin);
    if (pin?.nc) continue;
    warn(`${p.ref}.${p.pin}${pin?.name && pin.name !== '~' ? `(${pin.name})` : ''} が未接続です`, p.ref);
  }
  if (conn.danglingLabels.length) warn(`配線・ピンに接していないネットラベルが${conn.danglingLabels.length}個あります`);
  if (!components.length) warn('部品がありません');

  return {
    format: NETLIST_FORMAT,
    version: 1,
    generatedAt: now,
    sourceHash: sourceHash(project),
    components,
    simSources,
    nets,
    problems,
    summary: {
      components: components.length,
      nets: nets.length,
      errors: problems.filter((p) => p.level === 'error').length,
      warnings: problems.filter((p) => p.level === 'warning').length,
    },
  };
}

/** 保存済みネットリストが回路図の現状と一致するか */
export function netlistStatus(project) {
  const nl = project.netlist;
  if (!nl) return 'none';
  return nl.sourceHash === sourceHash(project) ? 'current' : 'stale';
}

/** 人が読むテキスト形式 */
export function formatNetlistText(nl) {
  const lines = [`# Pocket EDA netlist  ${nl.generatedAt}`, '', '## Components'];
  for (const c of nl.components) {
    lines.push(`${c.ref}\t${c.value}\t${c.footprint || '-'}\t${c.lcsc || '-'}${c.dnp ? '\tDNP' : ''}`);
  }
  lines.push('', '## Nets');
  for (const n of nl.nets) lines.push(`${n.code}\t${n.name}\t${n.nodes.map((x) => `${x.ref}-${x.pad}`).join(' ')}`);
  if (nl.problems.length) {
    lines.push('', '## Problems');
    for (const p of nl.problems) lines.push(`${p.level === 'error' ? 'ERROR' : 'WARN '}\t${p.message}`);
  }
  return lines.join('\n') + '\n';
}
