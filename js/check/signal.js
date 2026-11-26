// 信号経路の審査（USB・I2S・アナログ音声）
//
// ネットリストのピン名から信号の種類と向きを読み取り、抵抗・コンデンサを通り抜けてたどって、
//   USB コネクタ → USB を受ける IC、I2S を出す IC → I2S を受ける IC（DAC・アンプ）、
//   アナログ出力 → アンプの入力 → 出力のコネクタ（ジャック・スピーカー端子）
// の経路がつながり、左右・極性・役割（BCLK/LRCK/DATA）が合っているかを調べる。
// 部品ごとの決まり（設定ピンの意味・入力インピーダンス・最大出力など）は PART_KB にある部品だけ判定する。
//
// 結果: { issues:[{level:'error'|'warning'|'info', rule, message, refs, at}], chains:[{title, path:[...], status}],
//         checked:[{id,label,count}], unchecked:[...], summary:{errors,warnings,infos}, netHash, ranAt }

const LV = { ok: 0, info: 1, warning: 2, error: 3 };

// ---------------- 値・ネット ----------------
const UNIT = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, R: 1, '': 1 };
/** "470" "5.1k" "2.2n" "1u" "4k7" → 数値（単位なし）。読めなければ NaN */
export function parseValue(v) {
  const s = String(v ?? '').trim().replace(/Ω|ohm|F$/gi, '');
  let m = /^([\d.]+)\s*([pnuµmkKMR]?)(\d*)/.exec(s);
  if (!m) return NaN;
  const base = m[3] ? Number(`${m[1]}.${m[3]}`) : Number(m[1]);
  return base * (UNIT[m[2]] ?? 1);
}
const fmtR = (r) => (r >= 1e6 ? `${+(r / 1e6).toFixed(2)}MΩ` : r >= 1e3 ? `${+(r / 1e3).toFixed(2)}kΩ` : `${+r.toFixed(1)}Ω`);
const fmtF = (f) => (f >= 1e3 ? `${+(f / 1e3).toFixed(1)}kHz` : `${+f.toFixed(1)}Hz`);

export const isGndNet = (n) => /^(A|D|P|S|CP)?GND(_|$)|^VSS$|^0V$/i.test(String(n || ''));
export const isPowerRail = (n) => /^\+|^VBUS$|^VCC|^VDD|^VIN$|^VBAT$|^\d+V\d*/i.test(String(n || ''));
/** ネット名から電圧（+5V_SPK → 5、+3V3A → 3.3、VBUS → 5）。分からなければ NaN */
export function railVoltage(n) {
  const s = String(n || '');
  if (/^VBUS$/i.test(s)) return 5;
  const m = /(\d+)V(\d+)?/i.exec(s);
  return m ? Number(m[2] ? `${m[1]}.${m[2]}` : m[1]) : NaN;
}

// ---------------- ピンの役割 ----------------
const clean = (s) => String(s || '').replace(/\s+/g, '');
/** ピン名を "/" で分けた名前の候補（GPIO20/USB_D+ → [GPIO20, USB_D+]）と、かっこの中（T(L) → L） */
function nameParts(name) {
  const s = clean(name);
  const paren = (/\(([^)]*)\)/.exec(s) || [])[1] || '';
  const base = s.replace(/\([^)]*\)/g, '');
  return { all: base.split('/').filter(Boolean), paren };
}
const ch = (s) => (/L/i.test(s) && !/R/i.test(s) ? 'L' : /R/i.test(s) && !/L/i.test(s) ? 'R' : '');

/** 1 本のピンの役割 */
export function pinRole(comp, pin) {
  const { all, paren } = nameParts(pin.name);
  for (const n of all) {
    let m;
    if (/^(USB_?)?D\+$|^USB_?DP$|^DP$/i.test(n)) return { sig: 'usb', pol: '+' };
    if (/^(USB_?)?D-$|^USB_?D[MN]$|^DM$|^DN$/i.test(n)) return { sig: 'usb', pol: '-' };
    if (/^CC[12]$/i.test(n)) return { sig: 'cc' };
    if (/^(BCK|BCLK|SCLK|BITCLK)$/i.test(n)) return { sig: 'i2s', role: 'bclk' };
    if (/^(LRCK|LRCLK|WS|LRC|WCLK)$/i.test(n)) return { sig: 'i2s', role: 'lrck' };
    if (/^(DIN|SDIN|SDI|SDATA|DATA_?IN)$/i.test(n)) return { sig: 'i2s', role: 'din' };
    if (/^(MCLK|SCK|SYSCLK)$/i.test(n)) return { sig: 'i2s', role: 'mclk' };
    if ((m = /^(?:V?OUT|HPOUT|HP|LINEOUT)_?([LR])$|^([LR])_?OUT$/i.exec(n))) return { sig: 'aout', ch: (m[1] || m[2]).toUpperCase() };
    if ((m = /^OUT([PN])$/i.exec(n))) return { sig: 'aout', diff: m[1].toUpperCase() };
    if ((m = /^(?:OUT)?([LR])_?OUT?([PN+-])$|^OUT([LR])([PN+-])$/i.exec(n))) return { sig: 'aout', ch: (m[1] || m[3]).toUpperCase(), diff: /[P+]/i.test(m[2] || m[4]) ? 'P' : 'N' };
    if ((m = /^IN([LR])([+-]?)$|^([LR])IN([+-]?)$/i.exec(n))) return { sig: 'ain', ch: (m[1] || m[3]).toUpperCase(), inv: (m[2] || m[4]) === '-', noninv: (m[2] || m[4]) === '+' };
    if (comp.kind === 'connector') {
      if (/^(T|TIP)$/i.test(n)) return { sig: 'jack', ch: ch(paren) || 'L' };
      if (/^(R|RING|R1)$/i.test(n)) return { sig: 'jack', ch: ch(paren) || 'R' };
      if (/^(S|SLEEVE)$/i.test(n)) return { sig: 'jack', gnd: true };
      if (/^\+$/.test(n)) return { sig: 'term', pol: '+' };
      if (/^-$/.test(n)) return { sig: 'term', pol: '-' };
    }
  }
  return null;
}

