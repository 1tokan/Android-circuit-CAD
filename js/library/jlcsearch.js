// jlcsearch（tscircuit のコミュニティAPI、認証不要）によるオンライン部品検索
// https://docs.tscircuit.com/web-apis/jlcsearch-api
//  - GET /api/search?q=...&limit=...&full=true      全文検索
//  - GET /components/list.json?search=C25804&full=true  LCSC品番・型番での検索
// LCSC公式ではない非公式サービスなので、使えなくても設計を続けられるようにする（取得した部品は端末に保存）。
// 送るのは検索語だけ。呼び出し間隔を空け、同じ検索は一定時間キャッシュする。

import { normalizePart, normalizeLcsc, guessKind, guessFootprint, normalizeValue, pinCountFromPackage } from './parts.js';
import { parsePrice, valueFromDescription } from './importer.js';

export const DEFAULT_BASE = 'https://jlcsearch.tscircuit.com';
const MIN_INTERVAL_MS = 700;
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;

export class JlcsearchError extends Error {
  constructor(kind, message) { super(message); this.name = 'JlcsearchError'; this.kind = kind; }
}

/** 応答の1件 → 部品データ（normalizePart 済み）。変換できなければ null */
export function mapComponent(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lcsc = normalizeLcsc(raw.lcsc ?? raw.lcsc_part ?? raw.component_code);
  if (!/^C\d+$/.test(lcsc)) return null;
  let attrs = raw.attributes ?? raw.extra?.attributes ?? null;
  if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch { attrs = null; } }
  const description = String(raw.description ?? '').trim();
  const category = [raw.category, raw.subcategory, raw.subcategory_name, attrs?.Type].filter(Boolean).join(' ');
  const kind = guessKind(`${category} ${description}`);
  const pkg = String(raw.package ?? '').trim();
  const mpn = String(raw.mfr ?? raw.mpn ?? '').trim();
  const specs = {};
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs).slice(0, 16)) if (v !== null && v !== '' && typeof v !== 'object') specs[k] = String(v);
  }
  if (category) specs['カテゴリ'] = category;
  // 値: 抵抗値・容量などの数値フィールド → 仕様 → 説明文
  let value = '';
  if (kind === 'resistor' && Number.isFinite(raw.resistance)) value = normalizeValue(String(raw.resistance));
  else if ((kind === 'capacitor' || kind === 'electrolytic') && Number.isFinite(raw.capacitance_farads)) value = farads(raw.capacitance_farads);
  if (!value) value = valueFromDescription(kind, `${attrs?.Resistance ?? ''} ${attrs?.Capacitance ?? ''} ${attrs?.Inductance ?? ''} ${description}`) || mpn;
  // 価格: 数値 / "0.01" / 価格表(JSON・"1-199:0.01,...")
  let price = [];
  const pr = raw.price ?? raw.price1 ?? raw.prices;
  if (typeof pr === 'number') price = [{ qty: 1, usd: pr }];
  else if (Array.isArray(pr)) price = parsePrice(JSON.stringify(pr));
  else if (pr !== undefined && pr !== null) price = parsePrice(String(pr));
  const isBasic = raw.is_basic ?? raw.basic;
  const isPref = raw.is_preferred ?? raw.preferred;
  const type = isBasic === true || isBasic === 1 ? 'basic' : isPref === true || isPref === 1 ? 'preferred'
    : (isBasic === false || isBasic === 0) ? 'extended' : 'unknown';
  const stock = Number(raw.stock);
  try {
    return normalizePart({
      source: 'jlcsearch', name: [value !== mpn ? value : '', mpn, pkg].filter(Boolean).join(' ') || description.slice(0, 60) || lcsc,
      kind, lcsc, mpn, manufacturer: String(raw.manufacturer ?? raw.manufacturer_name ?? '').trim(), package: pkg, description, value,
      datasheet: raw.datasheet ?? raw.datasheet_url ?? '', footprint: guessFootprint(kind, pkg), specs,
      jlc: { type, assembly: true }, price, stock: Number.isFinite(stock) ? stock : null, updatedAt: now,
        ...(kind === 'ic' && pinCountFromPackage(pkg) ? { symbol: { kind, pinCount: pinCountFromPackage(pkg) } } : {}),
      lcscVerified: true, // JLCPCB の部品データから来た品番
    });
  } catch {
    return null;
  }
}

function farads(f) {
  for (const [suf, m] of [['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12]]) {
    const x = f / m;
    if (x >= 1 && x < 1000) return `${Number(x.toPrecision(4))}${suf}`;
  }
  return '';
}

/**
 * @param opts { base, fetchImpl, now() }
 */
export function createJlcsearch({ base = DEFAULT_BASE, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let last = 0;
  const cache = new Map();
  let baseUrl = base.replace(/\/+$/, '');

  async function getJSON(path) {
    const url = `${baseUrl}${path}`;
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.data;
    const wait = last + MIN_INTERVAL_MS - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = now();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new JlcsearchError('offline', 'オフラインです');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl?.signal, headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw new JlcsearchError(e?.name === 'AbortError' ? 'timeout' : 'network',
        e?.name === 'AbortError' ? '応答がありません（タイムアウト）' : '接続できません（通信エラー、またはブラウザからの直接アクセスが許可されていません）');
    } finally { clearTimeout(timer); }
    if (res.status === 429) throw new JlcsearchError('rate', '呼び出しが多すぎます。しばらく待ってください');
    if (!res.ok) throw new JlcsearchError('http', `サーバーエラー (HTTP ${res.status})`);
    let data;
    try { data = await res.json(); } catch { throw new JlcsearchError('format', '応答がJSONではありません'); }
    cache.set(url, { at: now(), data });
    return data;
  }

  return {
    get base() { return baseUrl; },
    setBase(b) { baseUrl = String(b || DEFAULT_BASE).trim().replace(/\/+$/, '') || DEFAULT_BASE; cache.clear(); },
    /**
     * 検索。LCSC品番（C25804 / 25804）なら品番検索、それ以外は全文検索。
     * @returns {{ parts, raw: number, query }}
     */
    async search(q, { packageName = '', limit = 30 } = {}) {
      const query = String(q || '').trim();
      if (!query) return { parts: [], raw: 0, query };
      const isCode = /^c?\d{2,9}$/i.test(query);
      const params = new URLSearchParams();
      let path;
      if (isCode) {
        params.set('search', normalizeLcsc(query));
        params.set('full', 'true');
        path = `/components/list.json?${params}`;
      } else {
        params.set('q', query);
        params.set('limit', String(limit));
        params.set('full', 'true');
        if (packageName) params.set('package', packageName);
        path = `/api/search?${params}`;
      }
      const data = await getJSON(path);
      const list = Array.isArray(data) ? data : (data.components || Object.values(data).find(Array.isArray) || []);
      const at = new Date(now()).toISOString();
      const parts = [];
      const seen = new Set();
      for (const raw of list) {
        const p = mapComponent(raw, { now: at });
        if (p && !seen.has(p.id)) { seen.add(p.id); parts.push(p); }
      }
      // 品番検索は完全一致を先頭に
      if (isCode) parts.sort((a, b) => (b.lcsc === normalizeLcsc(query)) - (a.lcsc === normalizeLcsc(query)));
      return { parts: parts.slice(0, limit), raw: list.length, query };
    },
  };
}
