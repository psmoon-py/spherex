import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CAP, choose, FOVS, FrameRef, GaiaStar, getApi, liveCutout, liveFrames, liveGaia, Manifest, PACK_N, packDetector, packManifest, Preset, PRESETS, resolveName } from "./lib/data";
import { aperture, CLASS, CLASS_LABEL, compare, Frame, gate, lamAt, medianStack, mjdToYear, percentile, PIX, pixToSky, propagate, robust, sexa, skyToPix } from "./lib/sky";
import { Marker, Viewer } from "./Viewer";
import { PASS_COLOURS, SpecPoint, Spectrum } from "./Spectrum";
import { Measure } from "./Measure";

type Target = { ra: number; dec: number; name: string | null; preset: Preset | null };
type Mode = "frames" | "passes" | "diff";
type Item = { image: Float32Array; mask: Uint8Array | null; frame: Frame | null; frames: Frame[]; label: string; mjd: number };
const BANDS: Record<number, string> = { 1: "0.75–1.09", 2: "1.10–1.62", 3: "1.63–2.41", 4: "2.42–3.82", 5: "3.83–4.41", 6: "4.42–5.00" };
const statsCache = new WeakMap<Float32Array, { med: number; sig: number; p995: number }>();
function stats(img: Float32Array) {
  let cached = statsCache.get(img);
  if (!cached) { cached = { ...robust(img), p995: percentile(img, 99.5) }; statsCache.set(img, cached); }
  return cached;
}
const fmtDate = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

function readUrl(): { target: Target | null; n: number; det: number } {
  const params = new URLSearchParams(location.search);
  const fov = FOVS.find((f) => f.label.startsWith(params.get("fov") ?? "~"))?.n ?? PACK_N;
  const det = Math.min(6, Math.max(1, Number(params.get("det")) || 3));
  const slug = params.get("target");
  const preset = PRESETS.find((x) => x.slug === slug);
  if (preset) return { target: { ra: preset.ra, dec: preset.dec, name: preset.name, preset: preset }, n: fov, det };
  const ra = Number(params.get("ra")), dec = Number(params.get("dec"));
  if (params.get("ra") !== null && params.get("dec") !== null && Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90)
    return { target: { ra, dec, name: params.get("name"), preset: null }, n: fov, det };
  return { target: null, n: fov, det };
}

