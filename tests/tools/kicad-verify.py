# KiCad 7 で .kicad_pcb を読み込み、Pocket EDA の値と突き合わせ、ゾーンを塗り直して DRC を実行する
import sys, json, math, pcbnew
pcbpath, refpath, report = sys.argv[1], sys.argv[2], sys.argv[3]
ref = json.load(open(refpath))
b = pcbnew.LoadBoard(pcbpath)
mm = pcbnew.ToMM
fps = [f for f in b.GetFootprints() if not f.GetFPIDAsString().endswith('MountingHole_NPTH')]
print('footprints', len(fps), 'ref', ref['fps'], '| holes', len(b.GetFootprints()) - len(fps), 'ref', ref['holes'])
tr = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']; vi = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
print('tracks', len(tr), 'ref', ref['tracks'], '| vias', len(vi), 'ref', ref['vias'], '| zones', b.GetAreaCount(), 'ref', ref['zones'])
# パッドの照合（部品番号・番号ごとに、位置が一致するものを探す）
kp = {}
for f in fps:
    for p in f.Pads():
        c = p.GetPosition()
        bb = p.GetBoundingBox()
        kp.setdefault((f.GetReference(), p.GetNumber()), []).append((mm(c.x), mm(c.y), p.GetNetname(), 'tht' if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH else ('F.Cu' if p.IsOnLayer(pcbnew.F_Cu) else 'B.Cu'), mm(bb.GetWidth()), mm(bb.GetHeight())))
bad = 0; maxd = 0
for q in ref['pads']:
    cands = kp.get((q['ref'], q['num']), [])
    best = min(cands, key=lambda c: math.hypot(c[0] - q['x'], c[1] - q['y']), default=None)
    if best is None: bad += 1; print('NO PAD', q); continue
    d = math.hypot(best[0] - q['x'], best[1] - q['y']); maxd = max(maxd, d)
    if d > 1e-4 or best[2] != q['net'] or best[3] != q['layers']:
        bad += 1
        if bad < 10: print('MISMATCH', q, best, round(d, 6))
print('pads', len(ref['pads']), 'mismatch', bad, 'max position error mm', round(maxd, 7))
# 接続（未配線）: 塗りなし／塗りあり
filler = pcbnew.ZONE_FILLER(b)
filler.Fill(b.Zones())
b.BuildConnectivity()
print('unrouted after fill', b.GetConnectivity().GetUnconnectedCount(True) if hasattr(b.GetConnectivity(), 'GetUnconnectedCount') else '?')
ok = pcbnew.WriteDRCReport(b, report, pcbnew.EDA_UNITS_MILLIMETRES, True)
print('drc report', ok)
