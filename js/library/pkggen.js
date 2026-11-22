// パッケージ名からフットプリントを自動生成する（推定）
// LCSC/JLCPCB のパッケージ名（例: "QFN-56-EP(7x7)", "SOP-8_L4.9-W3.9-P1.27-LS6.0-BL", "TSSOP-20", "0603"）を読み、
// JEDEC / IPC-7351 の代表的な寸法でパッドを作る。名前に寸法（P=ピッチ, W=本体幅, LS=端子先端間, (WxH)=本体）が
// あればそれを優先する。生成物は generated:true / verified:false で「推定・要確認」と表示する。
//
// ID 形式: "PKG:<種別>:<パッケージ名>"（種別でチップ部品のパッド寸法が変わるため）

const r4 = (v) => Math.round(v * 10000) / 10000;
const smd = (num, x, y, w, h, shape = 'roundrect') => ({ num: String(num), x: r4(x), y: r4(y), w: r4(w), h: r4(h), shape, type: 'smd' });

/** パッケージ名の正規化（全角・空白・大小文字） */
export function normPkg(pkg) {
  return String(pkg || '').normalize('NFKC').toUpperCase().replace(/\s+/g, '').replace(/×/g, 'X');
}

/** 名前に含まれる寸法パラメータ: P(ピッチ) W(本体幅) L(本体長) LS(端子先端間) と (AxB) */
export function pkgParams(p) {
  const num = (re) => { const m = p.match(re); return m ? Number(m[1]) : null; };
  const body = p.match(/\((\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)(?:X\d+(?:\.\d+)?)?\)/);
  return {
    pitch: num(/[-_]P(\d+(?:\.\d+)?)/),
    w: num(/[-_]W(\d+(?:\.\d+)?)/),
    l: num(/[-_]L(\d+(?:\.\d+)?)/),
    ls: num(/[-_]LS(\d+(?:\.\d+)?)/),
    bodyW: body ? Number(body[1]) : null,
    bodyH: body ? Number(body[2]) : null,
    ep: /-EP|EP\(|_EP|PAD/.test(p),
  };
}

// ---- 2端子チップ: [パッド中心x, パッド幅, パッド高さ, 本体w, 本体h]（IPC-7351 公称、KiCad 相当） ----
const CHIP = {
  '0201': [0.32, 0.46, 0.4, 0.6, 0.3],
  '0402': [0.51, 0.54, 0.64, 1.0, 0.5],
  '0603': [0.825, 0.8, 0.95, 1.6, 0.8],
  '0805': [0.9125, 1.025, 1.4, 2.0, 1.25],
  '1206': [1.4625, 1.125, 1.75, 3.2, 1.6],
  '1210': [1.4625, 1.125, 2.65, 3.2, 2.5],
  '1812': [2.1, 1.3, 3.4, 4.5, 3.2],
  '2010': [2.3, 1.2, 2.65, 5.0, 2.5],
  '2512': [2.95, 1.25, 3.35, 6.3, 3.2],
};
// タンタル・モールド品（EIA 3216 等）: [x, w, h, bw, bh]
const MOLDED = {
  3216: [1.375, 1.35, 1.35, 3.2, 1.6], 3528: [1.5, 1.6, 2.3, 3.5, 2.8],
  6032: [2.5, 2.0, 2.3, 6.0, 3.2], 7343: [3.1, 2.25, 2.55, 7.3, 4.3],
};
const CASE_LETTER = { A: 3216, B: 3528, C: 6032, D: 7343 };
// 2端子ダイオード系: [x, w, h, bw, bh]
const DIODE2 = {
  'SOD-923': [0.4, 0.3, 0.35, 0.8, 0.6], 'SOD-523': [0.7, 0.6, 0.5, 1.2, 0.8],
  'SOD-323': [1.05, 0.6, 0.45, 1.7, 1.25], 'SOD-123F': [1.4, 1.0, 1.0, 2.7, 1.6], 'SOD-123': [1.65, 0.9, 1.2, 2.7, 1.6],
  SMA: [2.0, 1.5, 1.7, 4.3, 2.6], SMB: [2.15, 1.8, 2.2, 4.3, 3.6], SMC: [3.4, 2.1, 3.2, 6.9, 5.9],
  'SOD-80': [1.75, 1.2, 1.7, 3.5, 1.6],
};
// SMD 電解コンデンサ（D=直径）: [x, w, h]
const ELEC = { 4: [1.8, 2.4, 1.6], 5: [2.2, 2.8, 1.6], 6.3: [2.7, 3.3, 1.6], 8: [3.35, 3.7, 2.5], 10: [4.25, 4.4, 2.5] };

function twoPad(x, w, h, bw, bh) {
  return { pads: [smd(1, -x, 0, w, h), smd(2, x, 0, w, h)], body: { w: bw, h: bh } };
}

/** 両側ガルウィング（SOIC/SOP/TSSOP/MSOP/SSOP/ESOP） */
function gullwing(n, pitch, leadSpan, bodyW, ep) {
  const half = n / 2;
  const padW = Math.min(2.0, Math.max(1.2, (leadSpan - bodyW) / 2 + 0.5));
  const x = leadSpan / 2 - padW / 2 + 0.15;
  const h = r4(pitch * 0.6);
  const y0 = -((half - 1) * pitch) / 2;
  const pads = [];
  for (let i = 0; i < half; i++) {
    pads.push(smd(i + 1, -x, y0 + i * pitch, padW, h));
    pads.push(smd(n - i, x, y0 + i * pitch, padW, h));
  }
  if (ep) pads.push(smd(n + 1, 0, 0, r4(bodyW * 0.6), r4(half * pitch * 0.55), 'rect'));
  pads.sort((a, b) => Number(a.num) - Number(b.num));
  return { pads, body: { w: bodyW, h: r4(half * pitch + 0.6) } };
}

/** 4辺（QFN: リードなし / QFP: ガルウィング）。番号は左上から反時計回り（左辺→下辺→右辺→上辺） */
function quad(n, bw, bh, pitch, kind, ep) {
  const per = n / 4;
  const pads = [];
  const span = (per - 1) * pitch;
  let len, wid, cx, cy;
  if (kind === 'QFN') {
    // 角で隣の辺のパッドと 0.2mm 以上離れるよう、内側への長さを制限する
    wid = r4(pitch * 0.5);
    const outer = Math.min(bw, bh) / 2 + 0.375;                 // パッド外端（本体より 0.375mm 外）
    const innerMin = span / 2 + wid / 2 + 0.2;                   // 内端の下限
    len = r4(Math.max(0.4, Math.min(0.875, outer - innerMin)));
    cx = r4(bw / 2 + 0.375 - len / 2); cy = r4(bh / 2 + 0.375 - len / 2);
  } else { len = 1.5; wid = r4(pitch * 0.55); cx = bw / 2 + 0.65; cy = bh / 2 + 0.65; }
  let k = 1;
  for (let i = 0; i < per; i++) pads.push(smd(k++, -cx, -span / 2 + i * pitch, len, wid));           // 左辺 上→下
  for (let i = 0; i < per; i++) pads.push(smd(k++, -span / 2 + i * pitch, cy, wid, len));            // 下辺 左→右
  for (let i = 0; i < per; i++) pads.push(smd(k++, cx, span / 2 - i * pitch, len, wid));             // 右辺 下→上
  for (let i = 0; i < per; i++) pads.push(smd(k++, span / 2 - i * pitch, -cy, wid, len));            // 上辺 右→左
  if (ep) {
    // 露出パッドは周囲のパッドの内端から 0.25mm 以上離す
    const ex = Math.min(bw * 0.6, 2 * (cx - len / 2 - 0.25)), ey = Math.min(bh * 0.6, 2 * (cy - len / 2 - 0.25));
    if (ex > 0.3 && ey > 0.3) pads.push(smd(n + 1, 0, 0, r4(ex), r4(ey), 'rect'));
  }
  return { pads, body: { w: bw, h: bh } };
}

/** DFN（2辺リードなし） */
function dfn(n, bw, bh, pitch, ep) {
  const half = n / 2;
  const y0 = -((half - 1) * pitch) / 2;
  const len = r4(Math.min(0.7, bw * 0.3));
  const x = r4(bw / 2 + 0.3 - len / 2);
  const pads = [];
  for (let i = 0; i < half; i++) {
    pads.push(smd(i + 1, -x, y0 + i * pitch, len, r4(pitch * 0.55)));
    pads.push(smd(n - i, x, y0 + i * pitch, len, r4(pitch * 0.55)));
  }
  const ex = Math.min(bw * 0.45, 2 * (x - len / 2 - 0.25));
  if (ep && ex > 0.3) pads.push(smd(n + 1, 0, 0, r4(ex), r4(half * pitch * 0.85), 'rect'));
  pads.sort((a, b) => Number(a.num) - Number(b.num));
  return { pads, body: { w: bw, h: bh } };
}

/** ピン数と本体寸法から、辺あたりのピン列が本体に収まる最大の標準ピッチを選ぶ */
function inferPitch(perSide, body, margin, cands = [0.8, 0.65, 0.5, 0.4, 0.35]) {
  for (const p of cands) if ((perSide - 1) * p <= body - margin + 1e-9) return p;
  return cands[cands.length - 1];
}

/**
 * パッケージ名からフットプリント定義を生成。対応しない名前なら null。
 * @param kind 回路図シンボル種別（チップ部品のパッド寸法の選択に使う）
 */
export function generateFootprint(kind, pkg) {
  const p = normPkg(pkg);
  if (!p) return null;
  const prm = pkgParams(p);
  let g = null, desc = '';

  // チップ部品（インチ表記 0402 等。メトリック 1005 等はインチに読み替え）
  const metric = { '0603M': '0201', 1005: '0402', 1608: '0603', 2012: '0805', 3216: '1206', 3225: '1210', 4532: '1812', 5025: '2010', 6332: '2512' };
  let chipSize = p.match(/^(?:[RCL]|LED)?_?(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/)?.[1];
  if (!chipSize && (kind === 'resistor' || kind === 'capacitor' || kind === 'inductor' || kind === 'led')) {
    const m = p.match(/^(?:[RCL]|LED)?_?(1005|1608|2012|3216|3225|4532|5025|6332)(?![0-9])/);
    if (m) chipSize = metric[m[1]];
  }
  if (chipSize && CHIP[chipSize]) { g = twoPad(...CHIP[chipSize]); desc = `チップ ${chipSize}`; }

  // タンタル（CASE-A / 3528 など）
  if (!g) {
    const m = p.match(/^CASE-?([ABCD])(?![A-Z])/) || p.match(/^(3216|3528|6032|7343)(?:-\d+)?$/);
    if (m) { const code = CASE_LETTER[m[1]] || Number(m[1]); g = twoPad(...MOLDED[code]); desc = `モールド ${code}`; }
  }

  // ダイオード系
  if (!g) {
    const k2 = /^SOD-?123F/.test(p) ? 'SOD-123F' : /^SOD-?123/.test(p) ? 'SOD-123' : /^SOD-?323/.test(p) ? 'SOD-323'
      : /^SOD-?523/.test(p) ? 'SOD-523' : /^SOD-?923/.test(p) ? 'SOD-923'
      : /^(SMA(?![A-Z])|DO-?214AC)/.test(p) ? 'SMA' : /^(SMB(?![A-Z])|DO-?214AA)/.test(p) ? 'SMB' : /^(SMC(?![A-Z])|DO-?214AB)/.test(p) ? 'SMC'
      : /^(SOD-?80|MINIMELF|LL-?34)/.test(p) ? 'SOD-80' : null;
    if (k2) { g = twoPad(...DIODE2[k2]); desc = k2; }
  }

  // SMD電解: "SMD,D6.3XL5.4MM" / "SMD,D6.3*L5.4" など
  if (!g) {
    const m = p.match(/D(\d+(?:\.\d+)?)[X*]L\d/);
    if (m && ELEC[Number(m[1])]) { const [x, w, h] = ELEC[Number(m[1])]; const d = Number(m[1]); g = twoPad(x, w, h, d + 0.3, d + 0.3); desc = `SMD電解 D${d}`; }
  }

  // SOT 系
  if (!g) {
    if (/^SOT-?23(-3)?(?![-0-9])|^SOT-?323$|^SC-?70(-3)?$/.test(p)) {
      const small = /323|SC-?70/.test(p);
      const x = small ? 0.95 : 0.9375, py = small ? 0.65 : 0.95, w = small ? 1.0 : 1.475, h = small ? 0.4 : 0.6;
      g = { pads: [smd(1, -x, -py, w, h), smd(2, -x, py, w, h), smd(3, x, 0, w, h)], body: { w: small ? 1.25 : 1.3, h: small ? 2.0 : 2.9 } };
      desc = small ? 'SOT-323' : 'SOT-23';
    } else if (/^SOT-?23-?([568])|^SOT-?363|^SC-?70-?([56])|^SC-?88/.test(p)) {
      const m = p.match(/^SOT-?23-?([568])/);
      const n = m ? Number(m[1]) : /SC-?70-?5/.test(p) ? 5 : 6;
      const small = !m;
      const pitch = small ? 0.65 : (n === 8 ? 0.65 : 0.95);
      const x = small ? 0.95 : 1.1375, w = small ? 1.0 : 1.325, h = small ? 0.4 : (n === 8 ? 0.45 : 0.6);
      const left = Math.ceil(n / 2);
      const pads = [];
      const ys = (k) => Array.from({ length: k }, (_, i) => -((k - 1) * pitch) / 2 + i * pitch);
      ys(left).forEach((y, i) => pads.push(smd(i + 1, -x, y, w, h)));
      // 5ピンは右側が2本（4,5）。右辺は下から上へ番号
      const rightYs = n === 5 ? [pitch, -pitch] : ys(n - left).reverse();
      rightYs.forEach((y, i) => pads.push(smd(left + 1 + i, x, y, w, h)));
      g = { pads, body: { w: small ? 1.25 : 1.6, h: small ? 2.0 : 2.9 } };
      desc = `${small ? 'SC-70' : 'SOT-23'}-${n}`;
    } else if (/^SOT-?89/.test(p)) {
      g = { pads: [smd(1, -1.5, 1.8, 0.6, 1.2), smd(2, 0, 1.8, 0.6, 1.2), smd(3, 1.5, 1.8, 0.6, 1.2), smd(2, 0, -0.65, 1.8, 2.3, 'rect')], body: { w: 4.5, h: 2.5 } };
      desc = 'SOT-89-3（タブ=2）';
    } else if (/^SOT-?223/.test(p)) {
      g = { pads: [smd(1, -3.15, -2.3, 2.0, 1.5), smd(2, -3.15, 0, 2.0, 1.5), smd(3, -3.15, 2.3, 2.0, 1.5), smd(2, 3.15, 0, 2.0, 3.8, 'rect')], body: { w: 3.5, h: 6.5 } };
      desc = 'SOT-223（タブ=2）';
    } else if (/^(TO-?252|DPAK)/.test(p)) {
      g = { pads: [smd(1, -2.28, 4.2, 1.0, 2.0), smd(3, 2.28, 4.2, 1.0, 2.0), smd(2, 0, -1.6, 5.8, 6.2, 'rect')], body: { w: 6.6, h: 6.1 } };
      desc = 'TO-252（タブ=2）';
    }
  }

  // 両側ガルウィング
  if (!g) {
    const m = p.match(/^(E?SOP|SOIC|H?TSSOP|MSOP|SSOP|VSSOP|E?MSOP)-?(\d{1,3})/);
    if (m) {
      const fam = m[1], n = Number(m[2]);
      const wide = /300MIL|W7\.5|-W7/.test(p);
      let pitch = prm.pitch, bodyW = prm.w, ls = prm.ls;
      if (fam === 'SOP' || fam === 'ESOP' || fam === 'SOIC') { pitch = pitch ?? 1.27; bodyW = bodyW ?? (wide ? 7.5 : 3.9); ls = ls ?? (wide ? 10.3 : 6.0); }
      else if (/TSSOP/.test(fam)) { pitch = pitch ?? 0.65; bodyW = bodyW ?? 4.4; ls = ls ?? 6.4; }
      else if (/MSOP|VSSOP/.test(fam)) { pitch = pitch ?? (n >= 10 ? 0.5 : 0.65); bodyW = bodyW ?? 3.0; ls = ls ?? 4.9; }
      else if (fam === 'SSOP') { pitch = pitch ?? (n <= 24 && !/W5\.3/.test(p) ? 0.635 : 0.65); bodyW = bodyW ?? (pitch === 0.635 ? 3.9 : 5.3); ls = ls ?? (pitch === 0.635 ? 6.0 : 7.8); }
      if (n % 2 === 0 && n >= 4) {
        g = gullwing(n, pitch, ls, bodyW, prm.ep || /^E|^HT/.test(fam));
        desc = `${fam}-${n} P${pitch} 端子間${ls}`;
      }
    }
  }

  // QFN / DFN / QFP
  if (!g) {
    const m = p.match(/^([VWTU]?QFN|[VWTU]?DFN|[LT]?QFP)-?(\d{1,3})/);
    if (m && prm.bodyW) {
      const fam = m[1], n = Number(m[2]);
      const bw = prm.bodyW, bh = prm.bodyH;
      if (/QFN|QFP/.test(fam) && !/DFN/.test(fam) && n % 4 === 0) {
        const isQFN = /QFN/.test(fam);
        const pitch = prm.pitch ?? inferPitch(n / 4, Math.min(bw, bh), isQFN ? 1.5 : 1.0, isQFN ? [0.65, 0.5, 0.4] : [0.8, 0.65, 0.5, 0.4]);
        g = quad(n, bw, bh, pitch, isQFN ? 'QFN' : 'QFP', isQFN && (prm.ep || true));
        desc = `${fam}-${n} ${bw}x${bh} P${pitch}${isQFN ? ' 露出パッド' : ''}`;
      } else if (/DFN/.test(fam) && n % 2 === 0) {
        const pitch = prm.pitch ?? inferPitch(n / 2, bh, 0.6, [0.65, 0.5, 0.4]);
        g = dfn(n, bw, bh, pitch, prm.ep || true);
        desc = `${fam}-${n} ${bw}x${bh} P${pitch} 露出パッド`;
      }
    }
  }

  // ピンヘッダ 1xN / 2xN（2.54mm）
  if (!g) {
    const m = p.match(/(?<![\d.])([12])[X*](\d{1,2})(?![\d.])/);
    if (m && /2\.54/.test(p) && /HDR|HEADER|PIN|2\.54/.test(p)) {
      const rows = Number(m[1]), cols = Number(m[2]);
      const pads = [];
      for (let i = 0; i < cols; i++) for (let r = 0; r < rows; r++) {
        const num = rows === 1 ? i + 1 : i * 2 + r + 1;
        pads.push({ num: String(num), x: r4((r - (rows - 1) / 2) * 2.54), y: r4((i - (cols - 1) / 2) * 2.54), w: 1.7, h: 1.7, shape: num === 1 ? 'rect' : 'circle', type: 'tht', drill: 1.0 });
      }
      g = { pads, body: { w: rows * 2.54, h: cols * 2.54 } };
      desc = `ピンヘッダ ${rows}x${cols} 2.54mm`;
    }
  }

  // SMD パワーインダクタ "SMD,4x4mm" 等（2パッド、両端電極の一般的な形）
  if (!g && kind === 'inductor') {
    const m = p.match(/(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)MM/);
    if (m) {
      const bw = Number(m[1]), bh = Number(m[2]);
      const w = r4(Math.min(1.8, bw * 0.3)), x = r4(bw / 2 - w / 2 + 0.2);
      g = twoPad(x, w, r4(bh * 0.85), bw, bh);
      desc = `SMDインダクタ ${bw}x${bh}`;
    }
  }

  // 水晶（SMD 4パッド）
  if (!g) {
    const m = p.match(/^(?:SMD|SMD-)?(3225|2520|2016|5032|7050)-?4P/);
    if (m) {
      const T = { 3225: [1.1, 0.85, 1.4, 1.15, 3.2, 2.5], 2520: [0.85, 0.65, 1.1, 1.0, 2.5, 2.0], 2016: [0.7, 0.5, 0.9, 0.8, 2.0, 1.6], 5032: [1.85, 1.2, 2.0, 1.8, 5.0, 3.2], 7050: [2.6, 1.6, 2.4, 2.2, 7.0, 5.0] }[m[1]];
      const [x, y, w, h, bw, bh] = T;
      g = { pads: [smd(1, -x, y, w, h, 'rect'), smd(2, x, y, w, h, 'rect'), smd(3, x, -y, w, h, 'rect'), smd(4, -x, -y, w, h, 'rect')], body: { w: bw, h: bh } };
      desc = `水晶 SMD${m[1]} 4パッド`;
    }
  }

  // 5050 LED（WS2812B 等 4パッド）
  if (!g && /^(SMD-?)?5050(-4P)?$|^LED-?SMD_?4P/.test(p)) {
    g = { pads: [smd(1, -2.45, -1.6, 1.5, 1.0), smd(2, -2.45, 1.6, 1.5, 1.0), smd(3, 2.45, 1.6, 1.5, 1.0), smd(4, 2.45, -1.6, 1.5, 1.0)], body: { w: 5, h: 5 } };
    desc = '5050 4パッド（WS2812B 配置）';
  }

  if (!g) return null;
  const xs = [], ys = [];
  for (const q of g.pads) { xs.push(q.x - q.w / 2, q.x + q.w / 2); ys.push(q.y - q.h / 2, q.y + q.h / 2); }
  xs.push(-g.body.w / 2, g.body.w / 2); ys.push(-g.body.h / 2, g.body.h / 2);
  const id = `PKG:${kind || 'any'}:${String(pkg).trim()}`;
  return Object.freeze({
    id, name: String(pkg).trim(), desc: `${desc}（パッケージ名から自動生成）`, package: String(pkg).trim(),
    pads: g.pads, body: g.body,
    courtyard: { x0: r4(Math.min(...xs) - 0.25), y0: r4(Math.min(...ys) - 0.25), x1: r4(Math.max(...xs) + 0.25), y1: r4(Math.max(...ys) + 0.25) },
    pin1: true, jlcRotation: 0, verified: false, generated: true,
    source: '標準寸法からの推定（データシートで要確認）',
  });
}
