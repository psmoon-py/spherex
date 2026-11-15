"""Unit tests on synthetic data with known answers (no network).
"""
import io, json, struct, sys, os
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from spx import core


def fake_hdul(ra0=150.0, dec0=20.0, rot_deg=37.0, star=(150.02, 20.01), flux=1000.0, size=400):
    """A rotated TAN image in MJy/sr with one Gaussian star, flat zodi, known variance."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]; w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [size / 2 + 0.5, size / 2 + 0.5]
    s = core.PIX_ARCSEC / 3600; t = np.radians(rot_deg)
    w.wcs.cd = np.array([[-s * np.cos(t), s * np.sin(t)], [s * np.sin(t), s * np.cos(t)]])
    yy, xx = np.mgrid[0:size, 0:size]
    xs, ys = w.all_world2pix(star[0], star[1], 0)
    sig = 1.3  # pixels; well sampled so the point-sampled test star has no pixel-phase bias
    img = flux * np.exp(-((xx - xs) ** 2 + (yy - ys) ** 2) / (2 * sig ** 2)) / (2 * np.pi * sig ** 2) + 0.3
    hd = w.to_header()
    hd["DETECTOR"] = 3; hd["MJD-AVG"] = 60900.5; hd["DATE-AVG"] = "2025-08-14T12:00:00"
    hd["XPOSURE"] = 113.58; hd["BUNIT"] = "MJy / sr"; hd["FINAST"] = 0
    # spectral lookup WCS as in the real files
    hd["WCSAXESW"] = 2; hd["CTYPE1W"] = "WAVE-TAB"; hd["CTYPE2W"] = "WAVE-TAB"
    for k, v in {"CRPIX1W": 1, "CRPIX2W": 1, "CDELT1W": 1, "CDELT2W": 1, "CRVAL1W": 1, "CRVAL2W": 1}.items(): hd[k] = v
    hd["CUNIT1W"] = "um"; hd["CUNIT2W"] = "um"
    hd["PS1_0W"] = "WCS-WAVE"; hd["PS1_1W"] = "VALUES"; hd["PS1_2W"] = "X"; hd["PV1_3W"] = 1
    hd["PS2_0W"] = "WCS-WAVE"; hd["PS2_1W"] = "VALUES"; hd["PS2_2W"] = "Y"; hd["PV2_3W"] = 2
    flags = np.zeros((size, size), np.int32); flags[int(round(float(ys))), int(round(float(xs)))] = 1 << 21
    flags[10, 10] = (1 << 19) | (1 << 6)
    X = np.linspace(1, size, 9).astype(np.int32); Y = np.linspace(1, size, 14).astype(np.int32)
    vals = np.zeros((14, 9, 2), np.float32)
    vals[:, :, 0] = 1.6 + 0.8 * (Y[:, None] - 1) / (size - 1); vals[:, :, 1] = 0.05
    tab = fits.BinTableHDU.from_columns([
        fits.Column(name="X", format="9J", dim="(9)", array=X[None]),
        fits.Column(name="Y", format="14J", dim="(14)", array=Y[None]),
        fits.Column(name="VALUES", format="252E", dim="(2,9,14)", array=vals[None])], name="WCS-WAVE")
    h = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(img.astype(np.float32), hd, name="IMAGE"),
                      fits.ImageHDU(flags, name="FLAGS"),
                      fits.ImageHDU(np.full((size, size), 0.01, np.float32), name="VARIANCE"),
                      fits.ImageHDU(np.full((size, size), 0.3, np.float32), name="ZODI"), tab])
    buf = io.BytesIO(); h.writeto(buf); buf.seek(0)
    return fits.open(buf), (float(xs), float(ys))


def test_cutout_geometry_flux_wavelength():
    h, (xs, ys) = fake_hdul()
    n = 59
    c = core.cutout_from_hdul(h, 150.0, 20.0, n)
    img = c["image"]
    assert img.shape == (n, n)
    # Star is 0.02 deg * cos(dec) EAST and 0.01 deg NORTH of centre.
    east = 0.02 * 3600 * np.cos(np.radians(20.0)); north = 0.01 * 3600
    cen = (n - 1) / 2
    col_exp = cen - east / core.PIX_ARCSEC; row_exp = cen - north / core.PIX_ARCSEC
    tot = np.nansum(img); yy, xx = np.mgrid[0:n, 0:n]
    col = np.nansum(img * xx) / tot; row = np.nansum(img * yy) / tot
    assert abs(col - col_exp) < 0.1 and abs(row - row_exp) < 0.1, (col, col_exp, row, row_exp)
    # Zodi removed and flux conserved by resampling (same pixel scale).
    assert abs(tot - 1000.0) / 1000.0 < 0.01, tot
    assert abs(np.nanmedian(img)) < 1e-3
    # Variance interpolated linearly: sigma stays 0.1.
    assert np.allclose(c["sigma"][5:-5, 5:-5], 0.1, atol=1e-4)
    # Flags: SOURCE class at the star, nothing in a blank corner.
    r, k = int(round(row_exp)), int(round(col_exp))
    assert c["mask"][r, k] & core.CLASS_BITS["source"]
    # Wavelength table: linear in native y; check against the direct formula.
    m = c["meta"]
    lam_expected = 1.6 + 0.8 * (m["y"]) / (400 - 1)
    assert abs(m["lam"] - lam_expected) < 2e-3, (m["lam"], lam_expected)
    d = n // 4
    def lam_native(col_, row_):
        ow = core.stamp_wcs(150.0, 20.0, n); ra, de = ow.all_pix2world(col_, n - 1 - row_, 0)
        x, y = WCS(h["IMAGE"].header).all_world2pix(ra, de, 0); return 1.6 + 0.8 * float(y) / 399
    assert abs(m["lam"] + m["dlam_east"] * d - lam_native(cen - d, cen)) < 2e-3
    assert abs(m["lam"] + m["dlam_north"] * d - lam_native(cen, cen - d)) < 2e-3


def test_blob_roundtrip_and_flags():
    h, _ = fake_hdul()
    c = core.cutout_from_hdul(h, 150.0, 20.0, 31)
    b = core.pack_blob(c)
    (hl,) = struct.unpack("<I", b[:4]); meta = json.loads(b[4:4 + hl]); n = meta["n"]
    off = 4 + hl
    img = np.frombuffer(b, "<f4", n * n, off).reshape(n, n); off += 4 * n * n
    sig = np.frombuffer(b, "<f2", n * n, off).reshape(n, n); off += 2 * n * n
    msk = np.frombuffer(b, "u1", n * n, off).reshape(n, n)
    assert off + n * n == len(b)
    assert np.allclose(img, c["image"], equal_nan=True) and np.allclose(sig, c["sigma"], atol=1e-3)
    f = np.array([1 << 19 | 1 << 6, 1 << 1, 1 << 17, 1 << 25, 1 << 21, 1 << 7, 1 << 30, 0])
    r = core.reduce_flags(f); B = core.CLASS_BITS
    assert list(r) == [B["transient"] | B["bad"], B["saturated"], B["persistence"], B["artifact"],
                       B["source"], B["dichroic"], B["other"], 0]


def test_passes_and_propagate():
    fr = [{"mjd": m} for m in (60800, 60801, 60830, 60990, 60991, 61200)]
    core.assign_passes(fr)
    assert [f["pass"] for f in fr] == [0, 0, 1, 2, 2, 3]
    # Barnard's Star, Gaia-like numbers: 10.36 arcsec/yr north for 10 years = 103.6 arcsec.
    ra, dec = core.propagate(269.45, 4.74, -802.0, 10362.0, 2016.0, 2026.0)
    assert abs((dec - 4.74) * 3600 - 103.62) < 1e-6
    assert abs((ra - 269.45) * 3600 * np.cos(np.radians(4.74)) + 8.02) < 1e-6