// ---------------- 部品ごとの決まり ----------------
// 確かめた資料: PCM5102A / TPA6132A2 / MAX98357A のデータシート（TI・Analog Devices）
export const PART_KB = [
  {
    match: /^PCM510[12]A?/i, label: 'PCM5102A（I2S DAC）', fullScaleVrms: 2.1,
    straps(get) {
      const out = [];
      const lvl = (p) => { const n = get(p); return !n ? 'open' : isGndNet(n) ? 'low' : isPowerRail(n) ? 'high' : 'signal'; };
      if (lvl('SCK') === 'low') out.push(['info', 'SCK を GND に固定: マスタークロックなしで BCK から内部 PLL でクロックを作る（3 線式の I2S）']);
      else if (lvl('SCK') === 'open') out.push(['warning', 'SCK が未接続: GND に固定するかマスタークロックを入れてください']);
      out.push(lvl('FMT') === 'low' ? ['info', 'FMT = Low: 形式は I2S'] : lvl('FMT') === 'high' ? ['info', 'FMT = High: 形式は左詰め（Left-justified）。送る側も合わせること'] : ['warning', 'FMT の設定が分かりません']);
      const x = lvl('XSMT');
      if (x === 'low') out.push(['error', 'XSMT が GND: 常にミュートで音が出ません']);
      else if (x === 'signal') out.push(['info', 'XSMT は信号で制御: High でミュート解除（ファームウェアで High にすること）']);
      else if (x === 'open') out.push(['error', 'XSMT が未接続: ミュートが解除されない可能性']);
      if (lvl('FLT') === 'low') out.push(['info', 'FLT = Low: 通常のデジタルフィルター']);
      if (lvl('DEMP') === 'low') out.push(['info', 'DEMP = Low: デエンファシスなし']);
      return out;
    },
  },
  {
    match: /^TPA6132/i, label: 'TPA6132A2（ヘッドホンアンプ、DirectPath）', maxOutVrms: 1.1, maxOutNote: '1% 歪みで 1.1Vrms（電源 3.6V・100Ω）',
    // G0/G1 → 利得と 1 ピンあたりの入力インピーダンス
    gain(get) {
      const hi = (p) => { const n = get(p); return n && !isGndNet(n) && isPowerRail(n); };
      const g0 = hi('G0'), g1 = hi('G1');
      const t = { '00': [-6, 26.4e3], '10': [0, 19.8e3], '01': [3, 16.5e3], '11': [6, 13.2e3] }[`${g0 ? 1 : 0}${g1 ? 1 : 0}`];
      return { db: t[0], rin: t[1], inverting: true };
    },
    straps(get) {
      const en = get('EN');
      if (!en) return [['error', 'EN が未接続']];
      if (isGndNet(en)) return [['error', 'EN が GND: 常に止まっています']];
      return [[isPowerRail(en) ? 'info' : 'info', isPowerRail(en) ? 'EN を電源に直結: 常に動作' : 'EN は信号で制御']];
    },
  },
  {
    match: /^MAX9835[78]/i, label: 'MAX98357A（I2S 入力の D 級アンプ、モノラル）', mono: true,
    // SD_MODE（内部 100kΩ プルダウン）: 1.4V 超 = 左、0.77〜1.4V = 右、0.16〜0.77V = (L+R)/2、0.16V 未満 = 停止
    channel(get, comps, netPins) {
      const n = get('SD_MODE');
      if (!n) return { ch: 'off', why: 'SD_MODE が未接続（停止）' };
      if (isGndNet(n)) return { ch: 'off', why: 'SD_MODE が GND（停止）' };
      if (isPowerRail(n)) { const v = railVoltage(n); return { ch: 'L', why: `SD_MODE を ${n}（${v}V）に直結 → 左` }; }
      for (const p of netPins.get(n) || []) {
        const c = comps.get(p.ref);
        if (c?.kind !== 'resistor') continue;
        const other = c.pins.find((q) => q !== p.pinObj)?.net;
        const R = parseValue(c.value), V = railVoltage(other);
        if (!isPowerRail(other) || !(R > 0) || !(V > 0)) continue;
        const vsd = V * 100e3 / (100e3 + R);
        const sel = vsd > 1.4 ? 'L' : vsd >= 0.77 ? 'R' : vsd >= 0.16 ? 'L+R' : 'off';
        return { ch: sel, why: `SD_MODE = ${V}V × 100k/(100k+${fmtR(R)}) = ${vsd.toFixed(2)}V → ${{ L: '左', R: '右', 'L+R': '(L+R)/2', off: '停止' }[sel]}` };
      }
      return { ch: '?', why: 'SD_MODE は信号で制御（ファームウェアで決まる）' };
    },
    straps(get, comps, netPins) {
      const n = get('GAIN_SLOT');
      if (!n) return [['info', 'GAIN_SLOT 未接続: 利得 9dB']];
      if (isGndNet(n)) return [['info', 'GAIN_SLOT = GND: 利得 12dB']];
      if (isPowerRail(n)) return [['info', 'GAIN_SLOT = 電源: 利得 6dB']];
      for (const p of netPins.get(n) || []) {
        const c = comps.get(p.ref);
        if (c?.kind !== 'resistor') continue;
        const other = c.pins.find((q) => q !== p.pinObj)?.net;
        const R = parseValue(c.value);
        if (Math.abs(R - 100e3) / 100e3 < 0.1) return [['info', isGndNet(other) ? 'GAIN_SLOT を 100kΩ で GND: 利得 15dB' : 'GAIN_SLOT を 100kΩ で電源: 利得 3dB']];
      }
      return [['warning', 'GAIN_SLOT の設定が読み取れません']];
    },
  },
  { match: /^USBLC6/i, label: 'USBLC6（USB の ESD 保護）', passThrough: true },
];
const kbOf = (c) => PART_KB.find((k) => k.match.test(c.mpn || '') || k.match.test(c.value || ''));

