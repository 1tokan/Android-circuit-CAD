// 基板の 3D 表示（three.js）
// - 基板: 外形と全部の穴をくり抜いた板（板厚は製造仕様）
// - 表・裏の面: 製造データ（plot.js）から描いた画像を貼る。レジスト色・レジスト越しの銅・パッドの表面処理（金/銀）・シルク
// - 部品: フットプリントの本体寸法とパッケージから作った簡易形状（実物の 3D モデルではない）
// 座標: three の X = 基板 x、Z = 基板 y（下向き）、Y = 上（表面が +）。単位 mm。

import * as THREE from '../vendor/three.js';
import { buildPlot } from '../output/plot.js';
import { COLORS } from '../output/fabspec.js';
import { toMm, fpToBoard } from '../pcb/model.js';
import { esc } from '../core/util.js';
import { partPrims } from './parts3d.js';

const FR4 = '#c9b27c';

// ---------------- 面の画像（製造データをそのまま描く） ----------------
function drawPrims(g, prims, color) {
  g.fillStyle = color; g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
  let path = null;
  const flush = () => { if (path) { g.fill(path, 'evenodd'); path = null; } };
  const ringPath = (p, r) => { r.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); };
  for (const p of prims) {
    if (p.t === 'region') {
      if (p.dark) { flush(); path = new Path2D(); ringPath(path, p.rings); } else if (path) ringPath(path, p.rings);
      continue;
    }
    flush();
    if (p.t === 'line') { g.lineWidth = p.w; g.beginPath(); g.moveTo(p.a.x, p.a.y); g.lineTo(p.b.x, p.b.y); g.stroke(); continue; }
    if (p.t !== 'flash') continue;
    const a = p.ap, at = p.at;
    g.beginPath();
    switch (a.kind) {
      case 'C': g.arc(at.x, at.y, a.d / 2, 0, Math.PI * 2); g.fill(); break;
      case 'R': g.fillRect(at.x - a.w / 2, at.y - a.h / 2, a.w, a.h); break;
      case 'O': { const r = Math.min(a.w, a.h) / 2; g.roundRect(at.x - a.w / 2, at.y - a.h / 2, a.w, a.h, r); g.fill(); break; }
      case 'OutlineRect': a.corners.forEach((c, i) => (i ? g.lineTo(at.x + c.x, at.y + c.y) : g.moveTo(at.x + c.x, at.y + c.y))); g.closePath(); g.fill(); break;
      case 'RoundRect':
        a.corners.forEach((c, i) => (i ? g.lineTo(at.x + c.x, at.y + c.y) : g.moveTo(at.x + c.x, at.y + c.y))); g.closePath();
        g.lineWidth = a.r * 2; g.fill(); g.stroke(); break;
      case 'Oval': g.lineWidth = a.d; g.moveTo(at.x + a.a.x, at.y + a.a.y); g.lineTo(at.x + a.b.x, at.y + a.b.y); g.stroke(); break;
      default: break;
    }
  }
  flush();
}

/** 片面の画像。side: 'F' | 'B' */
function faceCanvas(plot, side, fab, scale) {
  const b = plot.board;
  const cv = document.createElement('canvas');
  cv.width = Math.max(16, Math.round(b.w * scale)); cv.height = Math.max(16, Math.round(b.h * scale));
  const g = cv.getContext('2d');
  g.setTransform(scale, 0, 0, scale, -b.x0 * scale, -b.y0 * scale);
  const mask = COLORS.mask[fab.maskColor] || COLORS.mask.green;
  g.fillStyle = mask; g.fillRect(b.x0, b.y0, b.w, b.h);
  // レジスト越しの銅（少し明るく見える）
  drawPrims(g, plot.layers[`${side}.Cu`], lighten(mask, 0.18));
  drawPrims(g, plot.layers[`${side}.SilkS`], COLORS.silk[fab.silkColor] || '#fff');
  // レジストの開口（パッド）: 表面処理の色。シルクは開口で切られる
  drawPrims(g, plot.layers[`${side}.Mask`], COLORS.finish[fab.finish] || '#ccc');
  return cv;
}

