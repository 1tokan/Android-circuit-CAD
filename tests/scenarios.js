// テストプロジェクト A〜E を作り、回路図 → ネットリスト → ERC → PCB（基板内に並べる・GNDベタ）→ DRC → Gerber/ドリル/ZIP → BOM/CPL
// まで通しで実行する。Node（単体テスト）と Android 実機/エミュレータの WebView（tests/device）の両方で動く。
// base: アプリの js/ がある場所の URL（末尾 /）。例: Node は file:///.../pocket-eda/、WebView は https://localhost/
//
// 接続は「ピンの先端にネットラベルを置く」方法で作る（ラベルはピンと同じ点で接続し、同じ名前どうしがつながる）。
// 電源ネットは最初のピンに電源記号を置く（ERC で電源入力ピンに供給があると判定させるため）。

export async function loadModules(base) {
  const im = (p) => import(new URL(p, base).href);
  const [project, model, conn, parts, fps, netlist, pcb, zonefill, erc, drc, plot, gerber, zip, asm] = await Promise.all([
    im('js/core/project.js'), im('js/schematic/model.js'), im('js/schematic/connectivity.js'), im('js/library/parts.js'),
    im('js/library/footprints.js'), im('js/netlist/netlist.js'), im('js/pcb/model.js'), im('js/pcb/zonefill.js'),
    im('js/check/erc.js'), im('js/check/drc.js'), im('js/output/plot.js'), im('js/output/gerber.js'), im('js/output/zip.js'), im('js/output/assembly.js'),
  ]);
  return { project, model, conn, parts, fps, netlist, pcb, zonefill, erc, drc, plot, gerber, zip, asm };
}

const POWER = new Set(['GND', '+5V', '+3V3', 'VBUS', 'VCC']);

/**
 * @param spec { name, parts: [[ref, partOrPredicate, props?]], nets: { NET: ['R1.1', 'U1.3', ...] } }
 */
export function buildProject(M, spec) {
  const prj = M.project.createProject(spec.name);
  const sh = prj.schematic.sheets[0];
  const byRef = new Map();
  let i = 0;
  for (const [ref, pp, extra = {}] of spec.parts) {
    const part = typeof pp === 'function' ? M.parts.BUILTIN_PARTS.find(pp) : M.parts.normalizePart(pp);
    if (!part) throw new Error(`${spec.name}: 部品が見つかりません (${ref})`);
    if (!prj.library.parts.some((p) => p.id === part.id)) prj.library.parts.push(part);
    // 部品は 40 グリッド間隔で並べる（ピンどうしが重ならない）
    const x = (i % 6) * 40, y = Math.floor(i / 6) * 40;
    i++;
    const c = M.model.addComponent(sh, part.kind, x, y, {
      partId: part.id, value: part.value, footprint: M.parts.partFootprint(part)?.id || part.footprint,
      ...(part.symbol?.pinCount ? { pinCount: part.symbol.pinCount, pinNames: part.symbol.pinNames || '' } : {}),
      ...extra,
    });
    c.ref = ref;
    byRef.set(ref, c);
  }
  const pins = M.conn.pinPositions(sh);
  const pinOf = (s) => {
    const [ref, num] = s.split('.');
    const c = byRef.get(ref);
    const p = c && pins.find((q) => q.compId === c.id && q.pin === num);
    if (!p) throw new Error(`${spec.name}: ピン ${s} がありません`);
    return p;
  };
  for (const [net, list] of Object.entries(spec.nets)) {
    list.forEach((s, k) => {
      const p = pinOf(s);
      if (k === 0 && POWER.has(net)) {
        const sym = M.model.addComponent(sh, net === 'GND' ? 'gnd' : 'power', p.x, p.y, { net });
        sym.props.net = net;
      } else M.model.addLabel(sh, p.x, p.y, net);
    });
  }
  return prj;
}

