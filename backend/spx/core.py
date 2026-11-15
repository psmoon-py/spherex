"""Core SPHEREx access: find Level-2 images for a sky position, cut out a north-up stamp,
read wavelength and flags, and fetch Gaia DR3 stars.

All FITS and WCS work is delegated to Astropy. The code was checked
against real archive files in CI.

Conventions
-----------
* Stamp arrays are (n, n) with row 0 = NORTH edge and column 0 = EAST edge (the way the
  sky is normally displayed). Pixel scale is PIX_ARCSEC. The target sits at index
  c = (n - 1) / 2 in both axes. East offset of column j is (c - j) * PIX_ARCSEC arcsec,
  north offset of row i is (c - i) * PIX_ARCSEC arcsec (gnomonic tangent plane).
* Surface brightness is MJy/sr with the archive's zodiacal-light model subtracted.
* Times are MJD (UTC) at mid-exposure.
"""
from __future__ import annotations
import csv, io, json, math, re, struct, urllib.parse, urllib.request
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

PIX_ARCSEC = 6.15
IRSA = "https://irsa.ipac.caltech.edu/"
S3_HTTP = "https://nasa-irsa-spherex.s3.amazonaws.com/"
URI_RE = re.compile(r"^ibe/data/spherex/((?:dr|qr)\d+)/level2/[A-Za-z0-9_./-]+\.fits$")
UA = {"User-Agent": "six-months-apart/1.0 (NASA Space Apps 2026 project)"}

# Flag bits from the SPHEREx Explanatory Supplement (Level-2 FLAGS extension).
FLAG_BITS = {0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC",
             9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
             15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE",
             22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM",
             27: "SNOWBALL", 28: "HALO", 29: "SATELLITE_HALO"}
# Reduced classes sent to the viewer, one bit each.
CLASS_BITS = {"bad": 1, "saturated": 2, "transient": 4, "persistence": 8,
              "artifact": 16, "source": 32, "dichroic": 64, "other": 128}
_CLASS_OF = {0: "transient", 19: "transient", 1: "saturated", 15: "saturated",
             2: "bad", 6: "bad", 9: "bad", 10: "bad", 11: "bad", 17: "persistence",
             20: "artifact", 22: "artifact", 23: "artifact", 24: "artifact", 25: "artifact",
             26: "artifact", 27: "artifact", 28: "artifact", 29: "artifact",
             21: "source", 7: "dichroic", 12: "other", 14: "other"}


def reduce_flags(flags: np.ndarray) -> np.ndarray:
    """Map the 32-bit SPHEREx flag word to the 8 viewer classes (uint8 bit mask)."""
    bits = flags.astype(np.int64)
    out = np.zeros(bits.shape, np.uint8)
    for bit, cls in _CLASS_OF.items():
        out |= (((bits >> bit) & 1).astype(np.uint8) * CLASS_BITS[cls]).astype(np.uint8)
    known = sum(1 << b for b in _CLASS_OF)
    out |= (((bits & ~known) != 0).astype(np.uint8) * CLASS_BITS["other"]).astype(np.uint8)
    return out


def _get(url: str, timeout: float = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def tap_csv(adql: str) -> list[dict]:
    """Run a synchronous ADQL query on IRSA TAP and return rows as dicts."""
    url = IRSA + "TAP/sync?" + urllib.parse.urlencode(
        {"QUERY": adql, "FORMAT": "CSV", "LANG": "ADQL", "REQUEST": "doQuery"})
    text = _get(url).decode("utf-8", "replace")
    if text.lstrip().startswith("<"):
        raise RuntimeError("IRSA TAP returned an error document: " + text[:300])
    return list(csv.DictReader(io.StringIO(text)))


def find_frames(ra: float, dec: float) -> list[dict]:
    """All public Level-2 spectral images whose footprint contains (ra, dec), oldest first.

    Queries every release IRSA serves through one table, so new releases appear without
    code changes."""
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise ValueError("ra must be in [0, 360) and dec in [-90, 90]")
    query = ("SELECT a.uri, p.time_bounds_lower, p.time_bounds_upper, p.energy_bandpassname "
         "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
         f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.7f}, {dec:.7f}), p.poly) "
         "ORDER BY p.time_bounds_lower")
    out = []
    for r in tap_csv(query):
        uri = r["uri"].strip()
        match = URI_RE.match(uri)
        band = r["energy_bandpassname"].strip()
        if not match or not band.startswith("SPHEREx-D"):
            continue
        t0, t1 = float(r["time_bounds_lower"]), float(r["time_bounds_upper"])
        out.append({"uri": uri, "mjd": round(0.5 * (t0 + t1), 6), "det": int(band[-1]),
                    "release": match.group(1)})
    return out


