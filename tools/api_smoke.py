"""End-to-end check of the live API against the real archive. Run with the server on localhost:8000.
"""
import json, sys, time, urllib.parse, urllib.request

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"

def get(path, raw=False):
    t = time.time()
    with urllib.request.urlopen(B + path, timeout=300) as r:
        body = r.read()
    print(f"  {path[:90]}  {len(body)} bytes  {time.time() - t:.1f}s")
    return body if raw else json.loads(body)

assert get("/api/health")["ok"]
r = get("/api/resolve?q=" + urllib.parse.quote("M 57"))
assert abs(r["ra"] - 283.396) < 0.05 and abs(r["dec"] - 33.029) < 0.05, r
r = get("/api/resolve?q=" + urllib.parse.quote("08h55m10.831s -7d14m42.53s"))
assert abs(r["ra"] - 133.79513) < 1e-4 and abs(r["dec"] + 7.24515) < 1e-4, r
# A position with no preset: the Ring Nebula, then a blank high-latitude spot.
for ra, dec in [(283.3962, 33.0292), (150.1163, 2.2058)]:
    fr = get(f"/api/frames?ra={ra}&dec={dec}")["frames"]
    assert len(fr) > 20, len(fr)
    dets = sorted({f["det"] for f in fr}); passes = sorted({f["pass"] for f in fr})
    print(f"  {len(fr)} frames, detectors {dets}, passes {passes}, releases {sorted({f['release'] for f in fr})}")
    assert dets == [1, 2, 3, 4, 5, 6]
    t = time.time(); ok = 0
    for f in [x for x in fr if x["det"] == 2][:6]:
        blob = get(f"/api/cutout?uri={urllib.parse.quote(f['uri'])}&ra={ra}&dec={dec}&n=59", raw=True)
        ok += len(blob) > 59 * 59 * 4
    assert ok >= 5, ok
    print(f"  6 cutouts in {time.time() - t:.1f}s")
    g = get(f"/api/gaia?ra={ra}&dec={dec}&radius=0.08")["stars"]
    assert len(g) >= 1, "no Gaia stars"
    print(f"  {len(g)} Gaia stars")
print("API SMOKE TEST PASSED")
