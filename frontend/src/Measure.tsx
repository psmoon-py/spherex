// "Measure a world": find a dwarf planet by its motion in three passes, click it,
// and get its distance from parallax.
import { useEffect, useMemo, useState } from "react";
import { Body, HelioVector } from "astronomy-engine";
import { Frame, medianStack, parseBlob, PIX, pixToSky, refineClick, robust, percentile, Sighting, skyToPix, threePassDistance } from "./lib/sky";
import { Viewer, Marker } from "./Viewer";

type Truth = { ra: number; dec: number; delta: number; r: number; elong: number };
type Field = { ra: number; dec: number; date: string; frames: { offset: number; length: number; mjd: number; lam: number; det: number; truth: Truth }[] };
type Man = { body: { name: string; blurb: string; source: string }; n: number; fields: Field[] };
type Pick = { frame: number; col: number; row: number; ra: number; dec: number };
const AU_KM = 149597870.7;

/** SPHEREx takes up to four exposures a few minutes apart. Adding each such group makes a faint
 *  body stand out (it moves well under a pixel in that time) and removes cosmic rays. */
function groupStacks(frames: Frame[], truths: Truth[]): { frames: Frame[]; truths: Truth[]; counts: number[] } {
  const groups: number[][] = [];
  frames.forEach((f, i) => { const g = groups[groups.length - 1]; if (g && f.meta.mjd - frames[g[g.length - 1]].meta.mjd < 0.02) g.push(i); else groups.push([i]); });
  const out: Frame[] = [], outTruths: Truth[] = [], counts: number[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const members = g.map((i) => frames[i]), mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const mid = members[members.length >> 1];
    out.push({ meta: { ...mid.meta, mjd: mean(members.map((f) => f.meta.mjd)) }, image: medianStack(members), sigma: mid.sigma, mask: new Uint8Array(mid.mask.length) });
    outTruths.push({ ...truths[g[0]], ra: mean(g.map((i) => truths[i].ra)), dec: mean(g.map((i) => truths[i].dec)), delta: mean(g.map((i) => truths[i].delta)) });
    counts.push(g.length);
  }
  return { frames: out, truths: outTruths, counts };
}
const LETTERS = ["A", "B", "C"];

/** Heliocentric observer position (au, J2000 equatorial): Earth plus the spacecraft's geocentric offset. */
function observer(mjd: number, sc: (number | null)[]): [number, number, number] {
  const earth = HelioVector(Body.Earth, new Date((mjd - 40587) * 86400000));
  const offset = sc.every((x) => typeof x === "number") ? (sc as number[]) : [0, 0, 0];
  return [earth.x + offset[0] / AU_KM, earth.y + offset[1] / AU_KM, earth.z + offset[2] / AU_KM];
}

