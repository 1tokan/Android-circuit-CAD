# KiCad 7 で書き出しを確かめる（tests/tools/kicad-verify.mjs から呼ぶ）
#  1) 基板: 読み込み、パッドの位置・ネット・数を Pocket EDA と照合
#  2) フットプリントのライブラリ（PocketEDA.pretty）: 基板の各部品をライブラリから読み直し、同じ向き・面に置いたときのパッドが一致するか
#  3) 3D モデル: 各部品のモデルのファイルがあるか
#  4) 回路図との整合: kicad-cli のネットリスト（回路図から）のパッドのネット名と、基板のパッドのネット名が一致するか。部品・フットプリント名・パスも
#  5) ゾーンを塗って DRC（drc.rpt）
import sys, os, json, math, traceback, pcbnew
import xml.etree.ElementTree as ET
pcbpath, refpath, report, netxml = sys.argv[1:5]
ref = json.load(open(refpath))
root = os.path.dirname(os.path.abspath(pcbpath))
def main():
    global b, problems
    b = pcbnew.LoadBoard(pcbpath)
    # 5) DRC（先に。ほかの照合でライブラリから読んだ部品を扱ったあとだと pcbnew が落ちることがある）
    pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.BuildConnectivity()
    pcbnew.WriteDRCReport(b, report, pcbnew.EDA_UNITS_MILLIMETRES, True)
    if not os.path.exists(report): bad('DRC did not run (.kicad_dru の書き方など。KiCad の出力の Init DRC engine を見る)')
    mm = pcbnew.ToMM
    problems = 0
    def bad(*a):
        global problems; problems += 1
        if problems < 25: print('NG', *a)
    fps = [f for f in b.GetFootprints() if not f.GetFPIDAsString().startswith('PocketEDA:MountingHole_NPTH')]
    print('footprints', len(fps), 'ref', ref['fps'], '| holes', len(b.GetFootprints()) - len(fps), 'ref', ref['holes'])
    tr = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']; vi = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    print('tracks', len(tr), 'ref', ref['tracks'], '| vias', len(vi), 'ref', ref['vias'], '| zones', b.GetAreaCount(), 'ref', ref['zones'])
    if (len(fps), len(tr), len(vi), b.GetAreaCount()) != (ref['fps'], ref['tracks'], ref['vias'], ref['zones']): bad('counts')
    # 1) パッド
    kp = {}
    for f in fps:
        for p in f.Pads():
            c = p.GetPosition()
            kp.setdefault((f.GetReference(), p.GetNumber()), []).append((mm(c.x), mm(c.y), p.GetNetname(), 'tht' if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH else ('F.Cu' if p.IsOnLayer(pcbnew.F_Cu) else 'B.Cu')))
    maxd = 0
    for q in ref['pads']:
        best = min(kp.get((q['ref'], q['num']), []), key=lambda c: math.hypot(c[0] - q['x'], c[1] - q['y']), default=None)
        if best is None: bad('no pad', q); continue
        d = math.hypot(best[0] - q['x'], best[1] - q['y']); maxd = max(maxd, d)
        if d > 1e-4 or best[3] != q['layers']: bad('pad', q, best)
        if q['net'] and best[2] != q['knet']: bad('pad net', q, best[2])
    print('pads', len(ref['pads']), 'max position error mm', round(maxd, 7))
    # 2) ライブラリのフットプリントと基板の部品
    libdir = os.path.join(root, 'PocketEDA.pretty')
    nlib = 0
    scratch = []
    for f in fps:
        lib = f.GetFPID()
        if str(lib.GetLibNickname()) != 'PocketEDA': bad('lib nickname', f.GetReference(), str(lib.GetLibNickname())); continue
        lf = pcbnew.FootprintLoad(libdir, str(lib.GetLibItemName()))
        if lf is None: bad('library footprint missing', str(lib.GetLibItemName())); continue
        nlib += 1
        a = sorted((p.GetNumber(), round(mm(p.GetPosition().x), 4), round(mm(p.GetPosition().y), 4), round(mm(p.GetSize().x), 4), round(mm(p.GetSize().y), 4), p.GetShape()) for p in list(f.Pads()))
        scratch.append(pcbnew.BOARD()); scratch[-1].Add(lf)  # 板に載せないと Flip が落ちる（KiCad 7 の Python）。読み込んだ基板には載せない
        lf.SetPosition(f.GetPosition())
        if f.IsFlipped(): lf.Flip(lf.GetPosition(), False)
        lf.SetOrientation(f.GetOrientation())
        c = sorted((p.GetNumber(), round(mm(p.GetPosition().x), 4), round(mm(p.GetPosition().y), 4), round(mm(p.GetSize().x), 4), round(mm(p.GetSize().y), 4), p.GetShape()) for p in list(lf.Pads()))
        if a != c: bad('library pads differ', f.GetReference(), a[:2], c[:2])
    print('library footprints compared', nlib)
    # 3) 3D モデル
    nm = 0
    for f in fps:
        for m in f.Models():
            path = m.m_Filename.replace('${KIPRJMOD}', root)
            if not os.path.exists(path): bad('model missing', f.GetReference(), m.m_Filename)
            else: nm += 1
    print('3D models found', nm)
    # 4) 回路図との整合
    k = ET.parse(netxml).getroot()
    schpad = {}
    for net in k.iter('net'):
        for nd in net.iter('node'): schpad[(nd.get('ref'), nd.get('pin'))] = net.get('name')
    comps = {c.get('ref'): c for c in k.iter('comp')}
    for f in fps:
        r = f.GetReference()
        c = comps.get(r)
        if c is None: bad('footprint not in schematic', r); continue
        if c.findtext('footprint') != f.GetFPIDAsString(): bad('footprint field', r, c.findtext('footprint'), f.GetFPIDAsString())
        ts = c.find('tstamps').text if c.find('tstamps') is not None else c.findtext('tstamp')
        if f.GetPath().AsString() != '/' + ts: bad('path', r, f.GetPath().AsString(), ts)
        for p in f.Pads():
            sn = schpad.get((r, p.GetNumber()))
            if sn is not None and sn != p.GetNetname(): bad('net vs schematic', r, p.GetNumber(), p.GetNetname(), sn)
            if sn is None and p.GetNetname() and p.GetNumber(): bad('pad net not in schematic', r, p.GetNumber(), p.GetNetname())
    for r in comps:
        if r not in [f.GetReference() for f in fps]: bad('symbol without footprint', r)
    print('schematic components', len(comps))

try:
    main()
except Exception:
    e = sys.exc_info()[1]; print("EXC", type(e).__name__, str(e)[:300], traceback.extract_tb(e.__traceback__)[-1].lineno); sys.stdout.flush(); os._exit(2)
print('problems', problems); sys.stdout.flush()
os._exit(1 if problems else 0)  # pcbnew の後片付けで落ちることがあるので、すぐ終える
