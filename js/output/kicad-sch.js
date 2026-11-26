// KiCad 形式の回路図・シンボルライブラリの書き出し（KiCad 7 の形式。回路図 20230121・シンボル 20220914）
// 座標: Pocket EDA の回路図の 1 単位 = 1.27mm（0.05 インチ）は KiCad の回路図の格子と同じなので、×1.27 でそのまま置ける。
// シンボル: 部品ごとに Pocket EDA のシンボル（線・四角・円・パス・文字）をそのまま KiCad のシンボルにする。
//   ライブラリの中は y 上向き（Pocket EDA は y 下向き）なので y を反転する。
//   ピン番号はフットプリントのパッド番号にする（Pocket EDA のピン↔パッド対応表をあてる）。
//   1 つのピンが複数のパッドにつながるとき（USB-C の GND など）は同じ位置にピンを重ねる（KiCad の「積み重ねピン」）。
//   パッドの無いピン（未使用指定）は種類「未接続」にして、回路図に未接続マークを置く。番号はピン番号のまま
//   （その番号のパッドが他のピンに使われているときだけ NC_<ピン番号>）。
// 電源記号: ネットごとに KiCad の電源シンボル（power・見えない power_in ピン。ピン名と値がネット名）。
// ネットラベル: Pocket EDA のネットラベルはシート内で同名どうしがつながる → KiCad のローカルラベル（1 シートなので同じ）。

import { numFmt, q, uuidFrom } from './sexpr.js';
import { getSymbol, kindInfo } from '../schematic/symbols.js';
import { xform } from '../schematic/geom.js';
import { generateNetlist } from '../netlist/netlist.js';
import { cmpRef } from '../schematic/connectivity.js';
import { getFootprint } from '../library/footprints.js';

export const KICAD_SCH_VERSION = 20230121;
export const KICAD_SYM_VERSION = 20220914;
export const SYM_LIB = 'PocketEDA';

const UNIT = 1.27;
const n = numFmt(4);
const mm = (u) => n(u * UNIT);


const PIN_TYPE = { passive: 'passive', input: 'input', output: 'output', bidirectional: 'bidirectional', power_in: 'power_in', power_out: 'power_out', open_collector: 'open_collector', nc: 'no_connect' };
const BASE_NAME = {
  resistor: 'R', pot: 'R_Pot', capacitor: 'C', electrolytic: 'C_Polarized', inductor: 'L', diode: 'D', led: 'LED', zener: 'D_Zener',
  npn: 'Q_NPN', pnp: 'Q_PNP', nmos: 'Q_NMOS', pmos: 'Q_PMOS', opamp: 'OpAmp', switch: 'SW_Push', battery: 'Battery',
};
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_+.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'X';