def assign_passes(frames: list[dict], gap_days: float = 20.0) -> None:
    """Label each frame with a pass number: a new pass starts after a gap > gap_days."""
    p, last = -1, None
    for f in sorted(frames, key=lambda f: f["mjd"]):
        if last is None or f["mjd"] - last > gap_days:
            p += 1
        f["pass"] = p
        last = f["mjd"]


def _bilinear(a: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample of a at float index coords (x=col, y=row); NaN outside."""
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    fx = x - x0; fy = y - y0
    ok = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < a.shape[1]) & (y0 + 1 < a.shape[0])
    x0 = np.clip(x0, 0, a.shape[1] - 2); y0 = np.clip(y0, 0, a.shape[0] - 2)
    v = (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy)
         + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)
    v = v.astype(np.float32); v[~ok] = np.nan
    return v


def _or4(a: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bitwise OR of the four input pixels that feed each output pixel (conservative)."""
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    ok = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < a.shape[1]) & (y0 + 1 < a.shape[0])
    x0 = np.clip(x0, 0, a.shape[1] - 2); y0 = np.clip(y0, 0, a.shape[0] - 2)
    v = a[y0, x0] | a[y0, x0 + 1] | a[y0 + 1, x0] | a[y0 + 1, x0 + 1]
    v = v.copy(); v[~ok] = 0
    return v, ok


