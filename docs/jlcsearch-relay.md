# jlcsearch 中継（必要な場合のみ）

Pocket EDA の「オンライン検索」は、スマホのブラウザから [jlcsearch](https://docs.tscircuit.com/web-apis/jlcsearch-api)（tscircuit のコミュニティAPI、認証不要）を直接呼びます。
jlcsearch 側がブラウザからの直接アクセス（CORS）を許可していない場合だけ、下の中継を Cloudflare Workers（無料枠）に置き、
アプリの「部品 → オンライン検索の『設定』」に Workers の URL を入れてください。

- LCSC公式APIと違い、申請・秘密鍵・固定IPは不要です
- 中継が通すのは jlcsearch の検索2種類だけです
- `ALLOW_ORIGIN` は自分のアプリのURL（例: `https://1tokan.github.io`）にしてください

## 手順
1. https://dash.cloudflare.com/ で無料アカウントを作る
2. Workers & Pages → Create → Worker → 名前（例: `jlcsearch-relay`）→ Deploy
3. Edit code で中身を下のコードに置き換えて Deploy
4. 表示された `https://jlcsearch-relay.<あなたの名前>.workers.dev` をアプリの設定に入れる

```js
// Cloudflare Worker: jlcsearch 中継（GET の検索だけを通し、CORS ヘッダーを付ける）
const UPSTREAM = 'https://jlcsearch.tscircuit.com';
const ALLOW_ORIGIN = 'https://1tokan.github.io';
const ALLOWED_PATHS = ['/api/search', '/components/list.json'];

export default {
  async fetch(req, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Methods': 'GET', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Headers': 'Accept' } });
    const url = new URL(req.url);
    if (req.method !== 'GET' || !ALLOWED_PATHS.includes(url.pathname)) return new Response('not allowed', { status: 403, headers: cors });
    const cache = caches.default;
    const key = new Request(UPSTREAM + url.pathname + url.search);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(key, { headers: { Accept: 'application/json' } });
      res = new Response(up.body, { status: up.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' } });
      if (up.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
```
