// 部品データの取り込み・書き出し（CSV / JSON）
// LCSC公式APIはサーバーレスのPWAから安全に使えないため（docs/ROADMAP.md）、
// JLCPCB部品ライブラリのCSV、CDFER/jlcpcb-parts-database のCSV、
// ユーザーが作ったCSV/JSON を取り込む。列名は表記ゆれを吸収して対応づける。

import { normalizePart, normalizeLcsc, guessKind, guessFootprint, normalizeValue, pinCountFromPackage, PartFormatError } from './parts.js';
import { getFootprint } from './footprints.js';

export const LIBRARY_FORMAT = 'pocket-eda-library';

/** RFC 4180 準拠の CSV パーサ（引用符・改行を含むセル・BOM・区切り文字自動判定） */
export function parseCSV(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const first = s.slice(0, s.indexOf('\n') >>> 0);
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.includes(';') && !first.includes(',') ? ';' : ',');
  const rows = [];
  let row = [], cell = '', i = 0, q = false;
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { q = true; i++; continue; }
    if (c === delim) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const hkey = (h) => String(h).toLowerCase().normalize('NFKC').replace(/[^a-z0-9#぀-ヿ一-鿿]/g, '').replace(/#/g, '');

const ALIASES = {
  lcsc: ['lcscpart', 'lcsc', 'jlcpcbpart', 'lcscpartnumber', 'componentcode', 'cnumber', 'lcsc品番', 'jlcpcbpartnumber'],
  mpn: ['mfrpart', 'mpn', 'manufacturerpart', 'manufacturerpartnumber', 'mfrpartnumber', 'partnumber', 'mfr', 'メーカー型番', '型番'],
  manufacturer: ['manufacturer', 'brand', 'メーカー'],
  package: ['package', 'packagetype', 'case', 'footprintpackage', 'パッケージ'],
  type: ['librarytype', 'basicextended', 'parttype', 'type', 'jlcpcbtype', '区分'],
  basic: ['basic', 'isbasic'],
  preferred: ['preferred', 'ispreferred'],
  description: ['description', 'desc', '説明'],
  datasheet: ['datasheet', 'datasheeturl', 'データシート'],
  price: ['price', 'unitprice', 'priceusd', '価格'],
  stock: ['stock', 'instock', 'stockqty', '在庫', '在庫数'],
  cat1: ['firstcategory', 'category', 'primarycategory', 'カテゴリ'],
  cat2: ['secondcategory', 'subcategory', 'secondarycategory'],
  name: ['name', 'partname', '部品名称', '名称'],
  value: ['value', 'comment', '値'],
  footprint: ['footprintid', 'pocketedafootprint', 'footprint', 'フットプリント'],
  kind: ['kind', 'symbol', 'シンボル'],
};

/** 見出し行から列番号の対応表を作る */
export function mapHeaders(headers) {
  const keys = headers.map(hkey);
  const map = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const idx = keys.findIndex((k) => names.includes(k));
    if (idx >= 0 && !Object.values(map).includes(idx)) map[field] = idx;
  }
  // 'mfr' は jlcparts では型番。manufacturer が別にあれば mpn として扱う（上の順序で処理済み）
  return map;
}

/**
 * 価格表記の解析。対応形式:
 *  "1-199:0.0029,200-:0.0015" / "$0.0029" / "0.0029" / JSON [{qFrom,qTo,price}]
 */
export function parsePrice(v) {
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s).map((b) => ({ qty: Number(b.qFrom ?? b.qty ?? 1), usd: Number(b.price ?? b.usd) })).filter((b) => Number.isFinite(b.usd));
    } catch { return []; }
  }
  if (s.includes(':')) {
    return s.split(/[,;]/).map((seg) => {
      const [range, price] = seg.split(':');
      return { qty: Number(String(range).split('-')[0]) || 1, usd: Number(String(price).replace(/[$\s]/g, '')) };
    }).filter((b) => Number.isFinite(b.usd));
  }
  const n = Number(s.replace(/[$\s,]/g, ''));
  return Number.isFinite(n) ? [{ qty: 1, usd: n }] : [];
}

function jlcType(type, basic, preferred) {
  const t = String(type ?? '').toLowerCase();
  if (t.includes('basic')) return 'basic';
  if (t.includes('prefer')) return 'preferred';
  if (t.includes('extend')) return 'extended';
  if (/^(1|true|yes)$/i.test(String(basic ?? ''))) return 'basic';
  if (/^(1|true|yes)$/i.test(String(preferred ?? ''))) return 'preferred';
  if (basic !== undefined || preferred !== undefined) return 'extended';
  return 'unknown';
}

