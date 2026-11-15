// Sky geometry, statistics and photometry used by the viewer.
// Unit-tested in sky.test.ts.
//
// Stamp convention (matches backend/spx/core.py): row 0 = north edge, column 0 = east edge,
// the target sits at c = (n - 1) / 2, pixel scale PIX arcsec, gnomonic (TAN) projection.

export const PIX = 6.15; // arcsec per pixel
const D2R = Math.PI / 180;
const AS2R = D2R / 3600;
/** Solid angle of one stamp pixel in steradians. */
export const OMEGA_PIX = (PIX * AS2R) ** 2;
/** Resolving power of each detector band (SPHEREx archive documentation). */
export const R_BAND: Record<number, number> = { 1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128 };

export type Meta = {
  n: number; ra: number; dec: number; mjd: number; date: string; det: number; lam: number; bw: number;
  dlam_east: number; dlam_north: number; finast: number; psf_fwhm: number | null; core_flags: string[];
  uri: string; release: string; pass: number; exptime: number | null; sc_km: (number | null)[]; obsid: string;
};
export type Frame = { meta: Meta; image: Float32Array; sigma: Float32Array; mask: Uint8Array };

export const CLASS = { bad: 1, saturated: 2, transient: 4, persistence: 8, artifact: 16, source: 32, dichroic: 64, other: 128 } as const;
export const CLASS_LABEL: Record<string, string> = {
  bad: "dead or missing pixel", saturated: "saturated (too bright)", transient: "cosmic ray or outlier",
  persistence: "afterimage of an earlier bright star", artifact: "ghost, streak or halo", other: "other flag",
};

/** IEEE half-float (uint16) to number. */
export function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Parse one cutout blob: uint32 header length, JSON, float32 image, float16 sigma, uint8 mask. */
export function parseBlob(buf: ArrayBuffer, offset = 0): Frame {
  const headerView = new DataView(buf, offset);
  const headerLen = headerView.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, offset + 4, headerLen))) as Meta;
  const size = meta.n, numPix = size * size;
  let pos = offset + 4 + headerLen;
  const image = new Float32Array(numPix), sigma = new Float32Array(numPix);
  const view = new DataView(buf);
  for (let i = 0; i < numPix; i++) image[i] = view.getFloat32(pos + 4 * i, true);
  pos += 4 * numPix;
  for (let i = 0; i < numPix; i++) sigma[i] = half(view.getUint16(pos + 2 * i, true));
  pos += 2 * numPix;
  const mask = new Uint8Array(buf.slice(pos, pos + numPix));
  return { meta, image, sigma, mask };
}

/** Sky position to stamp pixel (col, row), exact gnomonic projection about (ra0, dec0). */
export function skyToPix(ra: number, dec: number, ra0: number, dec0: number, n: number): [number, number] {
  const dRa = (ra - ra0) * D2R, decRad = dec * D2R, dec0Rad = dec0 * D2R;
  const cosDist = Math.sin(dec0Rad) * Math.sin(decRad) + Math.cos(dec0Rad) * Math.cos(decRad) * Math.cos(dRa);
  const xi = (Math.cos(decRad) * Math.sin(dRa)) / cosDist; // east, radians
  const eta = (Math.cos(dec0Rad) * Math.sin(decRad) - Math.sin(dec0Rad) * Math.cos(decRad) * Math.cos(dRa)) / cosDist; // north
  const centre = (n - 1) / 2;
  return [centre - xi / (PIX * AS2R), centre - eta / (PIX * AS2R)];
}

/** Stamp pixel (col, row) to sky position, inverse gnomonic. */
export function pixToSky(col: number, row: number, ra0: number, dec0: number, n: number): [number, number] {
  const centre = (n - 1) / 2, xi = (centre - col) * PIX * AS2R, eta = (centre - row) * PIX * AS2R, dec0Rad = dec0 * D2R;
  const denom = Math.cos(dec0Rad) - eta * Math.sin(dec0Rad);
  const ra = ra0 + Math.atan2(xi, denom) / D2R;
  const dec = Math.atan2(Math.sin(dec0Rad) + eta * Math.cos(dec0Rad), Math.hypot(xi, denom)) / D2R;
  return [((ra % 360) + 360) % 360, dec];
}

/** Julian year of an MJD (UTC is close enough: the difference is about a minute). */
export const mjdToYear = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;

/** First-order proper-motion propagation; pm in mas/yr, pmra includes cos(dec). */
export function propagate(ra: number, dec: number, pmra: number, pmdec: number, epoch0: number, epoch1: number): [number, number] {
  const dt = epoch1 - epoch0;
  return [ra + (pmra * dt) / 3.6e6 / Math.cos(dec * D2R), dec + (pmdec * dt) / 3.6e6];
}

/** Wavelength (um) at a stamp pixel, from the per-frame linear model. */
export function lamAt(meta: Meta, col: number, row: number): number {
  const centre = (meta.n - 1) / 2;
  return meta.lam + meta.dlam_east * (centre - col) + meta.dlam_north * (centre - row);
}

