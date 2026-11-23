// 回路図シートの編集操作（純粋関数。シートを直接書き換える）
// 選択は Set<string> で 'c:<id>'（部品）/ 'w:<id>'（配線）/ 'l:<id>'（ネットラベル）

import { newId } from '../core/project.js';
import {
  xform, xformRect, distToSegment, rectContains, rectInside, normRect, rot90About, mirrorAbout, key, snap, onSegmentInterior,
} from './geom.js';
import { getSymbol, kindInfo } from './symbols.js';
import { cmpRef } from './connectivity.js';

// ---------------- 部品番号 ----------------
export function refPrefix(ref) { return String(ref).replace(/\d+$/, ''); }
export function refNumber(ref) { const m = String(ref).match(/(\d+)$/); return m ? Number(m[1]) : 0; }

export function nextRef(sheet, prefix) {
  let max = 0;
  for (const c of sheet.components) if (refPrefix(c.ref) === prefix) max = Math.max(max, refNumber(c.ref));
  return `${prefix}${max + 1}`;
}

/** 位置順（上→下、左→右）に振り直す。電源記号は #PWR で別系統 */
export function annotate(sheet) {
  const groups = new Map();
  for (const c of sheet.components) {
    const p = kindInfo(c.kind)?.prefix ?? refPrefix(c.ref);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(c);
  }
  for (const [prefix, list] of groups) {
    list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    list.forEach((c, i) => { c.ref = `${prefix}${i + 1}`; });
  }
}

export function isRefTaken(sheet, ref, exceptId) {
  return sheet.components.some((c) => c.id !== exceptId && c.ref === ref);
}

// ---------------- 追加 ----------------
export function addComponent(sheet, kind, x, y, extraProps = {}) {
  const info = kindInfo(kind);
  if (!info) throw new Error(`未知の部品種別: ${kind}`);
  const c = {
    id: newId('c'),
    kind,
    ref: nextRef(sheet, info.prefix),
    x: snap(x), y: snap(y), rot: 0, mirror: false,
    props: { ...structuredClone(info.props), lcsc: '', mpn: '', manufacturer: '', dnp: false, ...extraProps },
  };
  if (info.power) { delete c.props.lcsc; delete c.props.mpn; delete c.props.manufacturer; delete c.props.dnp; }
  sheet.components.push(c);
  return c;
}

/** 始点→終点を直交2線分で結ぶ点列。hFirst=true なら横→縦 */
export function routeL(a, b, hFirst = true) {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const corner = hFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return [a, corner, b];
}

/** 点列を配線として追加。長さ0の線分は作らない。追加した配線を返す */
export function addWirePath(sheet, pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = { x: snap(pts[i - 1].x), y: snap(pts[i - 1].y) };
    const b = { x: snap(pts[i].x), y: snap(pts[i].y) };
    if (a.x === b.x && a.y === b.y) continue;
    const w = { id: newId('w'), a, b };
    sheet.wires.push(w);
    out.push(w);
  }
  cleanupWires(sheet);
  return out;
}

export function addLabel(sheet, x, y, name) {
  const l = { id: newId('l'), x: snap(x), y: snap(y), name: String(name).trim(), rot: 0 };
  sheet.labels.push(l);
  cleanupWires(sheet);
  return l;
}

/**
 * 配線の整理:
 *  1) 他の配線の端点・ピン先端・ラベルが配線の途中に乗っていたら、その点で配線を分割する
 *     （KiCad と同じ。分岐点が独立した端点になるので、部品を動かしても分岐が外れない）
 *  2) 長さ0の配線と完全重複を除去
 */