// ---------------- テストプロジェクト ----------------
const P = {
  r10k: (p) => p.name === '抵抗 10kΩ 1% 0805', r1k: (p) => p.name === '抵抗 1kΩ 1% 0805', r330: (p) => p.name === '抵抗 330Ω 1% 0805',
  c100n: (p) => p.name === '積層セラコン 100nF 50V X7R 0805', c10u: (p) => p.name === '積層セラコン 10uF 25V X5R 0805', c1u: (p) => p.name === '積層セラコン 1uF 25V X5R 0603',
  led: (p) => p.name === 'LED 赤 0805', ledg: (p) => p.name === 'LED 緑 0805', op: (p) => p.kind === 'opamp', ldo: (p) => p.mpn === 'AMS1117-3.3',
  h2: (p) => p.name === 'ピンヘッダ 1x02 2.54mm', h4: (p) => p.name === 'ピンヘッダ 1x04 2.54mm', jst: (p) => p.name.startsWith('JST PH 2ピン'), sw: (p) => p.kind === 'switch',
};

/** 試験用の部品データ（内蔵に無いもの）。ピン番号はこの試験の接続に使う分だけを想定 */
const ESP32S3 = {
  name: 'ESP32-S3（QFN-56・試験用）', kind: 'ic', value: 'ESP32-S3', mpn: 'ESP32-S3', package: 'QFN-56-EP(7x7)', footprint: 'PKG:ic:QFN-56-EP(7x7)',
  symbol: { kind: 'ic', pinCount: 57, pinNames: Object.assign(Array(57).fill(''), { 1: 'VDD3P3', 2: 'VDD3P3', 3: 'CHIP_PU', 4: 'GPIO0', 5: 'GPIO1', 7: 'GPIO3', 8: 'GPIO4', 56: 'GND' }).join(',') }, // pinNames の添字0=ピン1
  // 使わないピンは「未使用」（パッドは残る）
  pinMap: Object.fromEntries(Array.from({ length: 57 }, (_, k) => String(k + 1)).map((n) => [n, ['2', '3', '4', '5', '6', '8', '9', '57'].includes(n) ? [n] : []])),
};
const USB_HDR = {
  name: 'USB 電源入力（4ピンヘッダで代用・試験用）', kind: 'connector', value: 'USB_PWR', package: 'Header 1x4', footprint: 'PinHeader_1x04_P2.54mm',
  symbol: { kind: 'connector', pinCount: 4, pinNames: 'VBUS,D-,D+,GND' }, pinMap: { 1: ['1'], 2: [], 3: [], 4: ['4'] },
};

