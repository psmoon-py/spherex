// Tests with independently known answers.
import { describe, expect, it } from "vitest";
import { aperture, compare, Frame, gate, half, lamAt, medianStack, mjdToYear, OMEGA_PIX, parseBlob, pixToSky, propagate, sameColour, skyToPix } from "./sky";

function frame(n: number, fill: (x: number, y: number) => number, over: Partial<Frame["meta"]> = {}): Frame {
  const image = new Float32Array(n * n), sigma = new Float32Array(n * n).fill(0.01), mask = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) image[y * n + x] = fill(x, y);
  const meta = { n, ra: 10, dec: 20, mjd: 60900, date: "", det: 3, lam: 2.0, bw: 0.05, dlam_east: 0, dlam_north: 0, finast: 0, psf_fwhm: 5, core_flags: [], uri: "", release: "dr1", pass: 0, exptime: 113, sc_km: [0, 0, 0], obsid: "", ...over };
  return { meta, image, sigma, mask };
}

describe("units", () => {
  it("pixel solid angle and flux conversion match the hand values", () => {
    expect(OMEGA_PIX).toBeCloseTo(8.88996e-10, 14); // (6.15 arcsec)^2 in sr
    expect(OMEGA_PIX * 1e12).toBeCloseTo(888.996, 2); // uJy for 1 MJy/sr over one pixel
  });
  it("half floats decode", () => {
    expect(half(0x3c00)).toBe(1); expect(half(0xc000)).toBe(-2); expect(half(0x3555)).toBeCloseTo(0.33325, 4); expect(half(0)).toBe(0);
  });
});

describe("geometry", () => {
  it("north is up (row decreases) and east is left (column decreases)", () => {
    const n = 59, c = 29;
    const [col, row] = skyToPix(10, 20 + 61.5 / 3600, 10, 20, n); // 10 pixels north
    expect(col).toBeCloseTo(c, 6); expect(row).toBeCloseTo(c - 10, 3);
    const [col2] = skyToPix(10 + 61.5 / 3600 / Math.cos((20 * Math.PI) / 180), 20, 10, 20, n); // 10 pixels east
    expect(col2).toBeCloseTo(c - 10, 2);
  });
  it("pixToSky inverts skyToPix, including near the pole and across RA = 0", () => {
    for (const [ra0, dec0] of [[10, 20], [0.01, -30], [248.2, 66.75], [120, 89.5]]) {
      for (const [col, row] of [[3, 50], [29, 29], [55.5, 7.25]]) {
        const [ra, dec] = pixToSky(col, row, ra0, dec0, 59);
        const [c2, r2] = skyToPix(ra, dec, ra0, dec0, 59);
        expect(c2).toBeCloseTo(col, 6); expect(r2).toBeCloseTo(row, 6);
      }
    }
  });
  it("proper motion: Barnard's Star moves 103.62 arcsec north in ten years", () => {
    const [ra, dec] = propagate(269.45, 4.74, -802, 10362, 2016, 2026);
    expect((dec - 4.74) * 3600).toBeCloseTo(103.62, 6);
    expect((ra - 269.45) * 3600 * Math.cos((4.74 * Math.PI) / 180)).toBeCloseTo(-8.02, 6);
    expect(mjdToYear(51544.5)).toBe(2000);
  });
  it("WISE 0855: NASA's 2010 position has moved about 126 arcsec by late 2025", () => {
    const ra0 = 15 * (8 + 55 / 60 + 10.831 / 3600), dec0 = -(7 + 14 / 60 + 42.53 / 3600);
    const [ra, dec] = propagate(ra0, dec0, -8118, 680, 2010.4, 2025.84);
    const [col, row] = skyToPix(ra, dec, ra0, dec0, 59);
    const shift = Math.hypot(col - 29, row - 29) * 6.15;
    expect(shift).toBeGreaterThan(124); expect(shift).toBeLessThan(128);
    expect(col).toBeGreaterThan(29); // west is to the right
  });
});