export function cleanupWires(sheet) {
  const pts = [];
  for (const w of sheet.wires) pts.push(w.a, w.b);
  for (const c of sheet.components) for (const p of getSymbol(c).pins) pts.push(xform(p, c));
  for (const l of sheet.labels) pts.push(l);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (const w of sheet.wires) {
      const p = pts.find((q) => onSegmentInterior(q, w.a, w.b));
      if (!p) continue;
      const tail = { id: newId('w'), a: { x: p.x, y: p.y }, b: { ...w.b } };
      w.b = { x: p.x, y: p.y };
      sheet.wires.push(tail);
      changed = true;
      break;
    }
  }
  const seen = new Set();
  sheet.wires = sheet.wires.filter((w) => {
    if (w.a.x === w.b.x && w.a.y === w.b.y) return false;
    const k1 = `${key(w.a.x, w.a.y)}-${key(w.b.x, w.b.y)}`, k2 = `${key(w.b.x, w.b.y)}-${key(w.a.x, w.a.y)}`;
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1);
    return true;
  });
}

// ---------------- 選択・ヒットテスト ----------------
export function compRect(c) { return xformRect(getSymbol(c).bbox, c); }

export function labelRect(l) {
  const w = Math.max(2, l.name.length * 0.8 + 1);
  return l.rot % 180 === 0 ? { x0: l.x, y0: l.y - 1.2, x1: l.x + w, y1: l.y + 0.4 } : { x0: l.x - 1.2, y0: l.y - w, x1: l.x + 0.4, y1: l.y };
}

/**
 * 点 p にある要素のキー（無ければ null）。tol はワールド単位の許容距離。
 * 優先: ラベル > 部品 > 配線（小さい部品ほど優先）
 */
export function hitTest(sheet, p, tol) {
  // 1回目は余白なし（ラベル→部品）、外れたら余白付きでもう一度。
  // ラベルが部品に近くても、部品本体をタップすれば部品が選べるようにするため
  for (const pad of [0, tol * 0.5]) {
    for (const l of sheet.labels) {
      const r = labelRect(l);
      if (rectContains({ x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad }, p)) return `l:${l.id}`;
    }
    let best = null, bestArea = Infinity;
    for (const c of sheet.components) {
      const r = compRect(c);
      if (rectContains({ x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad }, p)) {
        const area = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (area < bestArea) { best = `c:${c.id}`; bestArea = area; }
      }
    }
    if (best) return best;
    if (pad === 0) {
      // 余白なしで何も無ければ、余白付きの前に配線を調べる（配線の近くの空白で部品が選ばれないように）
      let bw = null, bd = Infinity;
      for (const w of sheet.wires) {
        const d = distToSegment(p, w.a, w.b);
        if (d <= tol && d < bd) { bw = `w:${w.id}`; bd = d; }
      }
      if (bw) return bw;
    }
  }
  return null;
}

/** 矩形内に完全に入っている要素 */
export function itemsInRect(sheet, a, b) {
  const R = normRect(a, b);
  const out = new Set();
  sheet.components.forEach((c) => { if (rectInside(compRect(c), R)) out.add(`c:${c.id}`); });
  sheet.wires.forEach((w) => { if (rectContains(R, w.a) && rectContains(R, w.b)) out.add(`w:${w.id}`); });
  sheet.labels.forEach((l) => { if (rectContains(R, l)) out.add(`l:${l.id}`); });
  return out;
}

/** 配線を始めたり終えたりできる点（ピン先端・配線端点）に吸着。無ければ null */
export function snapTarget(sheet, p, tol) {
  let best = null, bd = tol;
  const consider = (x, y) => { const d = Math.hypot(p.x - x, p.y - y); if (d <= bd) { bd = d; best = { x, y }; } };
  for (const c of sheet.components) for (const pin of getSymbol(c).pins) { const q = xform(pin, c); consider(q.x, q.y); }
  for (const w of sheet.wires) { consider(w.a.x, w.a.y); consider(w.b.x, w.b.y); }
  for (const l of sheet.labels) consider(l.x, l.y);
  return best;
}