export const SPECS = {
  A: {
    name: 'テストA LED点灯', parts: [['J1', P.jst], ['R1', P.r330], ['D1', P.led]],
    nets: { VBAT: ['J1.1', 'R1.1'], LED_A: ['R1.2', 'D1.2'], GND: ['J1.2', 'D1.1'] },
    expect: { nets: { LED_A: ['D1.2', 'R1.2'], GND: ['D1.1', 'J1.2'] } },
  },
  B: {
    name: 'テストB 非反転増幅', parts: [['U1', P.op], ['R1', P.r10k], ['R2', P.r1k], ['C1', P.c100n], ['J1', P.h4], ['J2', P.h2]],
    nets: {
      '+5V': ['J1.1', 'U1.8', 'C1.1'], GND: ['J1.4', 'U1.4', 'R2.2', 'C1.2', 'J2.2'],
      IN: ['J1.2', 'U1.3'], FB: ['U1.2', 'R1.2', 'R2.1'], OUT: ['U1.1', 'R1.1', 'J2.1', 'J1.3'],
    },
    expect: { nets: { FB: ['R1.2', 'R2.1', 'U1.2'], OUT: ['J1.3', 'J2.1', 'R1.1', 'U1.1'] } },
  },
  C: {
    name: 'テストC ESP32-S3', parts: [
      ['U1', ESP32S3], ['U2', P.ldo], ['C1', P.c10u], ['C2', P.c10u], ['C3', P.c100n], ['C4', P.c100n], ['R1', P.r10k], ['C5', P.c1u],
      ['SW1', P.sw], ['R2', P.r10k], ['R3', P.r330], ['D1', P.ledg], ['J1', P.h2], ['J2', P.h4], ['R4', P.r10k], ['R5', P.r10k]],
    nets: {
      '+5V': ['J1.1', 'U2.3', 'C1.1'], GND: ['J1.2', 'U2.1', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'U1.57', 'SW1.2', 'D1.1', 'J2.2'],
      '+3V3': ['U2.2', 'C2.1', 'C3.1', 'C4.1', 'U1.2', 'U1.3', 'R1.1', 'R2.1', 'J2.1', 'R4.1', 'R5.1'],
      EN: ['U1.4', 'R1.2', 'C5.1'], BOOT: ['U1.5', 'R2.2', 'SW1.1'], LED: ['U1.6', 'R3.1'], LED_K: ['R3.2', 'D1.2'],
      SDA: ['U1.8', 'J2.3', 'R4.2'], SCL: ['U1.9', 'J2.4', 'R5.2'],
    },
    expect: { nets: { EN: ['C5.1', 'R1.2', 'U1.4'], SDA: ['J2.3', 'R4.2', 'U1.8'] } },
  },
  D: {
    name: 'テストD 4chマイク入力',
    parts: [['J5', P.h2], ['J6', P.h4], ['R9', P.r10k], ['R10', P.r10k], ['C9', P.c10u], ['C10', P.c100n],
      ...[1, 2, 3, 4].flatMap((n) => [[`J${n}`, P.h2], [`C${n}`, P.c1u], [`R${n}`, P.r10k], [`U${n}`, P.op], [`C${n + 4}`, P.c100n]])],
    nets: {
      '+5V': ['J5.1', 'R9.1', ...[1, 2, 3, 4].flatMap((n) => [`U${n}.8`, `C${n + 4}.1`])],
      GND: ['J5.2', 'R10.2', 'C9.2', 'C10.2', ...[1, 2, 3, 4].flatMap((n) => [`J${n}.2`, `U${n}.4`, `C${n + 4}.2`])],
      VREF: ['R9.2', 'R10.1', 'C9.1', 'C10.1', ...[1, 2, 3, 4].map((n) => `R${n}.2`)],
      ...Object.fromEntries([1, 2, 3, 4].flatMap((n) => [[`MIC${n}`, [`J${n}.1`, `C${n}.1`]], [`IN${n}`, [`C${n}.2`, `R${n}.1`, `U${n}.3`]], [`OUT${n}`, [`U${n}.1`, `U${n}.2`, `J6.${n}`]]])),
    },
    expect: { nets: { VREF: ['C10.1', 'C9.1', 'R1.2', 'R10.1', 'R2.2', 'R3.2', 'R4.2', 'R9.2'], OUT3: ['J6.3', 'U3.1', 'U3.2'] } },
  },
  E: {
    name: 'テストE USB電源・LDO', parts: [['J1', USB_HDR], ['U1', P.ldo], ['C1', P.c10u], ['C2', P.c10u], ['C3', P.c100n], ['R1', P.r330], ['D1', P.led], ['J2', P.h2]],
    nets: {
      VBUS: ['J1.1', 'U1.3', 'C1.1'], GND: ['J1.4', 'U1.1', 'C1.2', 'C2.2', 'C3.2', 'D1.1', 'J2.2'],
      '+3V3': ['U1.2', 'C2.1', 'C3.1', 'R1.1', 'J2.1'], LED_A: ['R1.2', 'D1.2'],
    },
    expect: { nets: { '+3V3': ['C2.1', 'C3.1', 'J2.1', 'R1.1', 'U1.2'], VBUS: ['C1.1', 'J1.1', 'U1.3'] } },
  },
};

const now = () => (globalThis.performance ? performance.now() : Date.now());