/** 説明文から値（抵抗値・容量・インダクタンス）を取り出す */
export function valueFromDescription(kind, desc) {
  const d = String(desc || '').normalize('NFKC');
  const re = {
    resistor: /(\d+(?:\.\d+)?\s*[kKmMR]?)\s*(?:Ω|ohm)/i,
    pot: /(\d+(?:\.\d+)?\s*[kKmM]?)\s*(?:Ω|ohm)/i,
    capacitor: /(\d+(?:\.\d+)?\s*[pnuμµ]?)F\b/,
    electrolytic: /(\d+(?:\.\d+)?\s*[pnuμµ]?)F\b/,
    inductor: /(\d+(?:\.\d+)?\s*[pnuμµm]?)H\b/,
  }[kind];
  const m = re && d.match(re);
  return m ? normalizeValue(m[1].replace(/\s/g, '')) : '';
}

/**
 * CSV テキスト → 部品の配列
 * @returns {{ parts, skipped: [{line, reason}], columns }}
 */
export function importCSV(text, { source = 'import:csv', now = new Date().toISOString() } = {}) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new PartFormatError('CSVにデータ行がありません');
  const headers = rows[0];
  const col = mapHeaders(headers);
  if (col.lcsc === undefined && col.mpn === undefined && col.name === undefined) {
    throw new PartFormatError(`LCSC品番・メーカー型番・部品名称のいずれかの列が必要です。見出し: ${headers.slice(0, 12).join(', ')}`);
  }
  const get = (r, f) => (col[f] === undefined ? undefined : (r[col[f]] ?? '').trim());
  const parts = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    try {
      const description = get(r, 'description') || '';
      const catText = [get(r, 'cat1'), get(r, 'cat2'), description].filter(Boolean).join(' ');
      const kind = get(r, 'kind') || guessKind(catText);
      const fpCol = get(r, 'footprint') || '';
      const pkg = get(r, 'package') || (getFootprint(fpCol) ? '' : fpCol);
      const mpn = get(r, 'mpn') || '';
      const lcsc = normalizeLcsc(get(r, 'lcsc'));
      const value = get(r, 'value') || valueFromDescription(kind, description) || mpn;
      // footprint 列がフットプリントIDならそのまま、そうでなければパッケージ名から推定
      const fp = getFootprint(fpCol) ? fpCol : guessFootprint(kind, pkg);
      const specs = {};
      if (get(r, 'cat1')) specs['カテゴリ'] = [get(r, 'cat1'), get(r, 'cat2')].filter(Boolean).join(' / ');
      const part = normalizePart({
        source, name: get(r, 'name') || [value !== mpn ? value : '', mpn, pkg].filter(Boolean).join(' ') || description.slice(0, 60),
        kind, lcsc, mpn, manufacturer: get(r, 'manufacturer') || '', package: pkg, description, value,
        datasheet: get(r, 'datasheet') || '', footprint: fp, specs,
        jlc: { type: jlcType(get(r, 'type'), get(r, 'basic'), get(r, 'preferred')), assembly: lcsc ? true : null },
        ...(kind === 'ic' && pinCountFromPackage(pkg) ? { symbol: { kind, pinCount: pinCountFromPackage(pkg) } } : {}),
        price: parsePrice(get(r, 'price')),
        stock: get(r, 'stock') === undefined || get(r, 'stock') === '' ? null : Number(String(get(r, 'stock')).replace(/,/g, '')),
        updatedAt: now,
        lcscVerified: !!lcsc, // 公式データからの取込は品番を確認済みとみなす
      });
      if (seen.has(part.id)) { skipped.push({ line: i + 1, reason: `重複 (${part.lcsc || part.mpn})` }); continue; }
      seen.add(part.id);
      parts.push(part);
    } catch (e) {
      skipped.push({ line: i + 1, reason: e.message });
    }
  }
  return { parts, skipped, columns: Object.fromEntries(Object.entries(col).map(([k, v]) => [k, headers[v]])) };
}

/** JSON（部品配列 または {format:'pocket-eda-library', parts:[...]}）→ 部品の配列 */
export function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new PartFormatError('JSONとして読み込めません: ' + e.message); }
  const list = Array.isArray(data) ? data : (data && data.format === LIBRARY_FORMAT && Array.isArray(data.parts) ? data.parts : null);
  if (!list) throw new PartFormatError('部品ライブラリのJSONではありません（配列、または format: "pocket-eda-library"）');
  const parts = [], skipped = [];
  list.forEach((raw, i) => {
    try { parts.push(normalizePart({ source: 'import:json', ...raw })); }
    catch (e) { skipped.push({ line: i + 1, reason: e.message }); }
  });
  return { parts, skipped, columns: null };
}

export function exportLibraryJSON(parts) {
  return JSON.stringify({ format: LIBRARY_FORMAT, version: 1, exportedAt: new Date().toISOString(), parts }, null, 2);
}