def stamp_wcs(ra: float, dec: float, n: int) -> WCS:
    """Gnomonic WCS of the output stamp before the vertical flip (FITS order, y up = north)."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n - 1) / 2 + 1, (n - 1) / 2 + 1]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600.0, PIX_ARCSEC / 3600.0]
    return w


def cutout_from_hdul(h, ra: float, dec: float, n: int) -> dict:
    """Build the north-up stamp and metadata from an open SPHEREx Level-2 HDU list."""
    header = h["IMAGE"].header
    file_wcs = WCS(header)
    ny, nx = int(header["NAXIS2"]), int(header["NAXIS1"])
    stamp_grid = stamp_wcs(ra, dec, n)
    jj, ii = np.mgrid[0:n, 0:n]
    sky_ra, sky_dec = stamp_grid.all_pix2world(ii, jj, 0)
    xin, yin = file_wcs.all_world2pix(sky_ra, sky_dec, 0, quiet=True)
    x_t, y_t = (float(v) for v in file_wcs.all_world2pix(ra, dec, 0, quiet=True))
    # Native block needed (with a 2-pixel guard), clipped to the detector.
    x1 = max(int(np.floor(np.nanmin(xin))) - 2, 0); x2 = min(int(np.ceil(np.nanmax(xin))) + 3, nx)
    y1 = max(int(np.floor(np.nanmin(yin))) - 2, 0); y2 = min(int(np.ceil(np.nanmax(yin))) + 3, ny)
    if x2 - x1 < 2 or y2 - y1 < 2:
        raise ValueError("position is not on this detector image")
    block = (slice(y1, y2), slice(x1, x2))
    img = np.asarray(h["IMAGE"].section[block], np.float32)
    zodi = np.asarray(h["ZODI"].section[block], np.float32)
    var = np.asarray(h["VARIANCE"].section[block], np.float32)
    flag_block = np.asarray(h["FLAGS"].section[block]).astype(np.int64)
    xr, yr = xin - x1, yin - y1
    image = _bilinear(img - zodi, xr, yr)[::-1]
    # Linear interpolation of variance: right for aperture sums on the resampled grid
    # (see README, "Noise after resampling"); conservative for single pixels.
    sigma = np.sqrt(np.clip(_bilinear(var, xr, yr), 0, None))[::-1]
    f4, ok = _or4(flag_block, xr, yr)
    mask = reduce_flags(f4)
    mask[~ok] |= CLASS_BITS["bad"]
    mask = mask[::-1]
    # Wavelength and bandwidth from the file's own lookup table, at the target and at two
    # offsets so the viewer can evaluate wavelength anywhere on the stamp (linear model).
    wave_wcs = WCS(header=header, fobj=h, key="W"); wave_wcs.sip = None
    def lam_at(px, py):
        l, b = wave_wcs.pixel_to_world(px, py)
        return float(l.to_value("um")), float(b.to_value("um"))
    centre = (n - 1) / 2.0
    def native_of(col, row):  # stamp (col,row) with row 0 = north -> native pixel
        return float(xin[int(round(n - 1 - row)), int(round(col))]), float(yin[int(round(n - 1 - row)), int(round(col))])
    lam0, bw0 = lam_at(x_t, y_t)
    step = max(int(n // 4), 1)
    lam_e, _ = lam_at(*native_of(centre - step, centre))   # step pixels east
    lam_n, _ = lam_at(*native_of(centre, centre - step))   # step pixels north
    core = flag_block[max(int(round(y_t)) - y1 - 1, 0):int(round(y_t)) - y1 + 2,
               max(int(round(x_t)) - x1 - 1, 0):int(round(x_t)) - x1 + 2]
    core_or = int(np.bitwise_or.reduce(core.ravel())) if core.size else 0
    meta = {
        "n": n, "pix_arcsec": PIX_ARCSEC, "ra": ra, "dec": dec,
        "mjd": float(header.get("MJD-AVG", header.get("MJD-OBS"))), "date": str(header.get("DATE-AVG", header.get("DATE-OBS"))),
        "det": int(header["DETECTOR"]), "obsid": str(header.get("OBSID", "")),
        "exptime": float(header.get("XPOSURE", float("nan"))),
        "lam": lam0, "bw": bw0,
        "dlam_east": (lam_e - lam0) / step, "dlam_north": (lam_n - lam0) / step,
        "x": x_t, "y": y_t, "finast": int(header.get("FINAST", -1)),
        "psf_fwhm": float(header.get("PSF_FWHM", float("nan"))),
        "sc_km": [float(header.get(k, float("nan"))) for k in ("X_SC", "Y_SC", "Z_SC")],
        "core_flags": [FLAG_BITS.get(b, f"BIT{b}") for b in range(32) if core_or >> b & 1],
        "bunit": str(header.get("BUNIT", "")),
    }
    return {"meta": meta, "image": image, "sigma": sigma.astype(np.float32), "mask": mask}


def read_cutout(uri: str, ra: float, dec: float, n: int = 59) -> dict:
    """Open one Level-2 file on the public AWS mirror by byte range and cut out a stamp."""
    match = URI_RE.match(uri)
    if not match:
        raise ValueError("not a SPHEREx Level-2 archive path")
    if not (9 <= n <= 301) or n % 2 == 0:
        raise ValueError("n must be odd and between 9 and 301")
    url = S3_HTTP + uri[len("ibe/data/spherex/"):]
    with fits.open(url, use_fsspec=True, fsspec_kwargs={"block_size": 1 << 20}) as h:
        out = cutout_from_hdul(h, ra, dec, n)
    out["meta"]["uri"] = uri
    out["meta"]["release"] = match.group(1)
    return out


def pack_blob(c: dict) -> bytes:
    """Serialize a cutout: uint32 header length, JSON header, float32 image,
    float16 sigma, uint8 mask (all little-endian, row-major)."""
    meta = json.dumps(c["meta"], allow_nan=False, default=lambda o: None).encode() \
        if all(_finite(v) for v in _walk(c["meta"])) else json.dumps(_clean(c["meta"])).encode()
    pad = (-len(meta)) % 4
    meta += b" " * pad
    return (struct.pack("<I", len(meta)) + meta + c["image"].astype("<f4").tobytes()
            + c["sigma"].astype("<f2").tobytes() + c["mask"].astype("u1").tobytes())


def _walk(o):
    if isinstance(o, dict):
        for v in o.values(): yield from _walk(v)
    elif isinstance(o, (list, tuple)):
        for v in o: yield from _walk(v)
    else:
        yield o


def _finite(v):
    return not (isinstance(v, float) and not math.isfinite(v))


def _clean(o):
    if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [_clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o): return None
    return o


def gaia_cone(ra: float, dec: float, radius_deg: float, limit: int = 400) -> list[dict]:
    """Gaia DR3 sources (IRSA mirror), brightest first. Positions are at epoch 2016.0."""
    radius_deg = min(max(radius_deg, 0.001), 0.5)
    q = (f"SELECT TOP {int(limit)} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag "
         "FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS', ra, dec), "
         f"CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {radius_deg:.5f})) = 1 ORDER BY phot_g_mean_mag")
    out = []
    for r in tap_csv(q):
        def f(k):
            try: return float(r[k])
            except (ValueError, TypeError): return None
        out.append({"id": r["source_id"], "ra": f("ra"), "dec": f("dec"), "pmra": f("pmra"),
                    "pmdec": f("pmdec"), "plx": f("parallax"), "g": f("phot_g_mean_mag")})
    return out


def propagate(ra, dec, pmra_mas, pmdec_mas, epoch0, epoch1):
    """Move a position by proper motion (mas/yr; pmra includes cos dec) from epoch0 to
    epoch1 (Julian years). First-order; parallax ignored (< 0.1 SPHEREx pixel for all stars)."""
    dt = epoch1 - epoch0
    return (ra + (pmra_mas or 0.0) * dt / 3.6e6 / math.cos(math.radians(dec)),
            dec + (pmdec_mas or 0.0) * dt / 3.6e6)