/** 通しの実行。各工程の結果と時間（ms）を返す */
export async function runPipeline(M, key, { boards = 5, layers = 2 } = {}) {
  const spec = SPECS[key];
  const t = {};
  const lap = async (name, fn) => { const s = now(); const r = await fn(); t[name] = Math.round((now() - s) * 10) / 10; return r; };
  const prj = await lap('schematic', () => buildProject(M, spec));
  const nl = await lap('netlist', () => M.netlist.generateNetlist(prj));
  prj.netlist = nl;
  const erc = await lap('erc', () => M.erc.runErc(prj));
  const pcb = M.pcb.ensurePcb(prj);
  pcb.settings.layers = layers;
  const resolve = (c) => { const part = prj.library.parts.find((p) => p.id === c.partId); return (part && M.parts.partFootprint(part)) || M.fps.getFootprint(c.footprint); };
  await lap('import', () => M.pcb.importNetlist(pcb, nl, resolve));
  // 基板の大きさ: 部品の外形枠の面積の 3 倍を目安に、縦横比 4:3、5mm 単位
  const area = pcb.footprints.reduce((s, f) => { const b = M.pcb.fpBox(f); return s + (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1); }, 0);
  const w = Math.max(20, Math.ceil(Math.sqrt(area * 3 * 4 / 3) / 5) * 5), h = Math.max(15, Math.ceil((area * 3) / w / 5) * 5);
  M.pcb.setOutlineRect(pcb, w, h);
  const arranged = await lap('arrange', () => M.pcb.arrangeInBoard(pcb));
  M.pcb.addBoardZone(pcb, 'B.Cu', 'GND');
  if (layers >= 4) {
    // 内層: GND と電源の面
    M.pcb.addBoardZone(pcb, 'In1.Cu', 'GND');
    const pw = nl.nets.map((n) => n.name).find((n) => /^\+|VBUS|VCC/.test(n));
    if (pw) M.pcb.addBoardZone(pcb, 'In2.Cu', pw);
  }
  const fills = await lap('zoneFill', () => M.zonefill.fillAllZones(pcb, M.drc.drcRules(prj)));
  const drc = await lap('drc', () => M.drc.runDrc(prj, pcb));
  const plot = await lap('plot', () => M.plot.buildPlot(prj, pcb));
  const files = await lap('gerber', () => M.gerber.gerberFiles(plot, { project: spec.name, version: 'test' }));
  const zipBytes = await lap('zip', () => M.zip.makeZip(files));
  const asm = await lap('assembly', () => M.asm.buildAssembly(prj, pcb, { boards }));
  const bom = M.asm.bomCsv(asm), cpl = M.asm.cplCsv(asm);
  // 期待ネットの照合
  const netPins = (name) => (nl.nets.find((n) => n.name === name)?.nodes || []).map((x) => `${x.ref}.${x.pin}`);
  const netMismatch = Object.entries(spec.expect.nets).filter(([n, want]) => JSON.stringify([...new Set(netPins(n))].sort()) !== JSON.stringify([...want].sort())).map(([n, want]) => ({ net: n, want, got: [...new Set(netPins(n))].sort() }));
  const byRule = (r) => r.issues.reduce((m, i) => ((m[`${i.level}:${i.rule}`] = (m[`${i.level}:${i.rule}`] || 0) + 1), m), {});
  return {
    key, name: spec.name,
    components: nl.components.length, nets: nl.nets.length, netlistErrors: nl.problems.filter((p) => p.level === 'error').map((p) => p.message),
    netMismatch,
    erc: { errors: erc.summary.errors, warnings: erc.summary.warnings, byRule: byRule(erc), errorMessages: erc.issues.filter((i) => i.level === 'error').map((i) => i.message) },
    board: { w, h }, arranged: { moved: arranged.moved.length, notFit: arranged.notFit },
    zone: [...fills.values()].map((f) => ({ polygons: f.polygons.length, islandsRemoved: f.islandsRemoved })),
    drc: { errors: drc.summary.errors, warnings: drc.summary.warnings, byRule: byRule(drc), unrouted: drc.summary.unrouted },
    gerber: { files: files.map((f) => f.name.replace(/^.*-/, '')), zipBytes: zipBytes.length },
    assembly: { bomLines: asm.bom.length, cplRows: asm.cpl.length, errors: asm.problems.filter((p) => p.level === 'error').length, bomBytes: bom.length, cplBytes: cpl.length },
    ms: t,
  };
}
