// ERC（電気的ルール検査）。回路図の接続（connectivity.js）とピンの電気的属性から検査する。
// 結果の各項目: { level:'error'|'warning', rule, message, refs:[部品番号], at:{x,y} シート座標 | null }
// 「検査した項目」と「検査していない項目」を結果に必ず含める（未実装の検査を検査済みと表示しないため）。

import { computeConnectivity, pinPositions, cmpRef } from '../schematic/connectivity.js';
import { getSymbol, kindInfo } from '../schematic/symbols.js';
import { onSegment, samePt } from '../schematic/geom.js';
import { effectivePinMap } from '../library/parts.js';
import { componentFootprint, sourceHash } from '../netlist/netlist.js';

export const ERC_RULES = [
  { id: 'ref_format', label: '部品番号の形式（英字＋数字、未採番「?」）' },
  { id: 'ref_duplicate', label: '部品番号の重複' },
  { id: 'pin_unconnected', label: '未接続ピン（未使用ピン指定・NCピンを除く）' },
  { id: 'nc_connected', label: '未使用（NC）指定のピンが他のピンと接続されている' },
  { id: 'single_pin_net', label: 'ピンが1つだけのネット（配線の先がどこにもつながっていない）' },
  { id: 'power_in_undriven', label: '電源入力ピンに電源（電源記号・電源出力ピン）がつながっていない' },
  { id: 'output_conflict', label: '出力ピン同士・電源出力ピン同士の衝突' },
  { id: 'input_undriven', label: '入力ピンだけのネット（信号を出す側がない）' },
  { id: 'power_name_mismatch', label: '電源ピン名とネットの食い違い（GNDピンが電源に、VCCピンがGNDに）' },
  { id: 'net_name_conflict', label: '1つのネットに異なるネット名・電源名' },
  { id: 'power_short', label: '異なる電源記号どうしの短絡（例: +5V と GND が同じネット）' },
  { id: 'dangling_label', label: '配線・ピンに接していないネットラベル' },
  { id: 'power_symbol_unconnected', label: '何にも接続されていない電源記号' },
  { id: 'wire_dangling', label: '配線の端が何にも接続されていない' },
];

export const ERC_UNCHECKED = [
  '階層シート・複数シート（現在は1シートのみ対応）',
  '汎用IC・コネクタのピン属性（部品データにピン属性が無いため「双方向」として扱い、入出力の衝突は検査できません）',
  '電源の供給元の妥当性（電源記号を置いたネットは供給されているとみなします。実際にコネクタやレギュレータから供給されるかは見ていません）',
  '電圧レベル・電流容量・部品定数の妥当性',
  'オープンコレクタ出力のプルアップ抵抗の有無',
];

const GND_RE = /^(A|D|P|S)?GND\d*$|^VSS[A-Z]*$|^0V$/i;
const SUPPLY_PIN_RE = /^(VCC|VDD|AVDD|DVDD|VDDA|VDDIO|VIN|V\+|VBAT|VBUS|3V3|5V|\+3V3|\+5V)$/i;
const GND_PIN_RE = /^(GND|AGND|DGND|PGND|VSS|VSSA|EP|PAD|V-)$/i;
const isGndName = (n) => GND_RE.test(String(n).trim());

const DRIVER_TYPES = new Set(['output', 'bidirectional', 'passive', 'power_out', 'open_collector']);

/**
 * @returns {{ ranAt, sourceHash, issues, checked, unchecked, summary }}
 */