/** 点が「接続できる物」（ピン・配線上・ラベル）の上か。配線ツールで終点判定に使う */
export function isConnectable(sheet, p) {
  for (const c of sheet.components) for (const pin of getSymbol(c).pins) { const q = xform(pin, c); if (q.x === p.x && q.y === p.y) return true; }
  for (const w of sheet.wires) if (distToSegment(p, w.a, w.b) < 1e-9) return true;
  return sheet.labels.some((l) => l.x === p.x && l.y === p.y);
}

// ---------------- 変形（移動・回転・ミラー） ----------------
const ids = (sel, t) => new Set([...sel].filter((k) => k.startsWith(t + ':')).map((k) => k.slice(2)));

/**
 * 選択要素に点変換 fn を適用し、選択外の配線端点はつながっていた点に追従させる（ラバーバンド）。
 * compFn(c) は部品の位置・向きを更新する。
 */
function transformSelection(sheet, sel, fn, compFn) {
  const cs = ids(sel, 'c'), ws = ids(sel, 'w'), ls = ids(sel, 'l');
  const moved = new Map(); // 旧座標キー → 新座標
  const pinMoved = new Map(); // 動いた部品のピンだけ（旧座標キー → 新座標）

  for (const c of sheet.components) {
    if (!cs.has(c.id)) continue;
    const sym = getSymbol(c);
    const before = sym.pins.map((p) => xform(p, c));
    compFn(c);
    sym.pins.forEach((p, i) => { const n = xform(p, c), k = key(before[i].x, before[i].y); moved.set(k, n); pinMoved.set(k, n); });
  }
  for (const w of sheet.wires) {
    if (!ws.has(w.id)) continue;
    for (const end of ['a', 'b']) {
      const n = fn(w[end]);
      moved.set(key(w[end].x, w[end].y), n);
      w[end] = n;
    }
  }
  for (const l of sheet.labels) {
    if (!ls.has(l.id)) continue;
    const n = fn(l);
    moved.set(key(l.x, l.y), n);
    l.x = n.x; l.y = n.y;
  }
  // 選択外のネットラベル・電源記号（GND など）が、動いた部品のピンにじかに付いていれば一緒に動かす。
  // ラベルや電源記号だけで結線した回路図（AI の作図など）で、部品を動かすと接続が外れてしまうのを防ぐ。
  // ただし同じ点に選択外の部品のピンもあるとき（そちらにも付いている）は動かさない。
  const pinKeys = new Map(); // 選択外の部品のピン位置 → 本数（電源記号自身は除く）
  for (const c of sheet.components) {
    if (cs.has(c.id) || kindInfo(c.kind)?.power) continue;
    for (const p of getSymbol(c).pins) { const q = xform(p, c); const k = key(q.x, q.y); pinKeys.set(k, (pinKeys.get(k) || 0) + 1); }
  }
  for (const l of sheet.labels) {
    if (ls.has(l.id)) continue;
    const k = key(l.x, l.y), n = pinMoved.get(k);
    if (n && !pinKeys.has(k)) { l.x = n.x; l.y = n.y; }
  }
  for (const c of sheet.components) {
    if (cs.has(c.id) || !kindInfo(c.kind)?.power) continue;
    const pin = getSymbol(c).pins[0];
    if (!pin) continue;
    const q = xform(pin, c), k = key(q.x, q.y), n = pinMoved.get(k);
    if (n && !pinKeys.has(k)) { c.x += n.x - q.x; c.y += n.y - q.y; }
  }
  // 選択外の配線端点を追従。片側だけ動いて斜めになる配線は、元の向きを保った直角の折れ線にする
  const extra = [];
  for (const w of sheet.wires) {
    if (ws.has(w.id)) continue;
    const na = moved.get(key(w.a.x, w.a.y)), nb = moved.get(key(w.b.x, w.b.y));
    if (!na && !nb) continue;
    const wasH = w.a.y === w.b.y, wasV = w.a.x === w.b.x;
    if (na && nb) { w.a = { ...na }; w.b = { ...nb }; continue; }
    const fixedEnd = na ? 'b' : 'a', movedEnd = na ? 'a' : 'b';
    const np = { ...(na || nb) };
    const fixed = w[fixedEnd];
    if ((wasH || wasV) && np.x !== fixed.x && np.y !== fixed.y) {
      const corner = wasH ? { x: np.x, y: fixed.y } : { x: fixed.x, y: np.y };
      w[movedEnd] = corner;
      extra.push({ id: newId('w'), a: { ...corner }, b: np });
    } else {
      w[movedEnd] = np;
    }
  }
  sheet.wires.push(...extra);
  cleanupWires(sheet);
}