function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.min(255, Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// ---------------- 基板 ----------------
function boardShape(plot) {
  const b = plot.board;
  const s = new THREE.Shape();
  s.moveTo(b.x0, b.y0); s.lineTo(b.x1, b.y0); s.lineTo(b.x1, b.y1); s.lineTo(b.x0, b.y1); s.closePath();
  for (const h of [...plot.drills.pth, ...plot.drills.npth]) {
    const p = new THREE.Path();
    if (h.slot) {
      // 長穴: 両端の半円をつないだ形
      const { a, b } = h.slot, r = h.d / 2, ang = Math.atan2(b.y - a.y, b.x - a.x);
      p.absarc(a.x, a.y, r, ang + Math.PI / 2, ang + Math.PI * 1.5, false);
      p.absarc(b.x, b.y, r, ang - Math.PI / 2, ang + Math.PI / 2, false);
      p.closePath();
    } else p.absarc(h.x, h.y, h.d / 2, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  return s;
}

/** 形状の UV を基板の範囲に合わせる（画像の上端 = 基板の上端） */
function mapUv(geo, b) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - b.x0) / b.w, 1 - (pos.getY(i) - b.y0) / b.h);
  uv.needsUpdate = true;
}

function buildBoard(plot, fab, scale) {
  const t = fab.thicknessMm || 1.6;
  const shape = boardShape(plot);
  const group = new THREE.Group();
  // 板（側面は FR-4 の色）。XY 平面で押し出し、X 軸まわりに +90° 回して Z = 基板 y にする
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 16 }), new THREE.MeshStandardMaterial({ color: FR4, roughness: 0.8 }));
  body.rotation.x = Math.PI / 2;
  body.position.y = t / 2;
  group.add(body);
  for (const side of ['F', 'B']) {
    const geo = new THREE.ShapeGeometry(shape, 16);
    mapUv(geo, plot.board);
    const tex = new THREE.CanvasTexture(faceCanvas(plot, side, fab, scale));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.rotation.x = Math.PI / 2;
    m.position.y = side === 'F' ? t / 2 + 0.02 : -t / 2 - 0.02;
    group.add(m);
  }
  return { group, t };
}

// ---------------- 部品の簡易形状 ----------------
const MAT = {};
function mat(color, opt = {}) {
  const k = `${color}|${JSON.stringify(opt)}`;
  if (!MAT[k]) MAT[k] = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opt });
  return MAT[k];
}
/** 部品の簡易形状（parts3d.js の形のリスト）を three のメッシュにする */
function buildPart(f, t) {
  const g = new THREE.Group();
  const bottom = f.side === 'bottom';
  const dir = bottom ? -1 : 1;
  const surface = (t / 2 + 0.03) * dir;
  const rotY = -((f.rot || 0) * Math.PI) / 180;
  for (const p of partPrims(f.fpDef, f.value, t)) {
    const { color, ...opt } = p.m;
    const material = mat(color, opt);
    const c = fpToBoard(f, p.x, p.y);
    const m = p.k === 'box'
      ? new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), material)
      : new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, p.h, p.seg), material);
    m.position.set(c.x, surface + dir * (p.z0 + p.h / 2), c.y);
    if (p.k === 'box') m.rotation.y = rotY;
    g.add(m);
  }
  return g;
}

// ---------------- 画面 ----------------
/**
 * @param o { root, project, pcb, onClose }
 */