export function runErc(project, { now = new Date().toISOString() } = {}) {
  const sheet = project.schematic.sheets[0];
  const issues = [];
  const add = (level, rule, message, refs = [], at = null) => issues.push({ level, rule, message, refs, at });

  const conn = computeConnectivity(sheet);
  const pins = pinPositions(sheet);
  const pinAt = new Map(pins.map((p) => [`${p.compId}:${p.pin}`, p]));
  const partsById = new Map((project.library?.parts || []).map((p) => [p.id, p]));
  const comps = sheet.components.filter((c) => !kindInfo(c.kind)?.power);

  // 未使用ピン指定（部品データの pinMap で空、または NC 属性のピン）
  const ncPins = new Set();
  for (const c of comps) {
    const sym = getSymbol(c);
    sym.pins.forEach((p) => { if (p.type === 'nc') ncPins.add(`${c.id}:${p.num}`); });
    const part = c.props?.partId ? partsById.get(c.props.partId) : null;
    if (part?.pinMap) {
      const pm = effectivePinMap(sym, componentFootprint(c, part), part.pinMap);
      pm.nc.forEach((num) => ncPins.add(`${c.id}:${num}`));
    }
  }

  // ---- 部品番号 ----
  const seen = new Map();
  for (const c of [...comps].sort((a, b) => cmpRef(a.ref, b.ref))) {
    const at = { x: c.x, y: c.y };
    if (/\?/.test(c.ref)) add('error', 'ref_format', `${c.ref}: 部品番号が採番されていません`, [c.ref], at);
    else if (!/^[A-Z]+\d+$/.test(c.ref)) add('error', 'ref_format', `${c.ref}: 部品番号が「英字＋数字」になっていません`, [c.ref], at);
    if (seen.has(c.ref)) add('error', 'ref_duplicate', `${c.ref}: 部品番号が重複しています`, [c.ref], at);
    seen.set(c.ref, c);
  }

  // ---- 未接続ピン・電源記号 ----
  for (const p of conn.unconnectedPins) {
    if (p.isPower) { add('warning', 'power_symbol_unconnected', `電源記号 ${pinAt.get(`${p.compId}:${p.pin}`)?.name || ''} が何にも接続されていません`, [], { x: p.x, y: p.y }); continue; }
    if (ncPins.has(`${p.compId}:${p.pin}`)) continue;
    const info = pinAt.get(`${p.compId}:${p.pin}`);
    const nm = info?.name && info.name !== '~' && info.name !== p.pin ? `(${info.name})` : '';
    const lvl = info && (info.type === 'input' || info.type === 'power_in') ? 'error' : 'warning';
    add(lvl, 'pin_unconnected', `${p.ref}.${p.pin}${nm} が未接続です${lvl === 'error' ? '（入力・電源ピンは開放にしないでください）' : ''}`, [p.ref], { x: p.x, y: p.y });
  }
  const unconnected = new Set(conn.unconnectedPins.map((p) => `${p.compId}:${p.pin}`));

  // ---- ネットごとの検査 ----
  for (const n of conn.nets) {
    const first = n.pins[0] ? pinAt.get(`${n.pins[0].compId}:${n.pins[0].pin}`) : null;
    const at = first ? { x: first.x, y: first.y } : null;
    const refs = [...new Set(n.pins.map((p) => p.ref))];
    const pinTxt = (p) => `${p.ref}.${p.pin}${p.name && p.name !== '~' && p.name !== p.pin ? `(${p.name})` : ''}`;

    if (n.conflictingNames) {
      const pw = n.powerNames || [];
      if (pw.length > 1) add('error', 'power_short', `異なる電源 ${pw.join(' と ')} が同じネットでつながっています（短絡）`, refs, at);
      else add('error', 'net_name_conflict', `1つのネットに複数の名前があります: ${n.conflictingNames.join(' / ')}`, refs, at);
    }

    // NC 指定ピンの接続
    for (const p of n.pins) {
      if (!ncPins.has(`${p.compId}:${p.pin}`)) continue;
      if (n.pins.length > 1 || n.named) add('warning', 'nc_connected', `${pinTxt(p)} は未使用（NC）指定ですが、ネット ${n.name} に接続されています`, [p.ref], at);
    }

    const live = n.pins.filter((p) => !ncPins.has(`${p.compId}:${p.pin}`));
    // ピン1つだけのネット（物理的には何かに触れているが、相手がいない）
    if (live.length === 1 && !n.named && !unconnected.has(`${live[0].compId}:${live[0].pin}`)) {
      add('warning', 'single_pin_net', `${pinTxt(live[0])} の配線の先に、ほかのピンがありません`, [live[0].ref], at);
    }
    if (n.named && live.length === 1 && !(n.powerSymbols > 0)) {
      add('warning', 'single_pin_net', `ネット ${n.name} にはピンが1つしかありません（${pinTxt(live[0])}）。ラベル名の打ち間違いではありませんか`, [live[0].ref], at);
    }

    const types = live.map((p) => p.type);
    const hasPowerSym = (n.powerSymbols || 0) > 0;
    // 電源入力ピン
    const powerIns = live.filter((p) => p.type === 'power_in' && !unconnected.has(`${p.compId}:${p.pin}`)); // 未接続ピンは pin_unconnected で報告済み
    if (powerIns.length && !hasPowerSym && !types.includes('power_out')) {
      add('error', 'power_in_undriven', `電源入力 ${powerIns.map(pinTxt).join(', ')} に電源がつながっていません（電源記号を置くか、電源出力ピンにつないでください）`, refs, at);
    }
    // 出力の衝突
    const outs = live.filter((p) => p.type === 'output');
    const pouts = live.filter((p) => p.type === 'power_out');
    if (outs.length >= 2) add('error', 'output_conflict', `出力ピンどうしがつながっています: ${outs.map(pinTxt).join(', ')}`, refs, at);
    if (outs.length && pouts.length) add('error', 'output_conflict', `出力ピンと電源出力ピンがつながっています: ${[...outs, ...pouts].map(pinTxt).join(', ')}`, refs, at);
    if (pouts.length >= 2) add('error', 'output_conflict', `電源出力ピンどうしがつながっています: ${pouts.map(pinTxt).join(', ')}`, refs, at);
    // 入力だけのネット
    if (live.length >= 2 && types.every((t) => t === 'input') && !hasPowerSym) {
      add('warning', 'input_undriven', `入力ピンだけがつながっていて、信号を出す側がありません: ${live.map(pinTxt).join(', ')}`, refs, at);
    }
    // 電源ピン名の食い違い
    const netIsGnd = (n.powerNames?.length ? n.powerNames : (n.named ? [n.name] : [])).some(isGndName);
    const netIsSupply = (n.powerNames || []).some((x) => !isGndName(x));
    for (const p of live) {
      const nm = String(p.name || '').trim();
      if (netIsGnd && SUPPLY_PIN_RE.test(nm)) add('warning', 'power_name_mismatch', `${pinTxt(p)} は電源ピンの名前ですが、GND（${n.name}）につながっています`, [p.ref], at);
      if (netIsSupply && !netIsGnd && GND_PIN_RE.test(nm)) add('warning', 'power_name_mismatch', `${pinTxt(p)} はGNDピンの名前ですが、電源 ${n.name} につながっています`, [p.ref], at);
    }
  }

  // ---- ラベル ----
  const labelsById = new Map((sheet.labels || []).map((l) => [l.id, l]));
  for (const id of conn.danglingLabels) {
    const l = labelsById.get(id);
    add('warning', 'dangling_label', `ネットラベル「${l?.name || ''}」が配線にもピンにも接していません`, [], l ? { x: l.x, y: l.y } : null);
  }

  // ---- 配線の浮いた端 ----
  const wires = sheet.wires.filter((w) => !samePt(w.a, w.b));
  const points = [...pins.map((p) => ({ x: p.x, y: p.y })), ...(sheet.labels || []).map((l) => ({ x: l.x, y: l.y }))];
  let dangling = 0;
  for (const w of wires) {
    for (const e of [w.a, w.b]) {
      const touches = points.some((q) => samePt(q, e)) || wires.some((v) => v !== w && onSegment(e, v.a, v.b));
      if (!touches) {
        dangling++;
        if (dangling <= 50) add('warning', 'wire_dangling', `配線の端 (${e.x}, ${e.y}) が何にも接続されていません`, [], { x: e.x, y: e.y });
      }
    }
  }
  if (dangling > 50) add('warning', 'wire_dangling', `ほかに配線の浮いた端が ${dangling - 50} か所あります`, [], null);

  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return {
    kind: 'erc',
    ranAt: now,
    sourceHash: sourceHash(project),
    issues,
    checked: ERC_RULES.map((r) => ({ ...r, count: issues.filter((i) => i.rule === r.id).length })),
    unchecked: ERC_UNCHECKED,
    summary: { errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warning').length, components: comps.length, nets: conn.nets.length },
  };
}

/** 保存済みERC結果が回路図の現状と一致するか */
export function ercStatus(project) {
  const r = project.checks?.erc;
  if (!r) return 'none';
  return r.sourceHash === sourceHash(project) ? 'current' : 'stale';
}