export function Measure({ slug, onExit }: { slug: string; onExit: () => void }) {
  const [manifest, setManifest] = useState<Man | null>(null);
  const [fields, setFields] = useState<Frame[][]>([]);
  const [truths, setTruths] = useState<Truth[][]>([]);
  const [counts, setCounts] = useState<number[][]>([]);
  const [hint, setHint] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [picks, setPicks] = useState<(Pick | null)[]>([null, null, null]);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const m: Man = await (await fetch(`./packs/${slug}/manifest.json`)).json();
        const fs = await Promise.all(m.fields.map(async (f, k) => {
          const buf = await (await fetch(`./packs/${slug}/field${k}.bin`)).arrayBuffer();
          return groupStacks(f.frames.map((x) => parseBlob(buf, x.offset)), f.frames.map((x) => x.truth));
        }));
        setManifest(m); setFields(fs.map((x) => x.frames)); setTruths(fs.map((x) => x.truths)); setCounts(fs.map((x) => x.counts));
      } catch { setLoadError("The saved images for this exercise could not be loaded."); }
    })();
  }, [slug]);

  const frames = fields[step] ?? [];
  const i = frames.length ? Math.min(idx, frames.length - 1) : 0;
  const curFrame = frames[i] ?? null;
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => setIdx((k) => (k + 1) % frames.length), 600);
    return () => clearInterval(t);
  }, [playing, frames.length]);

  const done = picks.every(Boolean);
  const result = useMemo(() => {
    if (!manifest || !done) return null;
    const sightings: Sighting[] = picks.map((p, k) => { const fr = fields[k][p!.frame]; return { mjd: fr.meta.mjd, ra: p!.ra, dec: p!.dec, obs: observer(fr.meta.mjd, fr.meta.sc_km) }; });
    const dist = threePassDistance(sightings[0], sightings[1], sightings[2]);
    const truth = truths[1][picks[1]!.frame].delta;
    const miss = picks.map((p, k) => { const t = truths[k][p!.frame]; const [c, rw] = skyToPix(t.ra, t.dec, manifest.fields[k].ra, manifest.fields[k].dec, manifest.n); return Math.hypot(c - p!.col, rw - p!.row); });
    return { r: dist, truth, miss, s: sightings };
  }, [manifest, done, picks, fields, truths]);

  if (loadError) return <p className="error">{loadError} <button className="link" onClick={onExit}>Back to the viewer</button></p>;
  if (!manifest || !curFrame) return <p className="hint">Loading the three passes…</p>;
  const fld = manifest.fields[step], pick = picks[step];
  const st = robust(curFrame.image), hi = Math.max(st.med + 10 * st.sig, Math.min(percentile(curFrame.image, 99.5), st.med + 40 * st.sig));
  const markers: Marker[] = [];
  if (pick) markers.push({ col: pick.col, row: pick.row, kind: "point" });
  if (reveal || hint) { const t = truths[step][i]; const [c, r] = skyToPix(t.ra, t.dec, fld.ra, fld.dec, manifest.n); markers.push({ col: c, row: r, kind: "track", label: reveal ? "JPL" : "hint" }); }

  return (
    <div className="measure">
      <div className="mhead">
        <h2>Measure a world: {manifest.body.name}</h2>
        <button className="link" onClick={onExit}>Back to the viewer</button>
      </div>
      <p className="lede">SPHEREx photographed this dwarf planet three times, from opposite sides of the Sun. In each set of images, <b>one dot drifts while the stars stay still</b>. Find it, click it, and your three clicks give its distance.</p>
      <div className="steps" role="tablist">
        {manifest.fields.map((x, k) => <button key={k} role="tab" aria-selected={step === k} className={step === k ? "on" : ""} onClick={() => { setStep(k); setIdx(0); setPlaying(true); }}>Pass {LETTERS[k]} · {x.date.slice(0, 7)} {picks[k] ? "(Marked)" : ""}</button>)}
      </div>
      <main>
        <section className="stage">
          <Viewer image={curFrame.image} mask={curFrame.mask} n={manifest.n} lo={st.med - 2 * st.sig} hi={hi} asinh={false} diverging={false} showFlags={false} markers={markers}
            onPick={(c, r) => {
              const [cc, rr] = refineClick(curFrame, c, r); const [ra, dec] = pixToSky(cc, rr, fld.ra, fld.dec, manifest.n);
              setPlaying(false); setPicks((p) => p.map((x, k) => (k === step ? { frame: i, col: cc, row: rr, ra, dec } : x)));
            }} />
          <p className="caption">{curFrame.meta.date.slice(0, 16).replace("T", " ")} UTC · {counts[step]?.[i]} exposures added · detector {curFrame.meta.det} · image {i + 1} of {frames.length}</p>
          <div className="controls"><div className="transport">
            <button onClick={() => { setPlaying(false); setIdx((k) => (k - 1 + frames.length) % frames.length); }} aria-label="Previous image">◀</button>
            <button className="play" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
            <button onClick={() => { setPlaying(false); setIdx((k) => (k + 1) % frames.length); }} aria-label="Next image">▶</button>
            {pick && step < 2 && <button onClick={() => { setStep(step + 1); setIdx(0); setPlaying(true); }}>Next pass →</button>}
            {pick && <button className="link" onClick={() => setPicks((p) => p.map((x, k) => (k === step ? null : x)))}>Clear my click</button>}
            {!reveal && <button className="link" onClick={() => setHint((h) => !h)}>{hint ? "Hide the hint" : "Need a hint?"}</button>}
          </div></div>
          <p className="hint">Each image adds the exposures SPHEREx took within a few minutes. Colours differ from image to image, so stars flicker in brightness. Look for the faint dot that changes <i>place</i>. The click snaps to the nearest bright spot. {pick && `Your click is on image ${pick.frame + 1}.`}{hint && " The ring shows where JPL predicts the body; using it is fine, but then the pointing is no longer yours."}</p>
        </section>
        <aside>
          <section className="card">
            <h2>Your measurement</h2>
            {!done && <p className="hint">{picks.filter(Boolean).length} of 3 passes marked.</p>}
            {result && (result.r.ok ? (
              <>
                <p className="big">{result.r.d.toFixed(1)} au <span>± {(100 * result.r.relErr).toFixed(1)}% from click accuracy</span></p>
                <p>That is {(result.r.d * AU_KM / 1e9).toFixed(2)} billion km: sunlight takes {(result.r.d * 8.3167 / 60).toFixed(1)} hours to get there.</p>
                <p>Between passes the dot hopped <b>{result.r.hopDeg.toFixed(2)}°</b> ({Math.round(result.r.hopDeg * 3600 / PIX)} pixels, {(result.r.hopDeg / 0.52).toFixed(1)} full Moons), because SPHEREx looked from two places {result.r.bPerp.toFixed(2)} au apart.</p>
                {!reveal ? <button onClick={() => setReveal(true)}>Compare with NASA JPL’s orbit</button> : (
                  <div className="truth">
                    <p>JPL Horizons distance on the pass B date: <b>{result.truth.toFixed(2)} au</b>. You are off by <b>{(100 * (result.r.d / result.truth - 1)).toFixed(2)}%</b>.</p>
                    <p className="hint">Your clicks were {result.miss.map((m) => m.toFixed(1)).join(", ")} pixels from JPL’s predicted positions (yellow rings). If one is far off, you clicked a star: clear it and try again.</p>
                  </div>
                )}
              </>
            ) : <p className="verdict unknown">Cannot measure: {result.r.why}</p>)}
          </section>
          <section className="card">
            <h2>Why this works</h2>
            <Diagram s={result?.s ?? null} />
            <p className="hint">Passes A and C are a year apart, so Earth is back in the same place and only the planet’s own slow drift separates them. Pass B is from the far side of Earth’s orbit. Averaging A and C, then comparing with B, leaves only the shift caused by our own change of viewpoint. A bigger shift means a nearer world.</p>
            <p className="hint">Honest note: JPL’s prediction was used only to choose where to point this viewer. The distance comes from your three clicks and Earth’s position. Method checked on simulated orbits; it refuses objects whose hop is too small to measure.</p>
          </section>
        </aside>
      </main>
    </div>
  );
}