export default function App() {
  const fromUrl = useMemo(readUrl, []);
  const [target, setTarget] = useState<Target | null>(fromUrl.target ?? { ra: PRESETS[0].ra, dec: PRESETS[0].dec, name: PRESETS[0].name, preset: PRESETS[0] });
  const [fovPix, setFovPix] = useState(fromUrl.n);
  const [det, setDet] = useState(fromUrl.det);
  const [query, setQuery] = useState("");
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [frames, setFrames] = useState<Record<number, Frame[]>>({});
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [gaia, setGaia] = useState<GaiaStar[]>([]);
  const [mode, setMode] = useState<Mode>("passes");
  const [sameColour, setSameColour] = useState(true);
  const [lamRef, setLamRef] = useState<number | null>(null);
  const [idx, setIdx] = useState(0);
  const [pinned, setPinned] = useState<Frame | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(2);
  const [contrast, setContrast] = useState(12);
  const [asinh, setAsinh] = useState(false);
  const [showFlags, setShowFlags] = useState(false);
  const [showGaia, setShowGaia] = useState(true);
  const [point, setPoint] = useState<{ ra: number; dec: number } | null>(null); // null = follow the target/track
  const [diffAB, setDiffAB] = useState<[number, number]>([0, 1]);
  const [measure, setMeasure] = useState(new URLSearchParams(location.search).get("measure") === "makemake");
  const manRef = useRef<Manifest | null>(null);
  const refsRef = useRef<FrameRef[]>([]);
  const loadId = useRef(0);

  const usePack = !!target?.preset && fovPix === PACK_N;

  // The free API host sleeps when idle and takes about a minute to wake, so keep asking for a while.
  useEffect(() => {
    let stop = false;
    (async () => {
      const b = await getApi();
      if (!b) { setApiUp(false); return; }
      for (let i = 0; i < 30 && !stop; i++) {
        try {
          const r = await fetch(b + "/api/health", { cache: "no-store" });
          if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) { setApiUp(true); return; }
        } catch { /* asleep or unreachable: try again */ }
        setApiUp(false);
        await new Promise((res) => setTimeout(res, 5000));
      }
    })();
    return () => { stop = true; };
  }, []);

  // Keep the URL shareable.
  useEffect(() => {
    if (!target) return;
    const q = new URLSearchParams();
    if (measure) q.set("measure", "makemake");
    const keep = new URLSearchParams(location.search).get("api");
    if (target.preset) q.set("target", target.preset.slug); else { q.set("ra", target.ra.toFixed(6)); q.set("dec", target.dec.toFixed(6)); if (target.name) q.set("name", target.name); }
    q.set("fov", FOVS.find((f) => f.n === fovPix)!.label.replace("′", "")); q.set("det", String(det));
    if (keep) q.set("api", keep);
    history.replaceState(null, "", "?" + q.toString());
  }, [target, fovPix, det, measure]);

  // New target or field of view: reset and fetch the frame list.
  useEffect(() => {
    if (!target) return;
    const id = ++loadId.current;
    setFrames({}); setCounts({}); setGaia([]); setError(null); setIdx(0); setPinned(null); setPoint(null); setLamRef(null); setPlaying(false);
    manRef.current = null; refsRef.current = [];
    (async () => {
      try {
        if (usePack) {
          setStatus("Loading saved images…");
          const man = await packManifest(target.preset!.slug);
          if (id !== loadId.current) return;
          manRef.current = man; setGaia(man.gaia ?? []);
          setCounts(Object.fromEntries(Object.entries(man.detectors).map(([k, v]) => [Number(k), v.in_archive])));
        } else {
          if (!(await getApi())) throw new Error("no server is connected to this site at the moment");
          setStatus("Asking the NASA/IPAC archive which images cover this spot…");
          let r: { frames: FrameRef[] };
          for (let attempt = 0; ; attempt++) {
            try { r = await liveFrames(target.ra, target.dec); break; }
            catch (e) {
              if (id !== loadId.current) return;
              // A network-level failure means the host is asleep; an HTTP error with a message is a real answer.
              if (!(e instanceof TypeError) || attempt >= 15 || !(await getApi())) throw e;
              setStatus("Waking the live archive link. This can take about a minute…");
              await new Promise((res) => setTimeout(res, 6000));
            }
          }
          if (id !== loadId.current) return;
          refsRef.current = r.frames;
          const c: Record<number, number> = {};
          for (const f of r.frames) c[f.det] = (c[f.det] ?? 0) + 1;
          setCounts(c);
          if (!r.frames.length) setError("SPHEREx has no public images covering that position yet.");
          liveGaia(target.ra, target.dec, (fovPix * PIX) / 3600 * 0.75).then((g) => id === loadId.current && setGaia(g.stars)).catch(() => {});
        }
        setStatus("");
      } catch (e) {
        if (id !== loadId.current) return;
        setStatus("");
        setError(usePack ? String((e as Error).message) : `The live archive link is not available right now (${(e as Error).message}). The five preset targets still work at the 6′ field of view.`);
      }
    })();
  }, [target, fovPix, usePack]);

  // Load the frames of the selected detector when needed.
  const haveList = Object.keys(counts).length > 0;
  useEffect(() => {
    if (!target || !haveList || frames[det]) return;
    const id = loadId.current, ctl = new AbortController();
    (async () => {
      try {
        if (usePack && manRef.current) {
          setStatus(`Loading detector ${det}…`);
          const fs = await packDetector(target.preset!.slug, det, manRef.current);
          if (id === loadId.current) setFrames((p) => ({ ...p, [det]: fs }));
        } else {
          const sel = choose(refsRef.current.filter((f) => f.det === det), CAP);
          const got: Frame[] = []; let next = 0, failed = 0;
          const worker = async () => {
            while (next < sel.length && id === loadId.current) {
              const ref = sel[next++];
              try { got.push(await liveCutout(ref, target.ra, target.dec, fovPix, ctl.signal)); } catch { failed++; }
              if (id !== loadId.current) return;
              setStatus(`Reading images from the archive: ${got.length} of ${sel.length}${failed ? ` (${failed} failed)` : ""}`);
              setFrames((p) => ({ ...p, [det]: [...got].sort((a, b) => a.meta.mjd - b.meta.mjd) }));
            }
          };
          await Promise.all(Array.from({ length: 6 }, worker));
          if (id === loadId.current && !got.length && sel.length) setError("None of the images for this detector could be read.");
        }
        if (id === loadId.current) setStatus("");
      } catch (e) { if (id === loadId.current) { setStatus(""); setError(String((e as Error).message)); } }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, fovPix, det, haveList, usePack]);

  const curFrames = frames[det] ?? [];
  const lamRange = useMemo(() => curFrames.length ? [Math.min(...curFrames.map((f) => f.meta.lam)), Math.max(...curFrames.map((f) => f.meta.lam))] : null, [curFrames]);
  const lamSel = lamRef !== null && lamRange && lamRef >= lamRange[0] && lamRef <= lamRange[1] ? lamRef : curFrames.length ? curFrames[Math.floor(curFrames.length / 2)].meta.lam : null;
  const passIds = useMemo(() => [...new Set(curFrames.map((f) => f.meta.pass))].sort((a, b) => a - b), [curFrames]);

  const items: Item[] = useMemo(() => {
    if (!curFrames.length) return [];
    if (mode === "frames") {
      const list = sameColour && lamSel !== null ? curFrames.filter((f) => Math.abs(Math.log(f.meta.lam / lamSel)) < gate(det)) : curFrames;
      return list.map((f) => ({ image: f.image, mask: f.mask, frame: f, frames: [f], mjd: f.meta.mjd, label: `${f.meta.date.slice(0, 10)} · pass ${f.meta.pass + 1} · ${f.meta.lam.toFixed(3)} µm` }));
    }
    const stacks = passIds.map((p) => {
      const passFrames = curFrames.filter((f) => f.meta.pass === p);
      const mjds = passFrames.map((f) => f.meta.mjd).sort((a, b) => a - b);
      return { image: medianStack(passFrames), mask: null, frame: null, frames: passFrames, mjd: mjds[mjds.length >> 1], label: `Pass ${p + 1}: ${fmtDate(mjds[0])} to ${fmtDate(mjds[mjds.length - 1])} · ${passFrames.length} image${passFrames.length === 1 ? "" : "s"} added` };
    });
    if (mode === "passes") return stacks;
    const [a, b] = [Math.min(diffAB[0], stacks.length - 1), Math.min(diffAB[1], stacks.length - 1)];
    if (stacks.length < 2 || a === b) return [];
    const diffImage = new Float32Array(stacks[a].image.length);
    for (let i = 0; i < diffImage.length; i++) diffImage[i] = stacks[b].image[i] - stacks[a].image[i];
    return [{ image: diffImage, mask: null, frame: null, frames: [...stacks[a].frames, ...stacks[b].frames], mjd: stacks[b].mjd, label: `Pass ${passIds[b] + 1} minus pass ${passIds[a] + 1} (orange = brighter later, blue = fainter later)` }];
  }, [curFrames, mode, sameColour, lamSel, det, passIds, diffAB]);

  const i = items.length ? Math.min(idx, items.length - 1) : 0;
  const item = items[i] ?? null;
  useEffect(() => {
    if (!playing || items.length < 2) return;
    const t = setInterval(() => setIdx((k) => (k + 1) % items.length), 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, items.length]);

  // Where is the marked spot at a given date?
  const track = target?.preset?.track ?? null;
  const spotAt = useCallback((mjd: number): [number, number] => {
    if (point) return [point.ra, point.dec];
    if (track) return propagate(track.ra, track.dec, track.pm[0], track.pm[1], track.epoch, mjdToYear(mjd));
    return [target!.ra, target!.dec];
  }, [point, track, target]);

  const markers: Marker[] = useMemo(() => {
    if (!target || !item) return [];
    const out: Marker[] = [];
    const year = mjdToYear(item.mjd);
    if (showGaia) for (const star of gaia.filter((g) => g.g !== null && g.g < 17).slice(0, 150)) {
      if (star.ra === null || star.dec === null) continue;
      const [ra, dec] = propagate(star.ra, star.dec, star.pmra ?? 0, star.pmdec ?? 0, 2016.0, year);
      const [col, row] = skyToPix(ra, dec, target.ra, target.dec, fovPix);
      out.push({ col: col, row: row, kind: "gaia" });
    }
    if (track) {
      const [ra, dec] = propagate(track.ra, track.dec, track.pm[0], track.pm[1], track.epoch, year);
      const [col, row] = skyToPix(ra, dec, target.ra, target.dec, fovPix);
      out.push({ col: col, row: row, kind: "track", label: "predicted" });
    }
    out.push({ col: (fovPix - 1) / 2, row: (fovPix - 1) / 2, kind: "entered" });
    if (point) { const [col, row] = skyToPix(point.ra, point.dec, target.ra, target.dec, fovPix); out.push({ col: col, row: row, kind: "point" }); }
    return out;
  }, [target, item, gaia, showGaia, track, point, fovPix]);

  const spotPix = useCallback((mjd: number): [number, number] => { const [ra, dec] = spotAt(mjd); return skyToPix(ra, dec, target!.ra, target!.dec, fovPix); }, [spotAt, target, fovPix]);

  const spectrum: SpecPoint[] = useMemo(() => {
    if (!target) return [];
    const points: SpecPoint[] = [];
    for (const detFrames of Object.values(frames)) for (const frame of detFrames) {
      const [col, row] = spotPix(frame.meta.mjd);
      const phot = aperture(frame, col, row);
      const blocking = CLASS.bad | CLASS.saturated | CLASS.transient | CLASS.persistence | CLASS.artifact;
      points.push({ lam: lamAt(frame.meta, col, row), flux: phot.flux, err: phot.err, pass: frame.meta.pass, ok: phot.ok && !(phot.flags & blocking), sat: !!(phot.flags & CLASS.saturated), date: frame.meta.date, det: frame.meta.det });
    }
    return points;
  }, [frames, spotPix, target]);

  const verdict = useMemo(() => {
    if (mode !== "frames" || !item?.frame || !pinned || pinned === item.frame || pinned.meta.n !== item.frame.meta.n) return null;
    const [col, row] = spotPix(item.frame.meta.mjd);
    const [col0, row0] = spotPix(pinned.meta.mjd);
    // Compare at the spot's position in each frame (it may have moved between them).
    const shifted = Math.hypot(col - col0, row - row0);
    return { v: compare(pinned, item.frame, col, row), shifted };
  }, [mode, item, pinned, spotPix]);

  const imgStats = item ? stats(item.image) : null;
  const low = imgStats ? (mode === "diff" ? 0 : imgStats.med - 2 * imgStats.sig) : 0;
  const high = imgStats ? (mode === "diff" ? contrast * imgStats.sig : imgStats.med + contrast * imgStats.sig) : 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = query.trim();
    if (!text) return;
    setError(null);
    const preset = PRESETS.find((x) => x.slug === text.toLowerCase() || x.name.toLowerCase() === text.toLowerCase());
    setMeasure(false);
    if (preset) return setTarget({ ra: preset.ra, dec: preset.dec, name: preset.name, preset: preset });
    const match = text.match(/^([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)$/);
    if (match && Number(match[1]) >= 0 && Number(match[1]) < 360 && Math.abs(Number(match[2])) <= 90) return setTarget({ ra: Number(match[1]), dec: Number(match[2]), name: null, preset: null });
    try {
      setStatus("Looking that up…");
      if (!(await getApi())) throw new Error("looking up names needs the live server, which is not connected at the moment");
      const found = await resolveName(text);
      setTarget({ ra: found.ra, dec: found.dec, name: found.name, preset: null });
    } catch (err) { setError(`Could not read "${text}" as coordinates or find it by name (${(err as Error).message}). Try decimal degrees, such as 133.795 -7.245.`); }
    finally { setStatus(""); }
  }

  const curFrame = item?.frame ?? null;
  const flagsHere = useMemo(() => {
    if (!curFrame) return [];
    const [col, row] = spotPix(curFrame.meta.mjd); const phot = aperture(curFrame, col, row);
    return Object.entries(CLASS).filter(([k, bit]) => phot.flags & bit && CLASS_LABEL[k]).map(([k]) => CLASS_LABEL[k]);
  }, [curFrame, spotPix]);
  const loadedN = curFrames.length, total = counts[det] ?? 0;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>Six Months Apart</h1>
          <p>Type any spot in the sky. Watch NASA’s SPHEREx telescope see it again and again, and find out what really changed.</p>
        </div>
        <form onSubmit={submit} className="search">
          <label htmlFor="q">Name or coordinates (RA Dec)</label>
          <div className="row">
            <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. 08h55m10.83s -07d14m42.5s   or   133.795 -7.245" autoComplete="off" />
            <select value={fovPix} onChange={(e) => setFovPix(Number(e.target.value))} aria-label="Field of view">
              {FOVS.map((x) => <option key={x.n} value={x.n}>{x.label} wide</option>)}
            </select>
            <button type="submit">Show</button>
          </div>
          <div className="chips" role="group" aria-label="NASA's test targets">
            {PRESETS.map((p) => <button type="button" key={p.slug} className={!measure && target?.preset?.slug === p.slug ? "on" : ""} onClick={() => { setQuery(""); setMeasure(false); setTarget({ ra: p.ra, dec: p.dec, name: p.name, preset: p }); }}>{p.name}</button>)}
            <button type="button" className={`special ${measure ? "on" : ""}`} onClick={() => setMeasure(true)}>Measure a world ✦</button>
          </div>
          {apiUp === false && <p className="hint">Search at new coordinates and the wider fields are offline right now. The five NASA targets and Measure a world work from saved images.</p>}
        </form>
      </header>

      <nav className="start" aria-label="Start here">
        <a href="?target=barnard&det=5" className="startcard">
          <img src="img/start-motion.jpg" alt="" />
          <span><b>1 · Watch a star move</b>Barnard’s Star is the fastest-moving star in our sky. Press Play and see it creep north in a year of SPHEREx images.</span>
        </a>
        <a href="?target=wise0855&det=6" className="startcard">
          <img src="img/start-browndwarf.jpg" alt="" />
          <span><b>2 · Find a hidden neighbour</b>The coldest known brown dwarf has drifted away from where NASA’s coordinates point. The yellow ring shows where it is now.</span>
        </a>
        <a href="?measure=makemake" className="startcard">
          <img src="img/start-measure.jpg" alt="" />
          <span><b>3 · Measure a world yourself</b>Click one moving dot three times and get the distance to the dwarf planet Makemake, then check it against NASA JPL.</span>
        </a>
      </nav>
      <details className="howto">
        <summary>New here? How to read the picture</summary>
        <ul>
          <li>Every small square is one real SPHEREx pixel, about 6 arcseconds of sky. North is up.</li>
          <li><i className="k ring" /> A yellow ring marks where a moving target should be on that date.</li>
          <li><i className="k gaia" /> Blue circles are stars from the Gaia catalogue. They should not move.</li>
          <li><i className="k cross" /> The orange cross is the exact position that was asked for.</li>
          <li>Press <b>Play</b> to step through SPHEREx’s visits, about six months apart. Click any dot to see its colours in the Spectrum box.</li>
          <li>SPHEREx takes each picture in a different infrared colour, so brightness flickers even when nothing happened. “Why did it change?” sorts real changes from camera effects.</li>
        </ul>
      </details>

      {measure && <Measure slug="makemake" onExit={() => setMeasure(false)} />}
      {!measure && target && (
        <p className="where">
          <strong>{target.name ?? "Your coordinates"}</strong> · {sexa(target.ra, target.dec)} · {target!.ra.toFixed(5)}°, {target!.dec.toFixed(5)}°
          {target.preset && <span className="blurb"> — {target.preset.blurb}</span>}
          {target.preset?.slug === "wise0855" && <span className="blurb"> An unrelated background star now lies inside the yellow ring, and SPHEREx’s 6″ pixels blend the two. In D1 to D4 the dot in the ring is that star; in D5 and D6 the spot is two to four times brighter than such a star should be, which is the brown dwarf’s own light. Open D4 and D6 and read the Spectrum card: here the dots beyond 4.4 µm sit higher than the dots near 3 µm, the reverse of an ordinary star.</span>}
          <span className={`live ${apiUp ? "up" : ""}`}>{usePack ? "saved images" : "live archive"}{apiUp === false && !usePack ? " (offline)" : ""}</span>
        </p>
      )}
      {!measure && error && <p className="error" role="alert">{error}</p>}

      {!measure && <main>
        <section className="stage">
          <div className="tabs" role="tablist" aria-label="Detector (colour range)">
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <button key={d} role="tab" aria-selected={det === d} className={det === d ? "on" : ""} disabled={haveList && !counts[d]} onClick={() => { setDet(d); setIdx(0); setPinned(null); setLamRef(null); }}>
                <b>D{d}</b><span>{BANDS[d]} µm</span>
              </button>
            ))}
          </div>
          <Viewer image={item?.image ?? null} mask={item?.mask ?? null} n={fovPix} lo={low} hi={high} asinh={asinh} diverging={mode === "diff"} showFlags={showFlags} markers={markers}
            onPick={(c, r) => { const [ra, dec] = pixToSky(c, r, target!.ra, target!.dec, fovPix); setPoint({ ra, dec }); }} />
          <p className="caption" aria-live="polite">{status || item?.label || (haveList && !loadedN ? "No images in this detector." : " ")}</p>

          <div className="controls">
            <div className="seg" role="group" aria-label="What to show">
              <button className={mode === "frames" ? "on" : ""} onClick={() => { setMode("frames"); setIdx(0); }}>Single images</button>
              <button className={mode === "passes" ? "on" : ""} onClick={() => { setMode("passes"); setIdx(0); }}>Added per pass</button>
              <button className={mode === "diff" ? "on" : ""} onClick={() => { setMode("diff"); setIdx(0); setPlaying(false); }} disabled={passIds.length < 2}>Difference</button>
            </div>
            <div className="transport">
              <button onClick={() => setIdx((k) => (k - 1 + items.length) % Math.max(items.length, 1))} disabled={items.length < 2} aria-label="Previous image">◀</button>
              <button className="play" onClick={() => setPlaying((p) => !p)} disabled={items.length < 2}>{playing ? "Pause" : "Play"}</button>
              <button onClick={() => setIdx((k) => (k + 1) % Math.max(items.length, 1))} disabled={items.length < 2} aria-label="Next image">▶</button>
              <span className="count">{items.length ? `${i + 1} / ${items.length}` : "–"}</span>
              <label>speed <input type="range" min={1} max={6} step={1} value={fps} onChange={(e) => setFps(Number(e.target.value))} /> {fps}/s</label>
            </div>
            {mode === "frames" && lamRange && (
              <div className="colour">
                <label><input type="checkbox" checked={sameColour} onChange={(e) => { setSameColour(e.target.checked); setIdx(0); }} /> Only images of the same colour</label>
                {sameColour && <label className="grow">colour <input type="range" min={lamRange[0]} max={lamRange[1]} step={(lamRange[1] - lamRange[0]) / 200 || 0.001} value={lamSel ?? lamRange[0]} onChange={(e) => { setLamRef(Number(e.target.value)); setIdx(0); }} /> {lamSel?.toFixed(3)} µm</label>}
              </div>
            )}
            {mode === "diff" && passIds.length >= 2 && (
              <div className="colour">
                <label>earlier <select value={diffAB[0]} onChange={(e) => setDiffAB([Number(e.target.value), diffAB[1]])}>{passIds.map((p, k) => <option key={p} value={k}>pass {p + 1}</option>)}</select></label>
                <label>later <select value={Math.min(diffAB[1], passIds.length - 1)} onChange={(e) => setDiffAB([diffAB[0], Number(e.target.value)])}>{passIds.map((p, k) => <option key={p} value={k}>pass {p + 1}</option>)}</select></label>
              </div>
            )}
            <div className="colour">
              <label className="grow">contrast <input type="range" min={3} max={80} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} /></label>
              <label><input type="checkbox" checked={asinh} onChange={(e) => setAsinh(e.target.checked)} /> boost faint</label>
              <label title="Gaia DR3 stars brighter than magnitude 17, moved to the date of each image"><input type="checkbox" checked={showGaia} onChange={(e) => setShowGaia(e.target.checked)} /> Gaia stars</label>
              <label><input type="checkbox" checked={showFlags} onChange={(e) => setShowFlags(e.target.checked)} disabled={mode !== "frames"} /> flags</label>
            </div>
          </div>
          <p className="hint">Showing {loadedN} of {total} images in this detector{total > loadedN && loadedN > 0 ? ", spread evenly across passes" : ""}. Click the image to mark a spot.
            {point && <> <button className="link" onClick={() => setPoint(null)}>Back to the {track ? "predicted position" : "centre"}</button></>}</p>
        </section>

        <aside>
          <section className="card">
            <h2>This image</h2>
            {curFrame ? (
              <dl>
                <dt>Taken</dt><dd>{curFrame.meta.date.slice(0, 16).replace("T", " ")} UTC · pass {curFrame.meta.pass + 1}</dd>
                <dt>Colour</dt><dd>{curFrame.meta.lam.toFixed(3)} µm (band {curFrame.meta.bw.toFixed(3)} µm wide) · detector {curFrame.meta.det}</dd>
                <dt>Release</dt><dd>{curFrame.meta.release.toUpperCase()}{curFrame.meta.finast !== 0 ? " · pointing solution flagged as poor" : ""}</dd>
                <dt>Flags at the spot</dt><dd>{flagsHere.length ? flagsHere.join("; ") : "none that block a measurement"}</dd>
              </dl>
            ) : item ? <p>{mode === "passes" ? "Every image of this pass in this detector, added together (median). Adding images of different colours hides colour changes but makes faint and moving things easier to see." : "The later pass minus the earlier pass. Stars rarely cancel perfectly, because each image is a slightly different colour."}</p> : <p className="hint">Waiting for images…</p>}
            {mode === "frames" && curFrame && (
              <div className="pin">
                <button onClick={() => setPinned(curFrame)} disabled={pinned === curFrame}>{pinned === curFrame ? "Pinned as the reference" : "Pin as the reference image"}</button>
                {pinned && pinned !== curFrame && <span>Reference: {pinned.meta.date.slice(0, 10)}, {pinned.meta.lam.toFixed(3)} µm</span>}
              </div>
            )}
          </section>

          <section className="card why">
            <h2>Why did it change?</h2>
            {verdict ? (
              <>
                <p className={`verdict ${verdict.v.kind}`}>{verdict.v.text}</p>
                {verdict.shifted > 0.3 && <p className="hint">The marked spot itself is predicted to have moved {(verdict.shifted * PIX).toFixed(1)}″ ({verdict.shifted.toFixed(1)} pixels) between these two images.</p>}
              </>
            ) : <p className="hint">Pin one image as the reference, then step to another. The tool checks colour, flags and noise at the marked spot before it calls a change real.</p>}
            <ul className="four">
              <li><b>The camera changed</b> different colour, or a flagged pixel</li>
              <li><b>It moved</b> a nearby star or a solar-system body</li>
              <li><b>It changed</b> same place, same colour, new brightness</li>
              <li><b>Cannot tell</b> the honest answer more often than not</li>
            </ul>
          </section>

          <section className="card">
            <h2>The same spot from other telescopes</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              <a href={`http://byw.tools/wiseview#ra=${target!.ra.toFixed(5)}&dec=${target!.dec.toFixed(5)}&size=${Math.round(fovPix * PIX)}&band=3`} target="_blank" rel="noreferrer">WiseView</a> (NASA WISE, 2010 onward). It opens in a new tab on another site.
            </p>
          </section>

          <section className="card">
            <h2>Spectrum at the marked spot</h2>
            <Spectrum points={spectrum} current={curFrame ? curFrame.meta.lam : null} />
            <p className="hint">Brightness in a 2-pixel-radius circle, measured in every loaded image, coloured by pass. Quick-look values with no aperture correction. Open more detector tabs to extend the range.
              {passIds.length > 0 && <span className="legend"> {passIds.map((p) => <i key={p} style={{ background: PASS_COLOURS[p % PASS_COLOURS.length] }} />)}</span>}</p>
          </section>
        </aside>
      </main>}

      <footer>
        <p>Images: NASA SPHEREx Level 2 spectral images from the NASA/IPAC Infrared Science Archive (IRSA), read live or saved from the public release. Star positions: ESA Gaia DR3. This is an independent NASA Space Apps Challenge 2026 project and is not endorsed by NASA.</p>
        <p><a href="Six-Months-Apart.pptx">A seven-slide overview of this project (PowerPoint)</a></p>        
        <p>
          Open source (MIT). I developed, integrated, and personally tested this project.
          AI tools provided limited code snippets and implementation suggestions,
          primarily assisting with debugging and troubleshooting, plus numerical
          cross-checks. All application testing was performed by me.
          See <a href="https://github.com/psmoon-py/spherex/blob/main/AI_USAGE.md" target="_blank" rel="noreferrer">AI_USAGE.md</a> for details.
        </p>
      </footer>
    </div>
  );
}