export function median(values: number[] | Float32Array): number {
  const sorted = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** Median and robust sigma (1.4826 x MAD) of the finite values. */
export function robust(values: Float32Array | number[]): { med: number; sig: number } {
  const med = median(values);
  const deviations = Array.from(values).filter(Number.isFinite).map((x) => Math.abs(x - med));
  return { med, sig: 1.4826 * median(deviations) };
}

export function percentile(values: Float32Array, p: number): number {
  const sorted = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}

export type Phot = { flux: number; err: number; flags: number; npix: number; ok: boolean };
/**
 * Aperture photometry on a stamp in MJy/sr. Flux and error in microjansky:
 * F = sum(I - sky) * OMEGA_PIX * 1e12, err = sqrt(sum(sigma^2)) * OMEGA_PIX * 1e12.
 * Sky is the median in an annulus. No aperture correction is applied.
 */
export function aperture(frame: Frame, col: number, row: number, r = 2, rIn = 4, rOut = 7): Phot {
  const size = frame.meta.n, annulus: number[] = [];
  let sum = 0, variance = 0, npix = 0, flags = 0, bad = 0;
  const x0 = Math.max(0, Math.floor(col - rOut)), x1 = Math.min(size - 1, Math.ceil(col + rOut));
  const y0 = Math.max(0, Math.floor(row - rOut)), y1 = Math.min(size - 1, Math.ceil(row + rOut));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dist = Math.hypot(x - col, y - row), i = y * size + x, value = frame.image[i];
    if (dist >= rIn && dist <= rOut && Number.isFinite(value)) annulus.push(value);
  }
  const sky = annulus.length ? median(annulus) : 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (Math.hypot(x - col, y - row) > r) continue;
    const i = y * size + x, value = frame.image[i];
    flags |= frame.mask[i];
    if (!Number.isFinite(value)) { bad++; continue; }
    sum += value - sky; variance += frame.sigma[i] * frame.sigma[i]; npix++;
  }
  const toMicroJy = OMEGA_PIX * 1e12;
  const inside = col >= r && row >= r && col <= size - 1 - r && row <= size - 1 - r;
  return { flux: sum * toMicroJy, err: Math.sqrt(variance) * toMicroJy, flags, npix, ok: inside && bad === 0 && npix > 0 && annulus.length >= 8 };
}

/** Per-pixel median of several frames, ignoring NaN and pixels flagged bad or saturated. */
export function medianStack(frames: Frame[]): Float32Array {
  const numPix = frames[0].image.length, out = new Float32Array(numPix), vals: number[] = [];
  const reject = CLASS.bad | CLASS.saturated;
  const frameMedians = frames.map((f) => robust(f.image).med);
  for (let i = 0; i < numPix; i++) {
    vals.length = 0;
    for (let k = 0; k < frames.length; k++) {
      const v = frames[k].image[i];
      if (Number.isFinite(v) && !(frames[k].mask[i] & reject)) vals.push(v - frameMedians[k]);
    }
    out[i] = vals.length ? median(vals) : NaN;
  }
  return out;
}

/** Half a resolution element: the tolerance for calling two images "the same colour". */
export const gate = (det: number) => 1 / (2 * R_BAND[det]);
export const sameColour = (lamA: number, lamB: number, det: number) => Math.abs(Math.log(lamA / lamB)) < gate(det);

export type Verdict = { kind: "camera" | "unknown" | "changed" | "same"; text: string; z?: number; pct?: number };
/**
 * Rule-based reading of a brightness comparison at one spot between two frames.
 * Order of checks: colour match, clean pixels, then significance with a 5% calibration floor.
 */
export function compare(a: Frame, b: Frame, col: number, row: number, floor = 0.05): Verdict {
  const lamA = lamAt(a.meta, col, row), lamB = lamAt(b.meta, col, row);
  if (a.meta.det !== b.meta.det || !sameColour(lamA, lamB, a.meta.det))
    return { kind: "camera", text: `The camera changed, not the sky: these images are different colours (${lamA.toFixed(3)} and ${lamB.toFixed(3)} µm).` };
  const photA = aperture(a, col, row), photB = aperture(b, col, row);
  const blocking = CLASS.bad | CLASS.saturated | CLASS.transient | CLASS.persistence | CLASS.artifact;
  const badFlags = (photA.flags | photB.flags) & blocking;
  if (!photA.ok || !photB.ok || badFlags) {
    const names = Object.entries(CLASS).filter(([, bit]) => badFlags & bit).map(([k]) => CLASS_LABEL[k]);
    return { kind: "unknown", text: `Cannot tell: ${names.length ? "flagged pixels here (" + names.join(", ") + ")" : "this spot is too close to the edge or has missing data"}.` };
  }
  const mean = 0.5 * (photA.flux + photB.flux);
  const z = (photB.flux - photA.flux) / Math.sqrt(photA.err ** 2 + photB.err ** 2 + (floor * mean) ** 2);
  const pct = mean !== 0 ? (100 * (photB.flux - photA.flux)) / Math.abs(mean) : 0;
  if (Math.abs(z) >= 3)
    return { kind: "changed", z, pct, text: `Brightness here ${z > 0 ? "rose" : "fell"} by ${Math.abs(pct).toFixed(0)}% at the same colour (${Math.abs(z).toFixed(1)}σ, with a 5% calibration allowance).` };
  return { kind: "same", z, pct, text: `No significant brightness change at this spot (${Math.abs(z).toFixed(1)}σ).` };
}