// ---------------- SVG パス → 折れ線 ----------------
/** M/L/H/V/Q/C/A/Z（大文字・小文字）を折れ線の配列にする（ローカル座標） */
export function flattenPath(d) {
  const tok = String(d).match(/[MmLlHhVvQqCcAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const num = () => Number(tok[i++]);
  const isNum = () => i < tok.length && !/^[A-Za-z]$/.test(tok[i]);
  const start = (px, py) => { cur = [{ x: px, y: py }]; polys.push(cur); };
  const to = (px, py) => { if (!cur) start(x, y); cur.push({ x: px, y: py }); };
  while (i < tok.length) {
    if (/^[A-Za-z]$/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') { if (cur) { cur.push({ x: sx, y: sy }); x = sx; y = sy; } cur = null; continue; }
    if (!isNum()) break;
    if (C === 'M') { x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); sx = x; sy = y; start(x, y); cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); to(x, y); }
    else if (C === 'H') { x = (rel ? x : 0) + num(); to(x, y); }
    else if (C === 'V') { y = (rel ? y : 0) + num(); to(x, y); }
    else if (C === 'Q') {
      const cx = (rel ? x : 0) + num(), cy = (rel ? y : 0) + num(), ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
      const x0 = x, y0 = y;
      for (let k = 1; k <= 8; k++) { const t = k / 8, a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t; to(a * x0 + b * cx + c * ex, a * y0 + b * cy + c * ey); }
      x = ex; y = ey;
    } else if (C === 'C') {
      const c1x = (rel ? x : 0) + num(), c1y = (rel ? y : 0) + num(), c2x = (rel ? x : 0) + num(), c2y = (rel ? y : 0) + num(), ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
      const x0 = x, y0 = y;
      for (let k = 1; k <= 10; k++) { const t = k / 10, u = 1 - t; to(u ** 3 * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * ex, u ** 3 * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * ey); }
      x = ex; y = ey;
    } else if (C === 'A') {
      const rx = Math.abs(num()), ry = Math.abs(num()), rotDeg = num(), large = num(), sweep = num();
      const ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
      for (const p of arcPoints(x, y, rx, ry, rotDeg, large, sweep, ex, ey)) to(p.x, p.y);
      x = ex; y = ey;
    } else break;
  }
  return polys.filter((p) => p.length >= 2);
}

/** SVG の楕円弧（端点表現）→ 点列（SVG 仕様の F.6 の変換） */
function arcPoints(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2) {
  if (!rx || !ry) return [{ x: x2, y: y2 }];
  const phi = (rotDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cs * dx + sn * dy, y1p = -sn * dx + cs * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (Number(large) === Number(sweep)) k = -k;
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2, cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!Number(sweep) && dt > 0) dt -= 2 * Math.PI;
  if (Number(sweep) && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (dt * s) / steps;
    out.push({ x: cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, y: cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs });
  }
  out[out.length - 1] = { x: x2, y: y2 };
  return out;
}

// ---------------- シンボル ----------------
const STROKE = '(stroke (width 0) (type default))';
const fill = (f) => `(fill (type ${f ? 'outline' : 'none'}))`;
/** ローカル（y 下向き・単位）→ ライブラリ（y 上向き・mm） */
const lx = (x) => mm(x), ly = (y) => mm(-y);

/** シンボルの絵（ピンの線を除いたもの）とピン */
function symbolBody(sym, pins, { power = false } = {}) {
  const used = new Set();
  const pinLines = [];
  const atPos = new Map(); // 積み重ねピンは同じ長さ・向き
  // ピン先端から伸びる線（軸に平行）をピンの長さにする
  for (const p of pins) {
    const pk = `${p.x},${p.y}`;
    if (atPos.has(pk)) { pinLines.push({ ...p, ...atPos.get(pk) }); continue; }
    let len = 0, ang = p.x < 0 ? 0 : p.x > 0 ? 180 : p.y < 0 ? 270 : 90;
    const gi = sym.graphics.findIndex((g, k) => !used.has(k) && g.t === 'line' &&
      ((g.x1 === p.x && g.y1 === p.y) || (g.x2 === p.x && g.y2 === p.y)) && (g.x1 === g.x2 || g.y1 === g.y2));
    if (gi >= 0) {
      const g = sym.graphics[gi];
      const o = g.x1 === p.x && g.y1 === p.y ? { x: g.x2, y: g.y2 } : { x: g.x1, y: g.y1 };
      const dx = o.x - p.x, dy = -(o.y - p.y);
      len = Math.hypot(dx, dy);
      ang = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
      used.add(gi);
    }
    atPos.set(pk, { len, ang });
    pinLines.push({ ...p, len, ang });
  }
  const g = [];
  sym.graphics.forEach((e, k) => {
    if (used.has(k)) return;
    if (e.t === 'line') g.push(`      (polyline (pts (xy ${lx(e.x1)} ${ly(e.y1)}) (xy ${lx(e.x2)} ${ly(e.y2)})) ${STROKE} ${fill(false)})`);
    else if (e.t === 'rect') g.push(`      (rectangle (start ${lx(e.x0)} ${ly(e.y0)}) (end ${lx(e.x1)} ${ly(e.y1)}) ${STROKE} ${fill(e.fill)})`);
    else if (e.t === 'circle') g.push(`      (circle (center ${lx(e.cx)} ${ly(e.cy)}) (radius ${mm(e.r)}) ${STROKE} ${fill(e.fill)})`);
    else if (e.t === 'path') {
      for (const poly of flattenPath(e.d)) g.push(`      (polyline (pts ${poly.map((p) => `(xy ${lx(p.x)} ${ly(p.y)})`).join(' ')}) ${STROKE} ${fill(e.fill)})`);
    } else if (e.t === 'text') {
      if (power) return; // 電源記号のネット名は「値」で見せる
      const just = e.anchor === 'start' ? ' (justify left)' : e.anchor === 'end' ? ' (justify right)' : '';
      const size = n(Math.max(0.8, (e.size || 1) * UNIT * 0.9));
      // Pocket EDA の文字の y はベースライン → KiCad は中心
      g.push(`      (text ${q(e.text === '−' ? '-' : e.text)} (at ${lx(e.x)} ${ly(e.y - (e.size || 1) * 0.35)} 0) (effects (font (size ${size} ${size}))${just}))`);
    }
  });
  const pinTxt = pinLines.map((p) => `      (pin ${p.type} line (at ${lx(p.x)} ${ly(p.y)} ${p.ang}) (length ${mm(p.len)})${p.hide ? ' hide' : ''}
        (name ${q(p.name || '~')} (effects (font (size 1.27 1.27))))
        (number ${q(p.number)} (effects (font (size 1.27 1.27))))
      )`);
  return { graphics: g, pins: pinTxt };
}

/**
 * 部品 → KiCad のピン（パッド番号・積み重ね・未接続）
 * @param fpPads フットプリントのパッド番号の Set（無ければ null）
 */
function kicadPins(sym, nlComp, fpPads = null) {
  const out = [];
  const usedPads = new Set((nlComp?.pins || []).flatMap((x) => x.pads || []));
  for (const sp of sym.pins) {
    const info = nlComp?.pins.find((x) => x.num === sp.num);
    const pads = info?.pads?.length ? info.pads : null;
    const type = PIN_TYPE[sp.type] || 'passive';
    const name = sp.name && sp.name !== '~' ? sp.name : '~';
    if (!pads) {
      // 未使用のピン: 同じ番号のパッドが他のピンに使われていなければ、番号はそのまま（パッドも未接続のまま）
      const keep = !usedPads.has(sp.num);
      out.push({ x: sp.x, y: sp.y, number: keep ? sp.num : `NC_${sp.num}`, name, type: 'no_connect', nc: true, onPad: keep && !!fpPads?.has(sp.num), pinNum: sp.num });
      continue;
    }
    pads.forEach((pad, k) => out.push({ x: sp.x, y: sp.y, number: pad, name, type: k ? 'passive' : type, stacked: k > 0, hide: k > 0, pinNum: sp.num }));
  }
  return out;
}

/** 1 つのシンボル定義（名前なしの本文。重複を見分けるのに使う） */
function symbolDef(name, comp, sym, nlComp, fpPads) {
  const power = !!sym.isPower;
  const pins = power
    ? [{ x: 0, y: 0, number: '1', name: comp.props?.net || 'GND', type: 'power_in', hide: true }]
    : kicadPins(sym, nlComp, fpPads);
  const body = symbolBody(sym, pins, { power });
  const ref = power ? '#PWR' : (kindInfo(comp.kind)?.prefix || 'U');
  const showNums = !power && !!sym.showPinNumbers;
  const lines = [];
  lines.push(`  (symbol ${q(name)}${power ? ' (power)' : ''}${showNums ? '' : ' (pin_numbers hide)'} (pin_names (offset 0.254) hide) (in_bom ${power ? 'no' : 'yes'}) (on_board ${power ? 'no' : 'yes'})`);
  lines.push(`    (property "Reference" ${q(ref)} (id 0) (at 0 ${mm(-(sym.bbox.y0) + 1)} 0) (effects (font (size 1.27 1.27))${power ? ' hide' : ''}))`);
  lines.push(`    (property "Value" ${q(power ? comp.props?.net || 'GND' : name)} (id 1) (at 0 ${mm(-(sym.bbox.y1) - 1)} 0) (effects (font (size 1.27 1.27))))`);
  lines.push(`    (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`);
  lines.push(`    (property "Datasheet" "" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`);
  lines.push(`    (symbol ${q(`${name}_0_1`)}`);
  lines.push(...body.graphics);
  lines.push('    )');
  lines.push(`    (symbol ${q(`${name}_1_1`)}`);
  lines.push(...body.pins);
  lines.push('    )');
  lines.push('  )');
  return lines.join('\n');
}

/**
 * 回路図の部品 → シンボル（同じ形・同じピン番号のものは 1 つにまとめる）
 * @returns { symbols: Map(名前 → 本文), byComp: Map(部品 id → { name, pins }) }
 */
export function buildSymbols(project, nl = generateNetlist(project)) {
  const sheet = project.schematic.sheets[0];
  const nlByRef = new Map(nl.components.map((c) => [c.compId, c]));
  const symbols = new Map(), keyToName = new Map(), byComp = new Map();
  const fpOf = new Map((project.pcb?.footprints || []).filter((f) => f.compId).map((f) => [f.compId, f.fpDef]));
  for (const c of sheet.components) {
    const sym = getSymbol(c);
    const nlComp = nlByRef.get(c.id);
    const fpDef = fpOf.get(c.id) || (nlComp?.footprint ? getFootprint(nlComp.footprint) : null);
    const fpPads = fpDef ? new Set(fpDef.pads.map((p) => p.num)) : null;
    let base;
    if (sym.isPower) base = `PWR_${safe(c.props?.net || 'GND')}`;
    else if (c.kind === 'ic') base = `IC_${safe(c.props?.value || c.ref)}`;
    else if (c.kind === 'connector') base = `Conn_${safe(c.props?.value || c.ref)}`;
    else base = BASE_NAME[c.kind] || safe(c.kind);
    const body = symbolDef('@', c, sym, nlComp, fpPads);
    let name = keyToName.get(body);
    if (!name) {
      name = base;
      for (let k = 2; symbols.has(name); k++) name = `${base}_${k}`;
      keyToName.set(body, name);
      symbols.set(name, symbolDef(name, c, sym, nlComp, fpPads));
    }
    byComp.set(c.id, { name, pins: sym.isPower ? [{ x: 0, y: 0, number: '1' }] : kicadPins(sym, nlComp, fpPads), sym, nlComp });
  }
  return { symbols, byComp, nl };
}

/** .kicad_sym（シンボルライブラリ） */
export function kicadSymLib(built) {
  const L = [`(kicad_symbol_lib (version ${KICAD_SYM_VERSION}) (generator pocket_eda)`];
  for (const body of built.symbols.values()) L.push(body);
  L.push(')');
  return L.join('\n') + '\n';
}

// ---------------- KiCad が回路図から付けるネット名 ----------------
// 基板のネット名を KiCad と同じにしておくと、KiCad の DRC の「回路図と PCB の整合」と「回路図から PCB を更新」で差が出ない。
// KiCad 7.0.11 の kicad-cli で確かめた規則:
//  - 電源記号のネット: ネット名そのまま（+3V3・GND）
//  - ネットラベルのネット: 先頭に / （ルートシートのローカルラベル）
//  - 名前の無いネット: ピンの候補「Net-(<部品番号>-<ピン名>)」（ピン名が無い・~ のときは「-Pad<番号>」）から、
//    受動（passive）以外のピンを優先し、同じ扱いの中では文字列として小さいもの
//  - 1 つのピンだけのネット: 「unconnected-(<部品番号>-<ピン名>-Pad<番号>)」（ピン名が無ければ「-Pad<番号>」だけ）
const escNet = (s) => String(s).replace(/\//g, '{slash}');

/**
 * @returns { byNet: Map(Pocket EDA のネット名 → KiCad のネット名), byPad: Map('部品番号:パッド' → KiCad のネット名) }
 */
export function kicadNetNames(project, built) {
  const nl = built.nl;
  const byNet = new Map(), byPad = new Map();
  const sheet = project.schematic.sheets[0];
  const labelNames = new Set((sheet.labels || []).map((l) => l.name.trim()));
  // パッド → (部品, KiCad のピン)
  const pinOfPad = new Map();
  for (const c of sheet.components) {
    const info = built.byComp.get(c.id);
    if (info.sym.isPower) continue;
    for (const p of info.pins) if (!p.nc || p.onPad) pinOfPad.set(`${c.ref}:${p.number}`, p);
  }
  for (const net of nl.nets) {
    let name;
    const conn = net; // { name, nodes: [{ ref, pin, pad }] }
    const powerNames = new Set(sheet.components.filter((c) => getSymbol(c).isPower).map((c) => c.props?.net || 'GND'));
    if (powerNames.has(conn.name)) name = conn.name;
    else if (labelNames.has(conn.name)) name = `/${escNet(conn.name)}`;
    else {
      const cands = conn.nodes.map((nd) => {
        const p = pinOfPad.get(`${nd.ref}:${nd.pad}`);
        if (!p) return null;
        const passive = p.type === 'passive';
        const nm = p.name && p.name !== '~' ? `Net-(${nd.ref}-${escNet(p.name)})` : `Net-(${nd.ref}-Pad${p.number})`;
        return { passive, nm };
      }).filter(Boolean);
      const act = cands.filter((x) => !x.passive);
      const pool = act.length ? act : cands;
      name = pool.map((x) => x.nm).sort()[0] || conn.name;
    }
    byNet.set(conn.name, name);
    for (const nd of conn.nodes) byPad.set(`${nd.ref}:${nd.pad}`, name);
  }
  // つながっていないピン（パッドあり）
  for (const [k, p] of pinOfPad) {
    if (byPad.has(k)) continue;
    const ref = k.slice(0, k.indexOf(':'));
    byPad.set(k, p.name && p.name !== '~' ? `unconnected-(${ref}-${escNet(p.name)}-Pad${p.number})` : `unconnected-(${ref}-Pad${p.number})`);
  }
  return { byNet, byPad };
}

// ---------------- 回路図 ----------------
const PAPERS = [['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841]];

/** Pocket EDA の回転（時計回り）・左右反転 → KiCad の角度（反時計回り）・mirror */
export function kicadOrient(comp) {
  const r = (((comp.rot || 0) % 360) + 360) % 360;
  // KiCad は「回転してから左右反転」、Pocket EDA は「左右反転してから回転」。反転ありでは回転の向きが逆になる
  // （KiCad 7.0.11 の kicad-cli のネットリストで全種類 × 回転 4 × 反転 2 のピン位置を確かめた）
  return { angle: comp.mirror ? r : (360 - r) % 360, mirror: !!comp.mirror };
}

/**
 * .kicad_sch の本文
 * @param opt { projectName, fpLibId(部品 id → 'PocketEDA:名前' か null), version }
 */
export function kicadSch(project, built, { projectName = 'board', fpLibId = () => '', version = '' } = {}) {
  const sheet = project.schematic.sheets[0];
  const rootUuid = uuidFrom(`${project.id}:root`);
  // 用紙: 全体が入る大きさ。左上に 25.4mm の余白をとって格子のまま平行移動する
  const pts = [];
  for (const c of sheet.components) {
    const b = built.byComp.get(c.id).sym.bbox;
    for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x1, b.y0]]) pts.push(xform({ x, y }, c));
  }
  for (const w of sheet.wires) pts.push(w.a, w.b);
  for (const l of sheet.labels || []) pts.push({ x: l.x, y: l.y }, { x: l.x + String(l.name).length * 0.8 + 1, y: l.y });
  const minX = Math.min(0, ...pts.map((p) => p.x)), minY = Math.min(0, ...pts.map((p) => p.y));
  const maxX = Math.max(1, ...pts.map((p) => p.x)), maxY = Math.max(1, ...pts.map((p) => p.y));
  const ox = 20 - Math.floor(minX) - 3, oy = 20 - Math.floor(minY) - 3; // 単位（20 単位 = 25.4mm の余白、部品番号の文字の分を少し足す）
  const wmm = (maxX - minX + 46) * UNIT, hmm = (maxY - minY + 46) * UNIT;
  // 横置きか縦置きで入る一番小さい用紙
  const paper = PAPERS.flatMap(([nm, w, h]) => [[nm, w, h, false], [nm, h, w, true]]).find(([, w, h]) => wmm <= w && hmm <= h);
  const X = (x) => mm(x + ox), Y = (y) => mm(y + oy);
  const L = [];
  L.push(`(kicad_sch (version ${KICAD_SCH_VERSION}) (generator pocket_eda)`);
  L.push('');
  L.push(`  (uuid ${rootUuid})`);
  L.push('');
  L.push(paper ? `  (paper ${q(paper[0])}${paper[3] ? ' portrait' : ''})` : `  (paper "User" ${n(Math.ceil(wmm))} ${n(Math.ceil(hmm))})`);
  L.push('');
  L.push(`  (title_block (title ${q(project.name)}) (comment 1 ${q(`Pocket EDA ${version} から書き出し`)}))`);
  L.push('');
  L.push('  (lib_symbols');
  for (const [name, body] of built.symbols) L.push(body.replace(`(symbol ${q(name)}`, `(symbol ${q(`${SYM_LIB}:${name}`)}`).replace(/^/gm, '  '));
  L.push('  )');
  L.push('');
  // 接続点（3 本以上が集まる点）
  for (const j of sheet.junctions || []) L.push(`  (junction (at ${X(j.x)} ${Y(j.y)}) (diameter 0) (color 0 0 0 0) (uuid ${uuidFrom(`${project.id}:j:${j.x},${j.y}`)}))`);
  // パッドの無いピンには未接続マーク
  for (const c of sheet.components) {
    for (const p of built.byComp.get(c.id).pins.filter((x) => x.nc)) {
      const at = xform(p, c);
      L.push(`  (no_connect (at ${X(at.x)} ${Y(at.y)}) (uuid ${uuidFrom(`${c.id}:nc:${p.number}`)}))`);
    }
  }
  L.push('');
  for (const w of sheet.wires) {
    if (w.a.x === w.b.x && w.a.y === w.b.y) continue;
    L.push(`  (wire (pts (xy ${X(w.a.x)} ${Y(w.a.y)}) (xy ${X(w.b.x)} ${Y(w.b.y)})) ${STROKE} (uuid ${uuidFrom(w.id)}))`);
  }
  L.push('');
  // ピンの先端に置いたラベルは、ピンの外向きに文字を出す（左側のピンなら左へ。部品の絵に重ならない）
  const outward = new Map();
  for (const c of sheet.components) {
    const sym = built.byComp.get(c.id).sym;
    if (sym.isPower) continue;
    const b = sym.bbox;
    for (const p of sym.pins) {
      const d = p.x <= b.x0 ? { x: -1, y: 0 } : p.x >= b.x1 ? { x: 1, y: 0 } : p.y <= b.y0 ? { x: 0, y: -1 } : { x: 0, y: 1 };
      const a = xform(p, c), e = xform({ x: p.x + d.x, y: p.y + d.y }, c);
      outward.set(`${a.x},${a.y}`, { x: e.x - a.x, y: e.y - a.y });
    }
  }
  for (const l of sheet.labels || []) {
    const o = outward.get(`${l.x},${l.y}`);
    // KiCad のラベルの角度: 0 右へ・90 上へ・180 左へ・270 下へ
    const ang = o ? (o.x > 0 ? 0 : o.x < 0 ? 180 : o.y < 0 ? 90 : 270) : (l.rot || 0) % 180 ? 90 : 0;
    const just = ang === 180 || ang === 270 ? 'right' : 'left';
    L.push(`  (label ${q(l.name)} (at ${X(l.x)} ${Y(l.y)} ${ang}) (fields_autoplaced) (effects (font (size 1.27 1.27)) (justify ${just} bottom)) (uuid ${uuidFrom(l.id)}))`);
  }
  L.push('');
  // 部品
  let pwr = 0;
  const comps = [...sheet.components].sort((a, b) => cmpRef(a.ref, b.ref));
  for (const c of comps) {
    const info = built.byComp.get(c.id);
    const sym = info.sym;
    const power = !!sym.isPower;
    const o = kicadOrient(c);
    const ref = power ? `#PWR${String(++pwr).padStart(3, '0')}` : c.ref;
    const uuid = uuidFrom(`${c.id}:sym`);
    const r = (() => { const ps = [[sym.bbox.x0, sym.bbox.y0], [sym.bbox.x1, sym.bbox.y1], [sym.bbox.x0, sym.bbox.y1], [sym.bbox.x1, sym.bbox.y0]].map(([x, y]) => xform({ x, y }, c)); return { x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)) }; })();
    // 部品番号・値の位置（Pocket EDA の表示と同じ考え方: 横長・ピン番号ありなら上下、縦長なら右）
    let refAt, valAt, just = '';
    if (power) { refAt = { x: c.x, y: r.y1 + 2 }; valAt = { x: c.x, y: sym.bbox.y0 < 0 ? r.y0 - 0.8 : r.y1 + 1.6 }; }
    else if (sym.showPinNumbers || r.x1 - r.x0 >= r.y1 - r.y0) { const cx = (r.x0 + r.x1) / 2; refAt = { x: cx, y: r.y0 - 1 }; valAt = { x: cx, y: r.y1 + 1 }; }
    else { const cy = (r.y0 + r.y1) / 2; refAt = { x: r.x1 + 0.6, y: cy - 0.8 }; valAt = { x: r.x1 + 0.6, y: cy + 0.8 }; just = ' (justify left)'; }
    const props = c.props || {};
    const nlc = info.nlComp;
    const fp = power ? '' : fpLibId(c.id) || '';
    L.push(`  (symbol (lib_id ${q(`${SYM_LIB}:${info.name}`)}) (at ${X(c.x)} ${Y(c.y)} ${o.angle})${o.mirror ? ' (mirror y)' : ''} (unit 1)`);
    L.push(`    (in_bom ${power ? 'no' : 'yes'}) (on_board ${power ? 'no' : 'yes'}) (dnp ${props.dnp ? 'yes' : 'no'})`);
    L.push(`    (uuid ${uuid})`);
    const prop = (k, v, id, at, hide, j = '') => L.push(`    (property ${q(k)} ${q(v)} (id ${id}) (at ${X(at.x)} ${Y(at.y)} 0) (effects (font (size 1.27 1.27))${j}${hide ? ' hide' : ''}))`);
    prop('Reference', ref, 0, refAt, power, just);
    prop('Value', power ? props.net || 'GND' : props.value ?? '', 1, valAt, false, just);
    prop('Footprint', fp, 2, { x: c.x, y: c.y }, true);
    prop('Datasheet', '', 3, { x: c.x, y: c.y }, true);
    if (!power) {
      let id = 4;
      if (nlc?.lcsc || props.lcsc) prop('LCSC', nlc?.lcsc || props.lcsc, id++, { x: c.x, y: c.y }, true);
      if (nlc?.mpn || props.mpn) prop('MPN', nlc?.mpn || props.mpn, id++, { x: c.x, y: c.y }, true);
      if (nlc?.manufacturer || props.manufacturer) prop('Manufacturer', nlc?.manufacturer || props.manufacturer, id++, { x: c.x, y: c.y }, true);
    }
    for (const p of info.pins) L.push(`    (pin ${q(p.number)} (uuid ${uuidFrom(`${c.id}:pin:${p.number}`)}))`);
    L.push(`    (instances (project ${q(projectName)} (path ${q(`/${rootUuid}`)} (reference ${q(ref)}) (unit 1))))`);
    L.push('  )');
  }
  L.push('');
  L.push('  (sheet_instances (path "/" (page "1")))');
  L.push(')');
  return { text: L.join('\n') + '\n', rootUuid, symbolUuid: (compId) => uuidFrom(`${compId}:sym`) };
}