describe("photometry and comparison", () => {
  const star = (flux: number, cx = 15, cy = 15) => (x: number, y: number) => 0.2 + (flux / (2 * Math.PI * 1.2 * 1.2)) * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.2 * 1.2));
  it("recovers a known flux above a flat sky, in microjansky", () => {
    const f = frame(31, star(100)); // sum of star = 100 MJy/sr * pixels
    const p = aperture(f, 15, 15, 5, 8, 12);
    expect(p.flux / (100 * OMEGA_PIX * 1e12)).toBeCloseTo(1, 2);
    expect(p.err).toBeCloseTo(Math.sqrt(p.npix) * 0.01 * OMEGA_PIX * 1e12, 4); // sigma is stored as float32
    expect(p.ok).toBe(true);
  });
  it("wavelength gate values", () => {
    expect(gate(1)).toBeCloseTo(0.01282, 5); expect(gate(4)).toBeCloseTo(0.014286, 6); expect(gate(6)).toBeCloseTo(0.0039063, 7);
    expect(sameColour(2.0, 2.02, 3)).toBe(true); expect(sameColour(2.0, 2.03, 3)).toBe(false);
  });
  it("wavelength model is linear across the stamp", () => {
    const f = frame(31, () => 0, { lam: 2, dlam_east: 0.001, dlam_north: -0.002 });
    expect(lamAt(f.meta, 15, 15)).toBe(2); expect(lamAt(f.meta, 5, 15)).toBeCloseTo(2.01, 9); expect(lamAt(f.meta, 15, 5)).toBeCloseTo(1.98, 9);
  });
  it("calls a colour mismatch a camera change, a flag unknown, and a real change changed", () => {
    const a = frame(31, star(100)), b = frame(31, star(100), { lam: 2.1 });
    expect(compare(a, b, 15, 15).kind).toBe("camera");
    const c = frame(31, star(100)); c.mask[15 * 31 + 15] = 4;
    expect(compare(a, c, 15, 15).kind).toBe("unknown");
    expect(compare(a, frame(31, star(100)), 15, 15).kind).toBe("same");
    const d = compare(a, frame(31, star(200)), 15, 15);
    expect(d.kind).toBe("changed"); expect(d.pct!).toBeGreaterThan(55); // +100% on A is +66.7% of the mean
    expect(compare(a, frame(31, star(108)), 15, 15).kind).toBe("same"); // 8% is inside the 5%-floor 3-sigma band
  });
  it("median stack ignores a cosmic ray", () => {
    const fs = [0, 1, 2].map(() => frame(9, () => 1));
    fs[1].image[40] = 500;
    expect(medianStack(fs)[40]).toBeCloseTo(0, 6);
  });
  it("blob parser round-trips", () => {
    const meta = JSON.stringify({ n: 3, lam: 1 }); const pad = (4 - (meta.length % 4)) % 4; const m = meta + " ".repeat(pad);
    const buf = new ArrayBuffer(4 + m.length + 9 * 4 + 9 * 2 + 9); const dv = new DataView(buf);
    dv.setUint32(0, m.length, true); new Uint8Array(buf, 4, m.length).set(new TextEncoder().encode(m));
    for (let i = 0; i < 9; i++) { dv.setFloat32(4 + m.length + 4 * i, i * 1.5, true); dv.setUint16(4 + m.length + 36 + 2 * i, 0x3c00, true); dv.setUint8(4 + m.length + 54 + i, i); }
    const f = parseBlob(buf);
    expect(f.meta.n).toBe(3); expect(f.image[4]).toBe(6); expect(f.sigma[8]).toBe(1); expect(f.mask[7]).toBe(7);
  });
});

import { Body, HelioVector } from "astronomy-engine";
import { Sighting, threePassDistance, unitVec } from "./sky";
describe("distance from three sightings", () => {
  const earth = (iso: string): [number, number, number] => { const v = HelioVector(Body.Earth, new Date(iso)); return [v.x, v.y, v.z]; };
  const mjd = (iso: string) => new Date(iso).getTime() / 86400000 + 40587;
  // A body moving in a straight line at 4.4 km/s, 52.7 au from the Sun toward Makemake's direction.
  function sight(iso: string, d0: number, t0: string): Sighting & { delta: number } {
    const u0 = unitVec(201.0, 20.8), dt = mjd(iso) - mjd(t0), v = 4.4 * 86400 / 149597870.7; // au per day
    const perp: [number, number, number] = [-Math.sin((201 * Math.PI) / 180), Math.cos((201 * Math.PI) / 180), 0];
    const X = [0, 1, 2].map((k) => d0 * u0[k] + v * dt * perp[k]);
    const E = earth(iso), r = [X[0] - E[0], X[1] - E[1], X[2] - E[2]], delta = Math.hypot(r[0], r[1], r[2]);
    return { mjd: mjd(iso), ra: ((Math.atan2(r[1], r[0]) * 180) / Math.PI + 360) % 360, dec: (Math.asin(r[2] / delta) * 180) / Math.PI, obs: E, delta };
  }
  it("recovers 52.7 au within 0.3% on SPHEREx-like dates", () => {
    const A = sight("2025-06-02T00:00:00Z", 52.7, "2026-01-02T00:00:00Z"), B = sight("2026-01-02T00:00:00Z", 52.7, "2026-01-02T00:00:00Z"), C = sight("2026-06-05T00:00:00Z", 52.7, "2026-01-02T00:00:00Z");
    const r = threePassDistance(A, B, C);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.d / B.delta - 1)).toBeLessThan(0.003);
    expect(r.hopDeg).toBeGreaterThan(1.8); expect(r.hopDeg).toBeLessThan(2.4); // about 2 au / 52.7 au = 2.17 deg
    expect(r.relErr).toBeLessThan(0.002);
  });
  it("refuses a geometry with no sideways baseline (object near opposition at B)", () => {
    // Same dates, object placed opposite the Sun as seen on 2 Jan (ecliptic longitude near 101 deg).
    const far = (iso: string): Sighting => { const E = earth(iso), u = unitVec(101.8, 23.0), X = u.map((k) => 52.7 * k), r = [X[0] - E[0], X[1] - E[1], X[2] - E[2]], d = Math.hypot(r[0], r[1], r[2]); return { mjd: mjd(iso), ra: ((Math.atan2(r[1], r[0]) * 180) / Math.PI + 360) % 360, dec: (Math.asin(r[2] / d) * 180) / Math.PI, obs: E }; };
    const r = threePassDistance(far("2025-06-02T00:00:00Z"), far("2026-01-02T00:00:00Z"), far("2026-06-05T00:00:00Z"));
    expect(r.ok).toBe(false);
  });
});