export function moveSelection(sheet, sel, dx, dy) {
  dx = snap(dx); dy = snap(dy);
  if (!dx && !dy) return false;
  transformSelection(sheet, sel, (p) => ({ x: p.x + dx, y: p.y + dy }), (c) => { c.x += dx; c.y += dy; });
  return true;
}

/** 選択の中心（グリッドに丸める）。部品1個ならその原点 */
export function selectionCenter(sheet, sel) {
  const cs = ids(sel, 'c');
  if (sel.size === 1 && cs.size === 1) {
    const c = sheet.components.find((x) => cs.has(x.id));
    return { x: c.x, y: c.y };
  }
  const pts = [];
  sheet.components.forEach((c) => { if (cs.has(c.id)) pts.push(c); });
  const ws = ids(sel, 'w');
  sheet.wires.forEach((w) => { if (ws.has(w.id)) pts.push(w.a, w.b); });
  const ls = ids(sel, 'l');
  sheet.labels.forEach((l) => { if (ls.has(l.id)) pts.push(l); });
  if (!pts.length) return { x: 0, y: 0 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: snap((Math.min(...xs) + Math.max(...xs)) / 2), y: snap((Math.min(...ys) + Math.max(...ys)) / 2) };
}

export function rotateSelection(sheet, sel) {
  if (!sel.size) return false;
  const c0 = selectionCenter(sheet, sel);
  transformSelection(sheet, sel, (p) => rot90About(p, c0), (c) => {
    const n = rot90About(c, c0);
    c.x = n.x; c.y = n.y; c.rot = ((c.rot || 0) + 90) % 360;
  });
  const ls = ids(sel, 'l');
  sheet.labels.forEach((l) => { if (ls.has(l.id)) l.rot = ((l.rot || 0) + 90) % 180; });
  return true;
}

/** シート上で左右反転。部品は向きを保ったまま鏡像にする（rot → -rot, mirror 反転） */
export function mirrorSelection(sheet, sel) {
  if (!sel.size) return false;
  const c0 = selectionCenter(sheet, sel);
  transformSelection(sheet, sel, (p) => mirrorAbout(p, c0), (c) => {
    const n = mirrorAbout(c, c0);
    c.x = n.x; c.y = n.y; c.rot = (360 - (c.rot || 0)) % 360; c.mirror = !c.mirror;
  });
  return true;
}

export function deleteSelection(sheet, sel) {
  if (!sel.size) return false;
  const cs = ids(sel, 'c'), ws = ids(sel, 'w'), ls = ids(sel, 'l');
  sheet.components = sheet.components.filter((c) => !cs.has(c.id));
  sheet.wires = sheet.wires.filter((w) => !ws.has(w.id));
  sheet.labels = sheet.labels.filter((l) => !ls.has(l.id));
  return true;
}

/** 選択に含まれる部品数などの要約 */
export function describeSelection(sheet, sel) {
  const cs = ids(sel, 'c');
  const comps = sheet.components.filter((c) => cs.has(c.id)).sort((a, b) => cmpRef(a.ref, b.ref));
  return { comps, wires: ids(sel, 'w').size, labels: ids(sel, 'l').size };
}

export function findItem(sheet, k) {
  const id = k.slice(2);
  if (k.startsWith('c:')) return sheet.components.find((c) => c.id === id);
  if (k.startsWith('w:')) return sheet.wires.find((w) => w.id === id);
  if (k.startsWith('l:')) return sheet.labels.find((l) => l.id === id);
  return null;
}
