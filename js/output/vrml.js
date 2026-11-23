// KiCad 用の 3D モデル（VRML 2.0 / .wrl）。形は 3D 表示と同じ簡易形状（view3d/parts3d.js）。
// KiCad は VRML の 1 単位を 0.1 インチ（2.54mm）として読む。座標は x 右・y 奥（基板の y の逆）・z 上（部品面から）。
// モデルはフットプリントの原点・表面基準で作る（裏面の部品は KiCad が反転して置く）。

import { partPrims } from '../view3d/parts3d.js';

const U = 1 / 2.54;
const n = (v) => { const r = Math.round(v * U * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };

function rgb(hex) {
  const m = String(hex).replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
  return v.map((x) => (Math.round((x / 255) * 1000) / 1000).toString()).join(' ');
}

/** 箱・円柱 → 頂点と面（mm、KiCad の向き） */
function mesh(p) {
  const pts = [], faces = [];
  const X = (x) => x, Y = (y) => -y;
  if (p.k === 'box') {
    const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.d / 2, y1 = p.y + p.d / 2, z0 = p.z0, z1 = p.z0 + p.h;
    for (const z of [z0, z1]) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) pts.push([X(x), Y(y), z]);
    faces.push([0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]);
  } else {
    const k = p.seg || 16;
    for (const z of [p.z0, p.z0 + p.h]) for (let i = 0; i < k; i++) {
      const a = (2 * Math.PI * i) / k;
      pts.push([X(p.x + p.r * Math.cos(a)), Y(p.y + p.r * Math.sin(a)), z]);
    }
    faces.push([...Array(k).keys()].reverse(), [...Array(k).keys()].map((i) => i + k));
    for (let i = 0; i < k; i++) { const j = (i + 1) % k; faces.push([i, j, j + k, i + k]); }
  }
  // 面の向きを外向きにそろえる（y を反転しているので、順番は形の中心から見て決める）
  const c = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length, a[2] + q[2] / pts.length], [0, 0, 0]);
  const fixed = faces.map((f) => {
    const [a, b, d] = [pts[f[0]], pts[f[1]], pts[f[2]]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const fc = f.reduce((s2, i) => [s2[0] + pts[i][0] / f.length, s2[1] + pts[i][1] / f.length, s2[2] + pts[i][2] / f.length], [0, 0, 0]);
    const out = nrm[0] * (fc[0] - c[0]) + nrm[1] * (fc[1] - c[1]) + nrm[2] * (fc[2] - c[2]);
    return out < 0 ? [...f].reverse() : f;
  });
  return { pts, faces: fixed };
}

/**
 * VRML の本文
 * @returns null（形が無い部品）または文字列
 */
export function vrmlModel(fpDef, value = '', { t = 1.6, title = '' } = {}) {
  const prims = partPrims(fpDef, value, t);
  if (!prims.length) return null;
  const L = ['#VRML V2.0 utf8', `# Pocket EDA の簡易 3D 形状${title ? `: ${title}` : ''}（実物の 3D モデルではない）`, '# 単位: 0.1 インチ（KiCad の VRML の単位）'];
  for (const p of prims) {
    const { pts, faces } = mesh(p);
    const m = p.m;
    L.push('Shape {');
    L.push(`  appearance Appearance { material Material { diffuseColor ${rgb(m.color)} specularColor ${m.metalness ? '0.6 0.6 0.6' : '0.1 0.1 0.1'} shininess ${m.metalness ? 0.6 : 0.1}${m.opacity != null && m.opacity < 1 ? ` transparency ${Math.round((1 - m.opacity) * 100) / 100}` : ''}${m.emissive ? ` emissiveColor ${rgb(m.emissive)}` : ''} } }`);
    L.push('  geometry IndexedFaceSet { solid TRUE creaseAngle 0.5');
    L.push(`    coord Coordinate { point [ ${pts.map(([x, y, z]) => `${n(x)} ${n(y)} ${n(z)}`).join(', ')} ] }`);
    L.push(`    coordIndex [ ${faces.map((f) => `${f.join(', ')}, -1`).join(', ')} ]`);
    L.push('  }');
    L.push('}');
  }
  return L.join('\n') + '\n';
}