/** Top view of Earth's orbit with the three viewpoints and sight lines (ecliptic plane, not to scale beyond 1 au). */
function Diagram({ s }: { s: Sighting[] | null }) {
  const e = (23.4392911 * Math.PI) / 180, S = 230, c = S / 2, R = 62;
  const ecl = (v: number[]) => [v[0], v[1] * Math.cos(e) + v[2] * Math.sin(e)];
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="diagram" role="img" aria-label="Earth's orbit with the three viewpoints">
      <circle cx={c} cy={c} r={R} className="orbit" /><circle cx={c} cy={c} r={5} className="sun" /><text x={c + 8} y={c + 4}>Sun</text>
      {s ? s.map((p, k) => {
        const [x, y] = ecl(p.obs), px = c + x * R, py = c - y * R;
        const u = [Math.cos((p.dec * Math.PI) / 180) * Math.cos((p.ra * Math.PI) / 180), Math.cos((p.dec * Math.PI) / 180) * Math.sin((p.ra * Math.PI) / 180), Math.sin((p.dec * Math.PI) / 180)];
        const [ux, uy] = ecl(u), L = 400;
        return <g key={k}><line x1={px} y1={py} x2={px + ux * L} y2={py - uy * L} className={`sight s${k}`} /><circle cx={px} cy={py} r={4} className={`earth s${k}`} /><text x={px + (x > 0 ? 7 : -14)} y={py + (y > 0 ? -7 : 14)}>{LETTERS[k]}</text></g>;
      }) : <text x={c} y={S - 8} textAnchor="middle">Mark all three passes to see the sight lines.</text>}
    </svg>
  );
}