// ---------------- 本体 ----------------
export function runSignals(project, pcb = null) {
  const nl = project.netlist;
  const issues = [];
  const chains = [];
  const checked = [];
  const sheetPos = new Map();
  for (const sh of project.schematic?.sheets || []) for (const c of sh.components || []) sheetPos.set(c.id, { x: c.x, y: c.y });
  if (!nl?.components?.length) {
    return { issues: [{ level: 'warning', rule: 'no_netlist', message: 'ネットリストがありません（回路図から作ってください）', refs: [] }], chains, checked, unchecked: [], summary: { errors: 0, warnings: 1, infos: 0 }, netHash: nl?.sourceHash || null, ranAt: Date.now() };
  }
  const comps = new Map(nl.components.map((c) => [c.ref, c]));
  const netPins = new Map();
  for (const c of nl.components) for (const p of c.pins || []) {
    if (!p.net || p.nc) continue;
    (netPins.get(p.net) || netPins.set(p.net, []).get(p.net)).push({ ref: c.ref, num: p.num, name: p.name, pinObj: p, comp: c, role: pinRole(c, p) });
  }
  const atOf = (ref) => { const c = comps.get(ref); return (c && sheetPos.get(c.compId)) || null; };
  const add = (level, rule, message, refs = []) => issues.push({ level, rule, message, refs, at: refs.length ? atOf(refs[0]) : null });
  const isIc = (c) => c.kind === 'ic' || /^U/.test(c.ref);
  const isPassive2 = (c) => ['resistor', 'capacitor', 'inductor', 'ferrite'].includes(c.kind) && (c.pins || []).filter((p) => p.net).length === 2;
  const pinByName = (c, re) => (c.pins || []).find((p) => nameParts(p.name).all.some((n) => re.test(n)));
  const getter = (c) => (name) => { const p = pinByName(c, new RegExp(`^${name}$`, 'i')); return p && !p.nc ? p.net || null : null; };
  const label = (c) => `${c.ref}（${c.value || c.mpn}）`;
  const chainStatus = (list) => list.filter((l) => l !== 'info').reduce((w, l) => (LV[l] > LV[w] ? l : w), 'ok');

  /**
   * ネットから抵抗・コンデンサを通り抜けて先をたどる
   * @returns {ends:[{ref,num,name,role,comp,via:[{ref,kind,value,R?,C?}], shunts:[...] }]}
   *   via: 通った直列部品、shunts: 途中で GND／電源へつながる部品（フィルター・プルダウンなど）
   */
  function trace(startNet, fromRef, { maxDepth = 6 } = {}) {
    const ends = [];
    const seen = new Set([startNet]);
    const walk = (net, via, depth) => {
      const here = netPins.get(net) || [];
      const shunts = [];
      for (const p of here) {
        if (p.ref === fromRef && depth === 0) continue;
        const c = p.comp;
        if (isPassive2(c)) {
          const other = c.pins.find((q) => q !== p.pinObj && q.net);
          if (!other) continue;
          if (isGndNet(other.net) || isPowerRail(other.net)) { shunts.push({ ref: c.ref, kind: c.kind, value: c.value, to: other.net, v: parseValue(c.value) }); continue; }
          if (seen.has(other.net) || depth >= maxDepth) continue;
          seen.add(other.net);
          walk(other.net, [...via, { ref: c.ref, kind: c.kind, value: c.value, v: parseValue(c.value), node: other.net, shuntsBefore: null }], depth + 1);
        }
      }
      // 直列に通ってきた最後の部品の後ろの節点にある分路（RC フィルター用）
      if (via.length) via[via.length - 1].shuntsAfter = shunts;
      for (const p of here) {
        const c = p.comp;
        if (isPassive2(c) || (p.ref === fromRef && via.length === 0)) continue;
        const kb = kbOf(c);
        if (kb?.passThrough) continue; // ESD 保護は通り抜け（同じネットのまま）
        if (c.kind === 'diode' && (c.pins || []).some((q) => isGndNet(q.net))) continue; // ESD・TVS（GND へ）
        ends.push({ ...p, via, shunts, net });
      }
    };
    walk(startNet, [], 0);
    return { ends };
  }

  // ============ USB ============
  const usbConns = nl.components.filter((c) => c.kind === 'connector' && (c.pins || []).some((p) => pinRole(c, p)?.sig === 'usb'));
  let usbDevice = null;
  for (const J of usbConns) {
    const path = [label(J)];
    const notes = [];
    for (const pol of ['+', '-']) {
      const pins = J.pins.filter((p) => pinRole(J, p)?.sig === 'usb' && pinRole(J, p).pol === pol && p.net);
      if (!pins.length) { notes.push('error'); add('error', 'usb_link', `${J.ref}: USB の D${pol} がつながっていません`, [J.ref]); continue; }
      const nets = [...new Set(pins.map((p) => p.net))];
      if (nets.length > 1) { notes.push('error'); add('error', 'usb_link', `${J.ref}: D${pol} のピンが別々のネット（${nets.join('、')}）です。表裏どちら向きでも使えるよう 1 本にまとめます`, [J.ref]); }
      const t = trace(nets[0], J.ref);
      const dev = t.ends.filter((e) => e.role?.sig === 'usb' && isIc(e.comp));
      const esd = (netPins.get(nets[0]) || []).filter((p) => kbOf(p.comp)?.passThrough || (p.comp.kind === 'diode'));
      if (!dev.length) { notes.push('error'); add('error', 'usb_link', `USB の D${pol}（${nets[0]}）が USB の信号を受ける IC につながっていません`, [J.ref]); continue; }
      for (const d of dev) {
        if (d.role.pol !== pol) { notes.push('error'); add('error', 'usb_swap', `USB の D+ と D− が入れ替わっています: ${J.ref} の D${pol} → ${d.ref} の ${d.name}`, [J.ref, d.ref]); }
        else { usbDevice = usbDevice || d.comp; }
        const ser = d.via.map((v) => `${v.ref} ${v.value}`).join(' → ');
        if (pol === '+') path.push(`${esd.length ? `ESD ${[...new Set(esd.map((e) => e.ref))].join('・')} → ` : ''}${ser ? ser + ' → ' : ''}${d.ref}.${d.name}`);
      }
      if (!esd.length) { notes.push('warning'); add('warning', 'usb_esd', `USB の D${pol} に ESD 保護がありません（コネクタの近くに入れるのが普通）`, [J.ref]); }
    }
    // CC: デバイス（電源を受ける側）は 5.1kΩ で GND へ
    for (const p of J.pins.filter((q) => pinRole(J, q)?.sig === 'cc')) {
      if (!p.net) { notes.push('error'); add('error', 'usb_cc', `${J.ref}.${p.name} が未接続: USB-C の充電器・PC から 5V が出ません`, [J.ref]); continue; }
      const rd = (netPins.get(p.net) || []).find((q) => q.comp.kind === 'resistor' && q.comp.pins.some((x) => x !== q.pinObj && isGndNet(x.net)));
      const R = rd ? parseValue(rd.comp.value) : NaN;
      if (!rd) { notes.push('error'); add('error', 'usb_cc', `${J.ref}.${p.name}（${p.net}）に GND への 5.1kΩ（Rd）がありません: USB-C の電源側が 5V を出しません`, [J.ref]); }
      else if (Math.abs(R - 5.1e3) / 5.1e3 > 0.1) { notes.push('warning'); add('warning', 'usb_cc', `${p.name} の GND への抵抗が ${fmtR(R)}（デバイスは 5.1kΩ）`, [rd.ref]); }
      else add('info', 'usb_cc', `${p.name}: ${rd.ref} ${rd.comp.value} で GND へ（USB-C のデバイスとして 5V を受けられる）`, [rd.ref]);
      const sense = (netPins.get(p.net) || []).filter((q) => isIc(q.comp) && q.ref !== J.ref);
      if (sense.length) add('info', 'usb_cc', `${p.name} を ${sense.map((s) => `${s.ref}.${s.name}`).join('・')} で読める（電源の能力 Default/1.5A/3A を電圧で判定。ファームウェアの処理が必要）`, [sense[0].ref]);
    }
    // 配線長（PCB があれば）
    if (pcb) {
      const len = (net) => pcb.tracks.filter((t) => t.net === net).reduce((s, t) => s + Math.hypot(t.a.x - t.b.x, t.a.y - t.b.y) / 1e6, 0);
      const dp = J.pins.find((p) => pinRole(J, p)?.pol === '+')?.net, dn = J.pins.find((p) => pinRole(J, p)?.pol === '-')?.net;
      if (dp && dn && (len(dp) || len(dn))) {
        const d = Math.abs(len(dp) - len(dn));
        add(d > 10 ? 'warning' : 'info', 'usb_len', `USB の配線長: D+ ${len(dp).toFixed(1)}mm・D− ${len(dn).toFixed(1)}mm（差 ${d.toFixed(1)}mm）。Full Speed（12Mbps）なら数 mm の差は問題になりません。差動インピーダンス（90Ω）はこの検査では見ていません`, [J.ref]);
      }
    }
    chains.push({ kind: 'usb', title: `USB: ${J.ref} → ${usbDevice ? usbDevice.ref : '?'}`, path, status: chainStatus(notes) });
  }
  checked.push({ id: 'usb', label: 'USB: D+/D− が USB を受ける IC の同じ極性のピンへ・ESD 保護・CC の 5.1kΩ・配線長の差' });

  // ============ I2S ============
  const rx = nl.components.filter((c) => isIc(c) && ['bclk', 'lrck', 'din'].every((r) => (c.pins || []).some((p) => pinRole(c, p)?.role === r && p.net)));
  const rxInfo = new Map(); // ref → { ch, driver }
  const groups = new Map(); // driver ref → Set(ピンの組)
  const drvRoles = new Map(); // 駆動側のピン → 役割の集合
  for (const R of rx) {
    const notes = [];
    const roleNets = ['bclk', 'lrck', 'din'].map((role) => R.pins.find((q) => pinRole(R, q)?.role === role && q.net)?.net);
    if (new Set(roleNets).size < 3) { notes.push('error'); add('error', 'i2s_role', `${R.ref}: BCLK・LRCK・DATA のうち同じネットにつながっているものがあります（${roleNets.join('・')}）`, [R.ref]); }
    const kb = kbOf(R);
    const drivers = {};
    for (const role of ['bclk', 'lrck', 'din']) {
      const p = R.pins.find((q) => pinRole(R, q)?.role === role && q.net);
      const here = netPins.get(p.net) || [];
      // 同じネットにつながる別の I2S 受け側で、役割が違うピン
      for (const q of here) if (q.ref !== R.ref && q.role?.sig === 'i2s' && q.role.role !== role && rx.includes(q.comp)) { notes.push('error'); add('error', 'i2s_role', `${R.ref}.${p.name} と ${q.ref}.${q.name} が同じネット ${p.net}（役割が違う: ${role.toUpperCase()} と ${q.role.role.toUpperCase()}）`, [R.ref, q.ref]); }
      const t = trace(p.net, R.ref, { maxDepth: 2 });
      const dr = t.ends.filter((e) => isIc(e.comp) && !rx.includes(e.comp));
      if (!dr.length) { notes.push('error'); add('error', 'i2s_driver', `${R.ref}.${p.name}（${p.net}）を駆動する IC がありません`, [R.ref]); continue; }
      if (dr.length > 1) { notes.push('warning'); add('warning', 'i2s_driver', `${R.ref}.${p.name}（${p.net}）を複数の IC（${dr.map((d) => d.ref).join('、')}）が駆動しています`, [R.ref]); }
      drivers[role] = dr[0];
      const k = `${dr[0].ref}.${dr[0].num}`;
      (drvRoles.get(k) || drvRoles.set(k, { pin: dr[0], roles: new Set() }).get(k)).roles.add(role);
    }
    const drRefs = [...new Set(Object.values(drivers).map((d) => d.ref))];
    if (drRefs.length > 1) { notes.push('error'); add('error', 'i2s_driver', `${R.ref} の BCLK・LRCK・DATA が別々の IC（${drRefs.join('、')}）から来ています`, [R.ref]); }
    const D = drivers.bclk?.comp;
    if (D) {
      const key = ['bclk', 'lrck', 'din'].map((r) => drivers[r]?.num).join('/');
      (groups.get(D.ref) || groups.set(D.ref, new Map()).get(D.ref)).set(key, [...((groups.get(D.ref).get(key)) || []), R.ref]);
    }
    // 部品ごとの設定ピン
    const get = getter(R);
    for (const [lv, msg] of kb?.straps ? kb.straps(get, comps, netPins) : []) { notes.push(lv); add(lv, 'i2s_strap', `${R.ref}: ${msg}`, [R.ref]); }
    let chn = 'stereo';
    if (kb?.channel) { const c = kb.channel(get, comps, netPins); chn = c.ch; add(c.ch === 'off' || c.ch === '?' ? 'warning' : 'info', 'i2s_channel', `${R.ref}: ${c.why}`, [R.ref]); if (c.ch === 'off') notes.push('warning'); }
    // マスタークロックのピン（部品の決まりが無いときだけ一般則で）
    const mclk = R.pins.find((q) => pinRole(R, q)?.role === 'mclk');
    if (mclk && !kb && !mclk.net) { notes.push('warning'); add('warning', 'i2s_mclk', `${R.ref}.${mclk.name}（マスタークロック）が未接続`, [R.ref]); }
    rxInfo.set(R.ref, { ch: chn, driver: D?.ref || null, kb, notes });
    const pinsTxt = D ? `${D.ref}（${['bclk', 'lrck', 'din'].map((r) => drivers[r]?.name).join('・')}）` : '?';
    chains.push({ kind: 'i2s', title: `I2S: ${pinsTxt} → ${label(R)}${kb?.mono ? `（${{ L: '左', R: '右', 'L+R': 'L+R', off: '停止', '?': '?' }[chn]}）` : ''}`, path: [pinsTxt, label(R)], status: chainStatus(notes) });
  }
  for (const { pin: dp, roles } of drvRoles.values()) {
    if (roles.size > 1) add('error', 'i2s_role', `${dp.ref}.${dp.name} が ${[...roles].map((x) => x.toUpperCase()).join(' と ')} を兼ねています（1 本のピンが別の役割の受け側につながっている）`, [dp.ref]);
  }
  for (const [dref, m] of groups) {
    if (m.size > 1) add('info', 'i2s_fanout', `${dref} は I2S を ${m.size} 組のピンに出しています（${[...m.values()].map((v) => v.join('・')).join(' / ')}）。同じ信号を全部の組に出す設定がファームウェアに必要です（ここでは確かめられません）`, [dref]);
  }
  if (usbDevice && rx.length) {
    const fromUsb = [...rxInfo.values()].filter((r) => r.driver === usbDevice.ref).length;
    if (fromUsb) add('info', 'usb_to_i2s', `USB の音声を I2S に変換するのは ${usbDevice.ref}（${usbDevice.value}）のファームウェアです（USB Audio の設定・サンプリング周波数・I2S の形式はファームウェアで決まり、ここでは確かめられません）`, [usbDevice.ref]);
    else add('warning', 'usb_to_i2s', `USB を受ける ${usbDevice.ref} が I2S を出していません（USB の音声が DAC・アンプに届かない）`, [usbDevice.ref]);
  }
  // ステレオの受け側が無いとき、モノラルアンプの左右がそろっているか
  const monos = [...rxInfo.entries()].filter(([, v]) => v.kb?.mono);
  if (monos.length >= 2) {
    const chs = monos.map(([, v]) => v.ch);
    if (!(chs.includes('L') && chs.includes('R'))) add('warning', 'i2s_channel', `モノラルアンプ ${monos.map(([r]) => r).join('・')} の左右が ${chs.join('・')}（左と右がそろっていない）`, monos.map(([r]) => r));
  }
  checked.push({ id: 'i2s', label: 'I2S: 受け側ごとに BCLK/LRCK/DATA を同じ IC が駆動・役割の取り違え・設定ピン（形式・ミュート・左右・利得。登録した部品のみ）' });

  // ============ アナログ音声 ============
  const outs = [];
  for (const c of nl.components.filter(isIc)) for (const p of c.pins || []) { const r = pinRole(c, p); if (r?.sig === 'aout' && p.net) outs.push({ c, p, r }); }
  const amps = new Set(outs.map((o) => o.c.ref).filter((ref) => (comps.get(ref).pins || []).some((p) => pinRole(comps.get(ref), p)?.sig === 'ain')));
  const levelVrms = new Map(); // `${ref}.${ch}` → 出力のフルスケール（分かるとき）
  for (const o of outs) {
    if (amps.has(o.c.ref)) continue; // アンプの出力は入力側からたどる
    const kb = kbOf(o.c);
    if (kb?.fullScaleVrms) levelVrms.set(`${o.c.ref}.${o.r.ch}`, kb.fullScaleVrms);
  }
  const analogChains = [];
  const followOut = (srcComp, srcPin, srcRole, srcCh, pathSoFar, notesSoFar, depth = 0) => {
    const t = trace(srcPin.net, srcComp.ref);
    if (!t.ends.length) { add('error', 'audio_open', `${srcComp.ref}.${srcPin.name}（${srcPin.net}）の先が何にもつながっていません`, [srcComp.ref]); analogChains.push({ path: [...pathSoFar, '（つながっていない）'], notes: [...notesSoFar, 'error'] }); return; }
    for (const e of t.ends) {
      const notes = [...notesSoFar];
      const ser = e.via.map((v) => `${v.ref} ${v.value}`);
      const path = [...pathSoFar, ...ser, `${e.ref}.${e.name}`];
      const refs = [srcComp.ref, e.ref];
      // 直列抵抗 → 後ろの節点の GND へのコンデンサ = ローパス
      let rSer = 0, cSer = null;
      for (const v of e.via) {
        if (v.kind === 'resistor' && v.v > 0) {
          rSer += v.v;
          for (const s of v.shuntsAfter || []) if (s.kind === 'capacitor' && isGndNet(s.to) && s.v > 0) {
            const fc = 1 / (2 * Math.PI * v.v * s.v);
            const lv = fc < 20e3 ? 'warning' : 'info'; notes.push(lv);
            add(lv, 'audio_filter', `${v.ref} ${v.value} と ${s.ref} ${s.value} のローパス: ${fmtF(fc)}${fc < 20e3 ? '（20kHz より低く、高音が落ちます）' : '（可聴域 20kHz より上。DAC の高域ノイズを落とす）'}`, [v.ref, s.ref]);
          }
        }
        if (v.kind === 'capacitor' && v.v > 0) cSer = v;
      }
      if (e.role?.sig === 'ain' && isIc(e.comp)) {
        if (e.role.ch && srcCh && e.role.ch !== srcCh) { notes.push('error'); add('error', 'audio_lr', `左右が入れ替わっています: ${srcComp.ref}.${srcPin.name}（${srcCh}）→ ${e.ref}.${e.name}（${e.role.ch}）`, refs); }
        const kb = kbOf(e.comp);
        const g = kb?.gain ? kb.gain(getter(e.comp)) : null;
        if (cSer) {
          if (g) {
            const fc = 1 / (2 * Math.PI * (g.rin + rSer) * cSer.v);
            const lv = fc > 20 ? 'warning' : 'info'; notes.push(lv);
            add(lv, 'audio_filter', `${cSer.ref} ${cSer.value}（直流カット）と ${e.ref} の入力インピーダンス ${fmtR(g.rin)}${rSer ? `＋直列 ${fmtR(rSer)}` : ''} のハイパス: ${fmtF(fc)}${fc > 20 ? '（20Hz より高く、低音が落ちます）' : '（20Hz より下）'}`, [cSer.ref, e.ref]);
          } else add('info', 'audio_filter', `${cSer.ref} ${cSer.value} で直流カット（${e.ref} の入力インピーダンスが分からないので低域の端は計算していません）`, [cSer.ref]);
        } else if (srcRole?.sig === 'aout' && !kbOf(srcComp)?.groundCentered && !g) {
          add('info', 'audio_dc', `${srcComp.ref} → ${e.ref} に直流カットのコンデンサがありません（出力が 0V 中心なら不要）`, refs);
        }
        // 反転入力（単一入力を − 側に入れ、+ 側を GND）
        if (e.role.inv) {
          const plus = e.comp.pins.find((q) => { const r = pinRole(e.comp, q); return r?.sig === 'ain' && r.ch === e.role.ch && r.noninv; });
          if (plus && isGndNet(plus.net)) add('info', 'audio_phase', `${e.ref}.${e.name}: 反転入力（+ 側は GND）。${e.role.ch} の位相が反転しますが、左右とも同じなら聞こえ方は変わりません`, [e.ref]);
        }
        // アンプの先へ（同じチャンネルの出力）
        const outPin = e.comp.pins.find((q) => { const r = pinRole(e.comp, q); return r?.sig === 'aout' && r.ch === e.role.ch && q.net; });
        if (!outPin) { notes.push('error'); add('error', 'audio_open', `${e.ref} の ${e.role.ch} チャンネルの出力ピンが見つかりません`, [e.ref]); analogChains.push({ path, notes }); continue; }
        // レベル（分かる部品だけ）
        const src = levelVrms.get(`${srcComp.ref}.${srcCh}`);
        let lvl = null;
        if (src && g) {
          lvl = src * 10 ** (g.db / 20);
          levelVrms.set(`${e.ref}.${e.role.ch}`, lvl);
          const mx = kb.maxOutVrms;
          if (mx) {
            const lv = lvl > mx ? 'error' : lvl > mx * 0.9 ? 'warning' : 'info'; notes.push(lv);
            add(lv, 'audio_level', `${e.ref} の ${e.role.ch} 出力: ${srcComp.ref} のフルスケール ${src}Vrms × 利得 ${g.db}dB = ${lvl.toFixed(2)}Vrms。最大出力は ${kb.maxOutNote}${lvl > mx ? ' を超え、大きな音で歪みます' : lvl > mx * 0.9 ? 'で余裕が 1 割未満。電源が低いと最大音量付近で歪むことがあります（ファームウェアで最大音量を少し下げると確実）' : ''}`, [e.ref]);
          }
        }
        if (depth < 3) followOut(e.comp, outPin, pinRole(e.comp, outPin), e.role.ch, [...path, `${e.ref}.${outPin.name}`], notes, depth + 1);
        continue;
      }
      if (e.role?.sig === 'jack') {
        if (e.role.gnd) { notes.push('error'); add('error', 'audio_jack', `${srcComp.ref}.${srcPin.name} がジャックの GND（スリーブ）につながっています`, refs); }
        else if (srcCh && e.role.ch !== srcCh) { notes.push('error'); add('error', 'audio_lr', `左右が入れ替わっています: ${srcComp.ref}.${srcPin.name}（${srcCh}）→ ${e.ref}.${e.name}（${e.role.ch}。チップ = 左、リング = 右）`, refs); }
        analogChains.push({ path, notes, end: e, ch: srcCh });
        continue;
      }
      if (e.role?.sig === 'term' || e.comp.kind === 'connector') {
        analogChains.push({ path, notes, end: e, ch: srcCh });
        continue;
      }
      analogChains.push({ path, notes, end: e, ch: srcCh });
    }
  };
  for (const o of outs) {
    if (amps.has(o.c.ref)) continue;
    const info = rxInfo.get(o.c.ref);
    // 差動出力（D 級アンプ）: チャンネルは I2S の左右選択から
    if (o.r.diff) {
      if (o.r.diff !== 'P') continue;
      const nPin = o.c.pins.find((q) => pinRole(o.c, q)?.diff === 'N' && (pinRole(o.c, q).ch || '') === (o.r.ch || ''));
      const chn = o.r.ch || info?.ch || '?';
      const ends = (p) => trace(p.net, o.c.ref).ends;
      const ep = ends(o.p), en = nPin ? ends(nPin) : [];
      const notes = [...(info?.notes || [])];
      const conn = ep.find((e) => e.comp.kind === 'connector');
      const connN = en.find((e) => e.comp.kind === 'connector');
      if (!conn || !connN) { notes.push('error'); add('error', 'audio_open', `${o.c.ref} の出力（${o.p.name}/${nPin?.name}）がスピーカー端子につながっていません`, [o.c.ref]); }
      else {
        if (conn.ref !== connN.ref) { notes.push('error'); add('error', 'audio_spk', `${o.c.ref} の + と − が別々のコネクタ（${conn.ref}・${connN.ref}）につながっています`, [o.c.ref]); }
        if (conn.role?.pol === '-' && connN.role?.pol === '+') { notes.push('warning'); add('warning', 'audio_polarity', `${o.c.ref} の OUTP/OUTN がスピーカー端子 ${conn.ref} の −/+ に逆につながっています（このスピーカーだけ逆相）`, [o.c.ref, conn.ref]); }
        // 端子のネット名・コネクタの表示の左右と、アンプの左右
        const nameCh = ch((/(?:^|_)([LR])(?:[PN+-]|$)/i.exec(conn.net) || [])[1] || '');
        if (nameCh && (chn === 'L' || chn === 'R') && nameCh !== chn) { notes.push('error'); add('error', 'audio_lr', `${o.c.ref} は ${chn === 'L' ? '左' : '右'}を鳴らしますが、${conn.ref}（ネット ${conn.net}）は ${nameCh === 'L' ? '左' : '右'}の端子です`, [o.c.ref, conn.ref]); }
        else if (!nameCh) add('info', 'audio_lr', `${conn.ref} の左右がネット名から分からないので照合していません（ネット名に L/R を入れると照合できます）`, [conn.ref]);
      }
      chains.push({ kind: 'audio', title: `スピーカー（${{ L: '左', R: '右', 'L+R': 'L+R', off: '停止', '?': '?', stereo: '?' }[chn]}）: ${o.c.ref} → ${conn?.ref || '?'}`, path: [`${info?.driver || '?'} → I2S`, label(o.c), `${o.p.name}/${nPin?.name}`, conn ? `${conn.ref}.${conn.name}/${connN?.name}` : '?'], status: chainStatus(notes) });
      continue;
    }
    followOut(o.c, o.p, o.r, o.r.ch, [`${label(o.c)}.${o.p.name}`], [...(info?.notes || [])]);
  }
  for (const a of analogChains) {
    const endTxt = a.end ? (a.end.comp.kind === 'connector' ? `${a.end.ref}.${a.end.name}` : a.end.ref) : '?';
    chains.push({ kind: 'audio', title: `アナログ（${a.ch === 'L' ? '左' : a.ch === 'R' ? '右' : '?'}）: ${a.path[0].split('.')[0].replace(/（.*$/, '')} → ${endTxt}`, path: a.path, status: chainStatus(a.notes) });
    if (a.end && a.end.comp.kind !== 'connector') add('warning', 'audio_end', `アナログ出力の行き先が出力のコネクタではありません: ${a.path.join(' → ')}`, [a.end.ref]);
  }
  // I2S を受けない部品の設定ピン（ヘッドホンアンプの EN など）
  for (const c of nl.components.filter(isIc)) {
    const kb = kbOf(c);
    if (!kb?.straps || rxInfo.has(c.ref)) continue;
    for (const [lv, msg] of kb.straps(getter(c), comps, netPins)) add(lv, 'audio_strap', `${c.ref}: ${msg}`, [c.ref]);
    if (kb.gain) { const g = kb.gain(getter(c)); add('info', 'audio_strap', `${c.ref}: 利得 ${g.db}dB（G0/G1 の設定）・入力インピーダンス ${fmtR(g.rin)}`, [c.ref]); }
  }
  checked.push({ id: 'audio', label: 'アナログ音声: 出力 → 直列の抵抗・コンデンサ → アンプの入力 → 出力 → ジャック・スピーカー端子のつながり、左右・極性、フィルターの周波数・レベル（登録した部品のみ）' });

  const unchecked = [
    'ファームウェアの設定（USB Audio のクラス・サンプリング周波数・ビット数、I2S の形式、GPIO の割り当て、ミュート解除の手順）',
    '信号の品質（USB の差動インピーダンス 90Ω、I2S の反射・クロストーク、アナログの雑音・グラウンドの回り込み）',
    `部品ごとの設定ピン・入力インピーダンス・最大出力（登録してある ${PART_KB.map((k) => k.label.replace(/（.*$/, '')).join('・')} 以外）`,
    '電源の投入・切断の順序とポップ音',
  ];
  const summary = {
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    infos: issues.filter((i) => i.level === 'info').length,
  };
  for (const ck of checked) ck.count = issues.filter((i) => i.level !== 'info' && i.rule.startsWith(ck.id === 'audio' ? 'audio' : ck.id)).length;
  return { issues, chains, checked, unchecked, summary, netHash: nl.sourceHash || null, ranAt: Date.now() };
}

/** 結果が今のネットリストのものか */
export function signalStatus(project) {
  const r = project.checks?.sig;
  if (!r) return 'none';
  return r.netHash && r.netHash === project.netlist?.sourceHash ? 'fresh' : 'stale';
}
