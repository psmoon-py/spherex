"""Six Months Apart: API server. Thin HTTP layer over spx.core.
Run locally:  uvicorn app:app --reload --port 8000   (from the backend/ folder)
"""
from __future__ import annotations
import json, os, re, threading, time
from collections import OrderedDict
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from spx import core

app = FastAPI(title="Six Months Apart API", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=2048)

_PRESETS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "presets.json")))["targets"] \
    if os.path.exists(os.path.join(os.path.dirname(__file__), "..", "presets.json")) else []


class LRU:
    def __init__(self, n): self.n, self.d, self.lock = n, OrderedDict(), threading.Lock()
    def get(self, k):
        with self.lock:
            if k in self.d: self.d.move_to_end(k); return self.d[k]
    def put(self, k, v):
        with self.lock:
            self.d[k] = v; self.d.move_to_end(k)
            while len(self.d) > self.n: self.d.popitem(last=False)

_frames, _cut, _gaia = LRU(64), LRU(600), LRU(64)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/resolve")
def resolve(q: str = Query(..., min_length=1, max_length=80)):
    """Turn a name or a coordinate string into ICRS degrees."""
    s = q.strip()
    for t in _PRESETS:
        if s.lower() in (t["slug"], t["name"].lower()):
            return {"ra": t["ra"], "dec": t["dec"], "name": t["name"], "via": "preset"}
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    m = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)\s*", s)
    try:
        if m:
            c = SkyCoord(float(m.group(1)), float(m.group(2)), unit="deg")
            return {"ra": c.ra.deg, "dec": c.dec.deg, "name": None, "via": "degrees"}
        if re.search(r"\d", s) and re.search(r"[hms:d°'\"]|\d\s+\d", s):
            c = SkyCoord(s, unit=(u.hourangle, u.deg))
            return {"ra": c.ra.deg, "dec": c.dec.deg, "name": None, "via": "sexagesimal"}
    except Exception:
        pass
    try:
        c = SkyCoord.from_name(s)
        return {"ra": c.ra.deg, "dec": c.dec.deg, "name": s, "via": "CDS Sesame (catalogue position, usually epoch 2000)"}
    except Exception:
        raise HTTPException(404, "Could not read that as coordinates or find that name.")


def _retry(fn, what: str, tries: int = 3):
    """The archive's query service fails now and then; try a few times before giving up."""
    last = None
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # network or service error
            last = e
            print(f"{what} (attempt {k + 1} of {tries}): {type(e).__name__}: {str(e)[:300]}", flush=True)
            time.sleep(2 + 4 * k)
    raise HTTPException(502, f"{what} after {tries} attempts: {str(last)[:200]}")


@app.get("/api/frames")
def frames(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
    key = (round(ra, 5), round(dec, 5))
    out = _frames.get(key)
    if out is None:
        found = _retry(lambda: core.find_frames(ra, dec), "The IRSA archive query failed")
        core.assign_passes(found)
        out = {"ra": ra, "dec": dec, "frames": found}
        _frames.put(key, out)
    return out


@app.get("/api/cutout")
def cutout(uri: str, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
           n: int = Query(59, ge=9, le=301)):
    if not core.URI_RE.match(uri) or n % 2 == 0:
        raise HTTPException(400, "bad uri or even n")
    key = (uri, round(ra, 6), round(dec, 6), n)
    blob = _cut.get(key)
    if blob is None:
        try:
            blob = core.pack_blob(core.read_cutout(uri, ra, dec, n))
        except ValueError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            raise HTTPException(502, f"Could not read that image from the archive mirror: {e}")
        _cut.put(key, blob)
    return Response(blob, media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/gaia")
def gaia(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
         radius: float = Query(0.08, gt=0, le=0.5)):
    key = (round(ra, 4), round(dec, 4), round(radius, 3))
    out = _gaia.get(key)
    if out is None:
        out = {"epoch": 2016.0, "stars": _retry(lambda: core.gaia_cone(ra, dec, radius), "The Gaia query failed")}
        _gaia.put(key, out)
    return out