/** Format degrees as sexagesimal strings. */
export function sexa(ra: number, dec: number): string {
  const h = ra / 15, hh = Math.floor(h), hm = Math.floor((h - hh) * 60), hs = ((h - hh) * 60 - hm) * 60;
  const s = dec < 0 ? "−" : "+", ad = Math.abs(dec), dd = Math.floor(ad), dm = Math.floor((ad - dd) * 60), ds = ((ad - dd) * 60 - dm) * 60;
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${p(hh)}h${p(hm)}m${hs.toFixed(2).padStart(5, "0")}s ${s}${p(dd)}°${p(dm)}′${ds.toFixed(1).padStart(4, "0")}″`;
}

// ---- Distance from three sightings (parallax with the object's own motion cancelled) ----
export type Sighting = { mjd: number; ra: number; dec: number; obs: [number, number, number] }; // obs: heliocentric observer, au, J2000 equatorial
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const lin = (a: V3, b: V3, f: number): V3 => [(1 - f) * a[0] + f * b[0], (1 - f) * a[1] + f * b[1], (1 - f) * a[2] + f * b[2]];
export const unitVec = (ra: number, dec: number): V3 => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];

export type Distance = { d: number; hopDeg: number; bPerp: number; relErr: number; ok: boolean; why: string };
/**
 * Sightings A and C (same season, a year apart) are interpolated to the time of B to cancel
 * the object's own motion; what is left between that direction and B's is parallax:
 *   f = (tB - tA)/(tC - tA),  uI = norm((1-f) uA + f uC),  EI = (1-f) EA + f EC,
 *   b = EB - EI,  b_perp = b - (b.uB) uB,  h = angle(uI, uB),  d = |b_perp| / tan(h) - b.uB
 * `clickArcsec` is the 1-sigma position error per click, used for the quoted uncertainty.
 * The method needs a wide sideways baseline: it refuses when |b_perp| < 0.5 au or when the
 * hop is not at least ten times the click error (an independent audit showed errors of 1.8%
 * for near-opposition geometry that SPHEREx never observes).
 */
export function threePassDistance(A: Sighting, B: Sighting, C: Sighting, clickArcsec = PIX): Distance {
  const f = (B.mjd - A.mjd) / (C.mjd - A.mjd);
  const uA = unitVec(A.ra, A.dec), uB = unitVec(B.ra, B.dec), uC = unitVec(C.ra, C.dec);
  const midDir = lin(uA, uC, f), midLen = norm(midDir), uI: V3 = [midDir[0] / midLen, midDir[1] / midLen, midDir[2] / midLen];
  const EI = lin(A.obs, C.obs, f), b: V3 = [B.obs[0] - EI[0], B.obs[1] - EI[1], B.obs[2] - EI[2]];
  const along = dot(b, uB), bPerpVec: V3 = [b[0] - along * uB[0], b[1] - along * uB[1], b[2] - along * uB[2]];
  const h = Math.atan2(norm(cross(uI, uB)), dot(uI, uB)), bPerp = norm(bPerpVec);
  const sigmaHop = clickArcsec * AS2R * Math.sqrt(1 + (1 - f) ** 2 + f ** 2);
  const d = bPerp / Math.tan(h) - along, relErr = sigmaHop / h;
  let why = "";
  if (!(f > 0.2 && f < 0.8)) why = "The middle sighting must sit well between the other two in time.";
  else if (bPerp < 0.5) why = "The viewpoints are not far enough apart sideways for this object.";
  else if (relErr > 0.1) why = "The hop is too small compared with the click accuracy: the object is too far for this method.";
  return { d, hopDeg: h / D2R, bPerp, relErr, ok: !why && d > 0, why };
}

/** Flux-weighted centre near a click (5x5 box, sky-subtracted, positive pixels only). */
export function refineClick(frame: Frame, col: number, row: number): [number, number] {
  const size = frame.meta.n, background = robust(frame.image).med, col0 = Math.round(col), row0 = Math.round(row);
  let total = 0, sumX = 0, sumY = 0;
  for (let y = row0 - 2; y <= row0 + 2; y++) for (let x = col0 - 2; x <= col0 + 2; x++) {
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const v = frame.image[y * size + x] - background;
    if (Number.isFinite(v) && v > 0) { total += v; sumX += v * x; sumY += v * y; }
  }
  return total > 0 ? [sumX / total, sumY / total] : [col, row];
}
