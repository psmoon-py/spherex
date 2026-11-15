"""Build static data packs for the preset targets from the real SPHEREx archive, and
write contact sheets plus a validation report. Runs in GitHub Actions.
"""
import json, os, sys, time, traceback
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from spx import core

OUT = sys.argv[1] if len(sys.argv) > 1 else "site-data"
ONLY = sys.argv[2].split(",") if len(sys.argv) > 2 else None
CAP = int(os.environ.get("CAP", "48"))
N = int(os.environ.get("NPIX", "59"))
report = []
def log(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); report.append(s)

def choose(frames, cap):
    """Up to `cap` frames of one detector, taking passes round-robin, evenly in time."""
    by = {}
    for f in frames: by.setdefault(f["pass"], []).append(f)
    per = max(cap // max(len(by), 1), 1)
    out = []
    for p, fs in by.items():
        if len(fs) > per:
            idx = np.unique(np.round(np.linspace(0, len(fs) - 1, per)).astype(int))
            fs = [fs[i] for i in idx]
        out += fs
    return sorted(out, key=lambda f: f["mjd"])

def aperture(img, sig, col, row, r=2.0, r_in=4.0, r_out=7.0):
    n = img.shape[0]; yy, xx = np.mgrid[0:n, 0:n]; d = np.hypot(xx - col, yy - row)
    ap = d <= r; an = (d >= r_in) & (d <= r_out)
    sky = np.nanmedian(img[an]); omega = (core.PIX_ARCSEC / 206264.806) ** 2
    f = np.nansum(img[ap] - sky) * omega * 1e12
    e = np.sqrt(np.nansum(sig[ap].astype(float) ** 2)) * omega * 1e12
    return f, e

def build(t):
    t0 = time.time()
    frames = core.find_frames(t["ra"], t["dec"])
    core.assign_passes(frames)
    log(f"\n## {t['name']}: {len(frames)} frames, passes {sorted(set(f['pass'] for f in frames))}, releases {sorted(set(f['release'] for f in frames))}, TAP {time.time()-t0:.1f}s")
    d = os.path.join(OUT, "packs", t["slug"]); os.makedirs(d, exist_ok=True)
    man = {"target": t, "n": N, "pix_arcsec": core.PIX_ARCSEC, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "total_frames_in_archive": len(frames), "detectors": {}}
    sheets = {}
    for det in range(1, 7):
        sel = choose([f for f in frames if f["det"] == det], CAP)
        def one(f):
            for attempt in range(3):
                try:
                    c = core.read_cutout(f["uri"], t["ra"], t["dec"], N); c["meta"]["pass"] = f["pass"]; return c
                except Exception as e:
                    err = repr(e); time.sleep(1 + attempt)
            log("   FAILED", f["uri"], err); return None
        t1 = time.time()
        with ThreadPoolExecutor(8) as ex: cs = [c for c in ex.map(one, sel) if c is not None]
        blob = b""; idx = []
        for c in cs:
            b = core.pack_blob(c); idx.append({"offset": len(blob), "length": len(b), "mjd": c["meta"]["mjd"], "lam": c["meta"]["lam"], "pass": c["meta"]["pass"]}); blob += b
        with open(os.path.join(d, f"D{det}.bin"), "wb") as fh: fh.write(blob)
        man["detectors"][str(det)] = {"frames": idx, "in_archive": sum(1 for f in frames if f["det"] == det)}
        log(f"   D{det}: {len(cs)}/{len(sel)} cutouts, {len(blob)/1e6:.1f} MB, {time.time()-t1:.1f}s; lambda {min([c['meta']['lam'] for c in cs], default=0):.3f}-{max([c['meta']['lam'] for c in cs], default=0):.3f} um; FINAST!=0: {sum(1 for c in cs if c['meta']['finast'] != 0)}")
        sheets[det] = cs
        cen = (N - 1) / 2
        for c in cs[:: max(len(cs) // 6, 1)][:6]:
            f, e = aperture(c["image"], c["sigma"], cen, cen)
            m = c["meta"]
            log(f"      {m['date'][:16]} pass {m['pass']} lam {m['lam']:.3f} bw {m['bw']:.3f} centre-aperture {f:9.1f} +- {e:6.1f} uJy; core flags {m['core_flags']}; nan frac {np.isnan(c['image']).mean():.2f}; sky rms {np.nanstd(c['image']):.4f} MJy/sr; median sigma {np.nanmedian(c['sigma']):.4f}")
    try:
        man["gaia"] = core.gaia_cone(t["ra"], t["dec"], N * core.PIX_ARCSEC / 3600 * 0.75)
        log(f"   Gaia stars: {len(man['gaia'])}")
    except Exception as e:
        man["gaia"] = []; log("   Gaia FAILED", repr(e))
    with open(os.path.join(d, "manifest.json"), "w") as fh: json.dump(man, fh)
    sheet(t, sheets)
    log(f"   done in {time.time()-t0:.0f}s")

def sheet(t, sheets):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    passes = sorted({c["meta"]["pass"] for cs in sheets.values() for c in cs})
    fig, ax = plt.subplots(6, max(len(passes), 1), figsize=(2.6 * max(len(passes), 1), 15), squeeze=False)
    for i, det in enumerate(range(1, 7)):
        for j, p in enumerate(passes):
            a = ax[i][j]; a.set_xticks([]); a.set_yticks([])
            cs = [c for c in sheets[det] if c["meta"]["pass"] == p]
            if not cs: a.set_facecolor("0.85"); continue
            st = np.nanmedian(np.stack([c["image"] for c in cs]), axis=0)
            lo, hi = np.nanpercentile(st, [20, 99.7])
            a.imshow(st, origin="upper", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
            n = st.shape[0]; c0 = (n - 1) / 2
            a.plot([c0], [c0], marker="+", color="cyan", ms=14, mew=0.8)
            tr = t.get("track")
            if tr:
                yr = 2000.0 + (np.median([c["meta"]["mjd"] for c in cs]) - 51544.5) / 365.25
                ra, dec = core.propagate(tr["ra"], tr["dec"], tr["pm"][0], tr["pm"][1], tr["epoch"], yr)
                e = (ra - t["ra"]) * np.cos(np.radians(t["dec"])) * 3600 / core.PIX_ARCSEC; nn = (dec - t["dec"]) * 3600 / core.PIX_ARCSEC
                a.add_patch(plt.Circle((c0 - e, c0 - nn), 2.5, fill=False, color="yellow", lw=0.8))
            a.set_title(f"D{det} pass {p} n={len(cs)} {cs[0]['meta']['date'][:10]}", fontsize=7)
    fig.suptitle(f"{t['name']} (N up, E left; cyan + = entered position; yellow ring = predicted position)", fontsize=9)
    fig.tight_layout(); os.makedirs(os.path.join(OUT, "sheets"), exist_ok=True)
    fig.savefig(os.path.join(OUT, "sheets", t["slug"] + ".png"), dpi=70); plt.close(fig)

def build_moving(b):
    """Fixed-sky fields for a solar-system body, one per pass, with JPL truth per frame."""
    from astroquery.jplhorizons import Horizons
    from astropy.time import Time
    def eph(jds):
        e = Horizons(id=b["horizons_id"], id_type="smallbody", location="500@-163182", epochs=list(jds)).ephemerides()
        return [{"ra": float(r["RA"]), "dec": float(r["DEC"]), "delta": float(r["delta"]), "r": float(r["r"]), "elong": float(r["elong"])} for r in e]
    d = os.path.join(OUT, "packs", b["slug"]); os.makedirs(d, exist_ok=True)
    man = {"body": b, "n": N, "pix_arcsec": core.PIX_ARCSEC, "fields": []}
    log(f"\n## {b['name']} (moving target)")
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(len(b["dates"]), 8, figsize=(16, 2.2 * len(b["dates"])), squeeze=False)
    for k, date in enumerate(b["dates"]):
        t0 = Time(date, scale="utc"); c = eph([t0.jd])[0]
        frames = [f for f in core.find_frames(c["ra"], c["dec"]) if abs(f["mjd"] - t0.mjd) <= b["window_days"] and f["det"] in b["detectors"]]
        log(f"   field {k} {date}: centre {c['ra']:.5f} {c['dec']:.5f}, delta {c['delta']:.4f} au, elongation {c['elong']:.1f} deg, {len(frames)} frames in window")
        def one(f):
            for attempt in range(3):
                try: return core.read_cutout(f["uri"], c["ra"], c["dec"], N)
                except Exception as e: err = repr(e); time.sleep(1 + attempt)
            log("   FAILED", f["uri"], err); return None
        with ThreadPoolExecutor(8) as ex: cs = sorted([x for x in ex.map(one, frames) if x is not None], key=lambda x: x["meta"]["mjd"])
        truth = eph([x["meta"]["mjd"] + 2400000.5 for x in cs]) if cs else []
        blob = b""; idx = []; cen = (N - 1) / 2
        for x, tr in zip(cs, truth):
            x["meta"]["pass"] = k
            e = (tr["ra"] - c["ra"]) * np.cos(np.radians(c["dec"])) * 3600 / core.PIX_ARCSEC; nn = (tr["dec"] - c["dec"]) * 3600 / core.PIX_ARCSEC
            col, row = cen - e, cen - nn
            f_, e_ = aperture(x["image"], x["sigma"], col, row)
            bb = core.pack_blob(x); idx.append({"offset": len(blob), "length": len(bb), "mjd": x["meta"]["mjd"], "lam": x["meta"]["lam"], "det": x["meta"]["det"], "truth": tr}); blob += bb
            log(f"      {x['meta']['date'][:16]} D{x['meta']['det']} lam {x['meta']['lam']:.3f}: truth at col {col:5.1f} row {row:5.1f}; flux there {f_:7.1f} +- {e_:5.1f} uJy (S/N {f_/e_:5.1f}); flags {x['meta']['core_flags']}")
        with open(os.path.join(d, f"field{k}.bin"), "wb") as fh: fh.write(blob)
        man["fields"].append({"ra": c["ra"], "dec": c["dec"], "date": date, "frames": idx})
        for j, (x, tr) in enumerate(list(zip(cs, truth))[:: max(len(cs) // 8, 1)][:8]):
            a = ax[k][j]; a.set_xticks([]); a.set_yticks([]); im = x["image"]; lo, hi = np.nanpercentile(im, [20, 99.7])
            a.imshow(im, origin="upper", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
            e = (tr["ra"] - c["ra"]) * np.cos(np.radians(c["dec"])) * 3600 / core.PIX_ARCSEC; nn = (tr["dec"] - c["dec"]) * 3600 / core.PIX_ARCSEC
            a.add_patch(plt.Circle((cen - e, cen - nn), 3, fill=False, color="yellow", lw=0.8)); a.set_title(f"{x['meta']['date'][5:16]} D{x['meta']['det']} {x['meta']['lam']:.2f}um", fontsize=7)
    fig.suptitle(f"{b['name']}: single frames, fixed sky; yellow ring = JPL Horizons position at that time", fontsize=9); fig.tight_layout()
    os.makedirs(os.path.join(OUT, "sheets"), exist_ok=True); fig.savefig(os.path.join(OUT, "sheets", b["slug"] + ".png"), dpi=70); plt.close(fig)
    with open(os.path.join(d, "manifest.json"), "w") as fh: json.dump(man, fh)

if __name__ == "__main__":
    P = json.load(open(os.path.join(os.path.dirname(__file__), "..", "presets.json")))
    for t in P["targets"]:
        if ONLY and t["slug"] not in ONLY: continue
        try: build(t)
        except Exception as e:
            log("TARGET FAILED", t["slug"], repr(e)); traceback.print_exc()
    for b in P.get("moving", []):
        if ONLY and b["slug"] not in ONLY: continue
        try: build_moving(b)
        except Exception as e:
            log("MOVING TARGET FAILED", b["slug"], repr(e)); traceback.print_exc()
    with open(os.path.join(OUT, "report.txt"), "w") as fh: fh.write("\n".join(report))
