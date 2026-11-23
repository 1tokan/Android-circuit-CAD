// 部品の簡易 3D 形状（実物の 3D モデルではない）。3D 表示（viewer.js）と KiCad 用 3D モデル（output/vrml.js）で同じ形を使う。
// 形はフットプリントの部品内座標（mm、y 下向き）で、z は基板の部品面から上向き（mm）。
// 箱 { k:'box', x, y, w(x方向), d(y方向), h, z0, m }・円柱 { k:'cyl', x, y, r, h, z0, seg, m }。m は色と質感。

const DARK = '#1c1c1e';
const METAL = { color: '#d8d8d8', metalness: 0.8, roughness: 0.3 };
const GOLD = { color: '#d4af37', metalness: 0.9, roughness: 0.25 };

/** パッケージから高さ・色・形を決める */
export function partStyle(fpDef, value = '') {
  const id = String(fpDef.id), pkg = String(fpDef.package || id).toUpperCase(), v = String(value || '').toUpperCase();
  // 線をはんだ付けするパッド・テストパッドは部品が載らない（パッドだけ見せる）
  if (/^(SolderWirePad|TestPad|SolderJumper)/i.test(id)) return { none: true };
  if (/^R_\d/.test(id)) return { h: 0.45, color: '#1d1d1d', ends: true };
  if (/^C_\d/.test(id)) return { h: 0.6, color: '#b8946a', ends: true };
  if (/^L_\d/.test(id)) return { h: 0.6, color: '#3a3a3a', ends: true };
  if (/^LED_/.test(id)) return { h: 0.6, color: /GREEN|緑/.test(v) ? '#47d16b' : /BLUE|青/.test(v) ? '#4a86ff' : /YELLOW|黄/.test(v) ? '#ffd23f' : /WHITE|白/.test(v) ? '#f3f3f3' : '#ff3b30', ends: true, glow: true };
  if (/^CP_ELEC/.test(id.toUpperCase())) return { cyl: true, h: 5.4, color: '#c8c8cc' };
  if (/^PINHEADER/.test(id.toUpperCase())) return { header: true, h: 2.5, color: '#111' };
  if (/^JST_PH/.test(id.toUpperCase())) return { h: /HORIZONTAL/i.test(id) ? 4.8 : 6.0, color: '#efe6cf' };
  if (/^SW_PUSH/.test(id.toUpperCase())) return { h: 3.5, color: '#202020', button: true };
  if (/^DIP/.test(pkg)) return { h: 3.3, lift: 0.5, color: DARK, pin1: true };
  if (/SOT-?223|DPAK|TO-252/.test(pkg)) return { h: 1.6, color: DARK, pin1: true };
  if (/SOT|SOD|SC-?70/.test(pkg)) return { h: 1.0, color: DARK, pin1: /SOT/.test(pkg) };
  if (/SMA|SMB|SMC/.test(pkg)) return { h: 2.1, color: DARK, band: true };
  if (/QFN|DFN|LGA|SON/.test(pkg)) return { h: 0.85, color: DARK, pin1: true };
  if (/QFP/.test(pkg)) return { h: 1.4, color: DARK, pin1: true };
  if (/SSOP|TSSOP|MSOP/.test(pkg)) return { h: 1.1, color: DARK, pin1: true };
  if (/SOIC|SOP/.test(pkg)) return { h: 1.5, color: DARK, pin1: true };
  if (/TRIMMER/.test(id.toUpperCase())) return { h: 4.5, color: '#3a5bd6' };
  return { h: 1.0, color: '#555' };
}

/**
 * 形のリスト
 * @param fpDef フットプリント
 * @param value 部品の値（LED の色に使う）
 * @param t 板厚 mm（スルーホールのピンを反対面まで出す）
 */
export function partPrims(fpDef, value = '', t = 1.6) {
  const out = [];
  const s = partStyle(fpDef, value);
  if (s.none) return out;
  const b = fpDef.body || { w: 1, h: 1 };
  const box = (w, d, h, m, x, y, z0) => out.push({ k: 'box', w, d, h, m, x, y, z0 });
  const cyl = (r, h, m, x, y, z0, seg = 24) => out.push({ k: 'cyl', r, h, m, x, y, z0, seg });
  const col = (color, opt = {}) => ({ color, ...opt });
  const cx = b.cx || 0, cy = b.cy || 0;
  if (s.cyl) {
    box(b.w, b.h, 0.6, col('#1b1b1b'), cx, cy, 0);
    cyl(Math.min(b.w, b.h) / 2 * 0.95, s.h - 0.6, col(s.color, { metalness: 0.6, roughness: 0.35 }), cx, cy, 0.6);
  } else if (s.header) {
    for (const p of fpDef.pads.filter((q) => q.type === 'tht')) {
      box(2.5, 2.5, s.h, col(s.color), p.x, p.y, 0);
      box(0.64, 0.64, 6, GOLD, p.x, p.y, s.h);
    }
  } else if (s.ends) {
    // チップ部品: 本体＋両端の電極
    const L = b.w, W = b.h;
    box(L * 0.7, W, s.h, s.glow ? col(s.color, { emissive: s.color, emissiveIntensity: 0.35, transparent: true, opacity: 0.9 }) : col(s.color), cx, cy, 0);
    box(L * 0.15, W, s.h, METAL, cx - L * 0.425, cy, 0);
    box(L * 0.15, W, s.h, METAL, cx + L * 0.425, cy, 0);
  } else {
    box(b.w, b.h, s.h, col(s.color), cx, cy, s.lift || 0);
    if (s.button) cyl(1.75, 1.5, col('#3a3a3a'), cx, cy, s.h);
    if (s.pin1) {
      const p1 = fpDef.pads.find((p) => p.num === '1');
      if (p1) {
        // 1番ピン側の本体の角に印
        const mx = cx + Math.sign(p1.x - cx || -1) * (b.w / 2 - 0.4), my = cy + Math.sign(p1.y - cy || -1) * (b.h / 2 - 0.4);
        cyl(0.22, 0.02, col('#bbbbbb'), mx, my, (s.lift || 0) + s.h);
      }
    }
    if (s.band) box(b.w * 0.12, b.h, 0.02, col('#cfcfcf'), cx + b.w * 0.3, cy, s.h);
    // 本体の外に出ているパッドにはリード（SMD）
    for (const p of fpDef.pads) {
      if (p.type === 'tht') continue;
      const outside = Math.abs(p.x - cx) > b.w / 2 - 0.05 || Math.abs(p.y - cy) > b.h / 2 - 0.05;
      if (outside) box(Math.min(p.w, p.h) < 0.8 ? p.w * 0.6 : p.w * 0.5, Math.min(p.w, p.h) < 0.8 ? p.h * 0.6 : p.h * 0.5, 0.2, METAL, p.x, p.y, 0);
    }
  }
  // スルーホールのピンが反対面に出る
  for (const p of fpDef.pads) if (p.type === 'tht' && !s.header) cyl(p.drill / 2 * 0.8, t + 2.5, METAL, p.x, p.y, -t - 1.5, 10);
  for (const p of fpDef.pads) if (p.type === 'tht' && s.header) cyl(0.32, t + 2.5, GOLD, p.x, p.y, -t - 2.5, 8);
  return out;
}