export async function openViewer3d({ root, project, pcb, onClose }) {
  const fab = project.board?.fab || {};
  const plot = buildPlot(project, pcb);
  const b = plot.board;
  root.innerHTML = `<div class="v3d-bar">
      <b>3D（${b.w.toFixed(1)}×${b.h.toFixed(1)} mm・${pcb.settings?.layers || 2}層・${fab.thicknessMm || 1.6} mm）</b>
      <button class="icon-btn" data-close aria-label="閉じる">✕</button>
    </div>
    <div class="v3d-canvas"></div>
    <div class="v3d-tools chips">
      <button class="chip" data-view="top">表</button><button class="chip" data-view="bottom">裏</button><button class="chip on" data-view="iso">斜め</button>
      <button class="chip on" data-parts>部品</button>
    </div>
    <p class="v3d-note note">1本指で回転・2本指で拡大と移動（「裏」は基板を上下に裏返した向き）。部品は寸法から作った簡易形状です（実物の3Dモデルではありません）。色はレジスト ${esc(fab.maskColor || 'green')}・表面処理 ${esc(fab.finish || '')}。</p>`;
  const host = root.querySelector('.v3d-canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    host.innerHTML = '<p class="err">この端末では 3D 表示（WebGL）が使えません。</p>';
    root.querySelector('[data-close]').onclick = () => onClose();
    return null;
  }
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#20252d');
  scene.add(new THREE.HemisphereLight('#ffffff', '#445', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(30, 80, 50); scene.add(sun);
  const back = new THREE.DirectionalLight('#ffffff', 1.3); back.position.set(-30, -60, -40); scene.add(back);

  const scale = Math.min(24, 4096 / Math.max(b.w, b.h));
  const { group: boardGroup, t } = buildBoard(plot, fab, scale);
  scene.add(boardGroup);
  const parts = new THREE.Group();
  for (const f of pcb.footprints) {
    const x = toMm(f.x), y = toMm(f.y);
    if (x < b.x0 - 5 || x > b.x1 + 5 || y < b.y0 - 5 || y > b.y1 + 5) continue; // 基板の外（未配置）は出さない
    parts.add(buildPart(f, t));
  }
  scene.add(parts);

  const center = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.y0 + b.y1) / 2);
  const span0 = Math.max(b.w, b.h, 10);
  // 近・遠クリップ面を基板の大きさに合わせる（広すぎると裏面がちらつく）
  const camera = new THREE.PerspectiveCamera(40, 1, span0 / 50, span0 * 30);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  // 画面の縦横比に合わせて基板全体が収まる距離
  const fitDist = (k = 1.15) => {
    const v = THREE.MathUtils.degToRad(camera.fov) / 2;
    const h = Math.atan(Math.tan(v) * camera.aspect);
    return Math.max(b.h / 2 / Math.tan(v), b.w / 2 / Math.tan(h)) * k + t;
  };
  const place = (dx, dy, dz) => {
    const d = fitDist(dy < 0 || dx || dz ? 1.25 : 1.15) / Math.hypot(dx, dy, dz);
    camera.position.set(center.x + dx * d, dy * d, center.z + dz * d);
    controls.target.copy(center);
  };
  const views = {
    iso: () => place(0.3, 1, 0.9),
    top: () => place(0, 1, 0.0001),
    bottom: () => place(0, -1, 0.0001),
  };
  let current = 'iso';
  let frame = 0;
  const draw = () => { renderer.render(scene, camera); };
  const loop = () => { frame = requestAnimationFrame(loop); if (controls.update()) draw(); };
  const resize = () => {
    const w = host.clientWidth || 360, h = host.clientHeight || 400;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    const first = !resize.done;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (first) { resize.done = true; views[current](); controls.update(); }
    draw();
  };
  controls.addEventListener('change', draw);
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  loop();

  const close = () => {
    cancelAnimationFrame(frame);
    ro.disconnect();
    controls.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material?.map) o.material.map.dispose(); });
    renderer.dispose();
    renderer.forceContextLoss?.();
    onClose();
  };
  root.querySelector('[data-close]').onclick = close;
  root.querySelectorAll('[data-view]').forEach((btn) => {
    btn.onclick = () => {
      current = btn.dataset.view; views[current]();
      controls.update(); draw();
      root.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === btn));
    };
  });
  root.querySelector('[data-parts]').onclick = (e) => { parts.visible = !parts.visible; e.target.classList.toggle('on', parts.visible); draw(); };
  const api = { scene, camera, renderer, draw, close, parts, boardGroup, stats: { parts: parts.children.length, holes: plot.drills.pth.length + plot.drills.npth.length } };
  root._viewer = api;
  return api;
}
