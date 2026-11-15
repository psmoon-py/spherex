# Six Months Apart

**Type any spot in the sky. Watch NASA's SPHEREx telescope see it again and again, and find out what really changed.**

A public web tool for the NASA Space Apps Challenge 2026, challenge *Planet X and SPHEREx*.

- Live site: https://psmoon-py.github.io/spherex/
- Challenge: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/

## What it does

| NASA asked for | What the tool does |
|---|---|
| Enter coordinates, see a little video | Name or RA/Dec box; player with step, speed and blink |
| Test on five named targets | One-click buttons: Barnard's Star, WISE 0855, Epsilon Indi B, RW Aurigae, R Draconis |
| Easy to update with new releases | Asks the IRSA archive live; every public release it serves appears automatically |
| Use the 102 bands; co-add each detector | Six detector tabs; a colour slider; "Added per pass" median stacks |
| Spectra on the fly | Click any spot: brightness against wavelength from every loaded image, coloured by pass |
| Add or subtract images | "Added per pass" and "Difference" modes |
| Choose the field of view | 3, 6, 12 or 30 arcminutes |
| Overlay Gaia or WISE | Gaia DR3 stars moved to each image's date with their proper motion; one-click link opens the same spot in WiseView |
| Coordinates in the URL | `?ra=133.795&dec=-7.245&fov=6&det=6` or `?target=wise0855` |
| Show metadata and flags | Date, wavelength, release and plain-language flags per image; flag overlay |

Two additions of my own:

1. **Why did it change?** SPHEREx images of one spot differ in colour from exposure to exposure, so most
   "changes" are the camera, not the sky. The tool checks colour, flags and noise at the marked spot and
   answers with one of four readings: the camera changed, it moved, it changed, or cannot tell.
2. **Measure a world.** SPHEREx looks at each spot roughly every six months, from opposite sides of Earth's
   orbit. A dwarf planet therefore hops by degrees between passes. Three clicks on the real images of
   Makemake give its distance, which the tool then compares with NASA JPL Horizons.

## Findings from real data

All numbers below come from runs against the live archive (see `build_log.txt` on the `data` branch).

- **WISE 0855-0714.** NASA's coordinates are the brown dwarf's position around 2010. It has since moved
  about 2 arcminutes west. The tool shows empty sky at the entered position and marks the predicted one.
  An unrelated background star (Gaia DR3 5756956644387831296, G = 16.3) now lies within about a pixel of
  that position, so SPHEREx blends the two. In detectors 1 to 4 the source there is the star. In detectors
  5 and 6 the spot is brighter than the star should be: its D5/D4 and D6/D4 brightness ratios are 1.31 and
  1.85, against 0.49 to 0.70 and 0.34 to 0.53 for 16 nearby stars. The excess, about 200 µJy in D5 and
  400 µJy in D6, is consistent with the brown dwarf's published 4.5 µm brightness. An earlier version of
  this file said the source was "visible only in detectors 5 and 6"; that was wrong.
- **Barnard's Star** moves north between passes as Gaia predicts. It is saturated in all six detectors, so
  the tool reports the flags instead of a spectrum.
- **RW Aurigae and R Draconis** are also flagged as saturated in their cores in most or all images, as is
  Barnard's Star. I tested measuring them from the unsaturated outer halo instead, using Barnard's Star
  as a constant control: the control varied by up to 40% between passes, so I do not report brightness
  changes for saturated stars. The tool says "too bright" and "cannot tell" for them.
- **Makemake.** Three clicks on real images gave approximately 52.7 au, compared with approximately 52.73 au from JPL Horizons. These figures are rounded. With JPL positions fed to the same formula, twelve random image triples agreed within 0.01%.
- **Archive layout.** As of 14 Nov 2026 IRSA serves `dr1` and `qr3`; the earlier `qr2` collection is gone.

## How it works

```
browser (React)  ──>  API (FastAPI + Astropy)  ──>  IRSA TAP  (which images cover this spot?)
        │                      └──────────────────>  AWS S3 mirror of SPHEREx (byte-range reads)
        └── saved packs for the preset targets (static files built by GitHub Actions)
```

- `backend/spx/core.py` finds images (`spherex.plane`/`spherex.artifact`), reads only the needed pixels of
  each Level-2 file from the public S3 bucket, subtracts the archive's zodiacal-light model, and resamples
  to a north-up, 6.15 arcsec grid with Astropy WCS (including SIP distortion). Wavelength comes from each
  file's own `WCS-WAVE` lookup table.
- `tools/build_packs.py` runs the same code in GitHub Actions and saves the preset targets as static files,
  so the demo works with no server.
- `frontend/` draws the images, overlays, spectrum and readings.

### Methods and their limits

| Quantity | Method | Limit |
|---|---|---|
| Brightness | Aperture sum, radius 2 px, sky from a 4–7 px annulus; `F[µJy] = Σ(I − sky) · Ω_pix · 1e12` | Quick-look: no aperture correction, no deblending |
| Error | `sqrt(Σ variance)` from the archive's VARIANCE plane | Noise tails are heavier than Gaussian |
| "Same colour" | Wavelengths within half a resolution element, `|Δ ln λ| < 1/(2R)` | Sharp spectral features need a tighter gate |
| "Changed" | `|ΔF| / sqrt(σ₁² + σ₂² + (0.05·F)²) ≥ 3` | 5% allowance for calibration differences between visits and releases |
| Gaia markers | First-order proper motion from epoch 2016.0 | Parallax ignored (under 0.1 pixel) |
| Distance | Three sightings; A and C interpolated to the time of B, remaining shift is parallax | Refuses when the sideways baseline is under 0.5 au or the hop is under ten click errors |

Noise after resampling: variance is interpolated linearly, which is right for aperture sums on the
resampled grid and conservative for single pixels.

Flag bit meanings follow the SPHEREx Explanatory Supplement. If a later release changes them, edit
`FLAG_BITS` in `backend/spx/core.py`.

## Run it yourself

```bash
# API
cd backend && pip install -r requirements.txt && uvicorn app:app --port 8000
# Site (in another terminal)
cd frontend && npm install && npm run dev      # http://localhost:5173
```

The site looks for the API at the address in `frontend/public/config.json` (`{"api": "https://…"}`), or at
`?api=…` in the URL. Without an API the five preset targets and the Makemake exercise still work.

### Hosting status at submission (15 November 2026)

- The five NASA targets and the Makemake exercise run from saved images, with no server.
- Search at any other coordinates needs the API server, and it is **not hosted publicly yet**. Two things
  blocked it during the submission weekend: Hugging Face no longer hosts Docker or Gradio Spaces on free
  accounts, and the archive's query service (IRSA TAP and SIA) returned HTTP 502 from about
  20:20 UTC on 14 November through at least 13:28 UTC on 15 November.
- The server code passed its test against the real archive on 14 November before the outage
  (`tools/api_smoke.py`). `Dockerfile` and `render.yaml` are ready for any container host.

## Tests

- `python -m pytest tests` — synthetic FITS with known answers: orientation, flux conservation, wavelength
  table, flags, serialization.
- `cd frontend && npm test` — units, projections, proper motion, photometry, readings, distance formula.
- `build-packs` workflow — the same code against the real archive, with contact sheets and a log.

An additional AI-assisted numerical cross-check examined the unit conversions, the WISE 0855 and Barnard's Star motion, the Gaia propagation and the distance formula. It found that the distance formula is not accurate for geometries near opposition; SPHEREx never observes there, and the tool now refuses such cases. I personally ran the application tests and verified the tool's behaviour.

## Data and credits

- SPHEREx Level-2 spectral images: NASA/JPL-Caltech, served by the NASA/IPAC Infrared Science Archive
  (IRSA) and its AWS Open Data mirror.
- Gaia DR3: ESA/Gaia/DPAC, queried through IRSA.
- Ephemerides: NASA JPL Horizons. Name lookup: CDS Sesame.
- WISE 0855-0714 motion: Luhman & Esplin 2016 (arXiv:1605.06655), proper motion −8.118 ± 0.008 and
  +0.680 ± 0.007 arcsec/yr, parallax 0.449 ± 0.008 arcsec. Their 2010 position agrees with NASA's
  challenge coordinates to 0.5 arcsec.
- Software: Astropy, FastAPI, React, Vite, astronomy-engine.

This project is not endorsed by NASA.

## Use of AI

I directed, developed, integrated, and personally tested Six Months Apart.

AI tools were used primarily for debugging, troubleshooting, and technical assistance. They also provided a limited number of code snippets and implementation suggestions that I reviewed, adapted, and incorporated where appropriate.

OpenAI ChatGPT was additionally used for numerical cross-checks. These checks were advisory and were not substitutes for application testing or independent scientific validation.

All application testing, including checking whether the features worked correctly with real SPHEREx data, was performed by me.

For details, see [AI_USAGE.md](AI_USAGE.md).

## Licence

MIT. See [LICENSE](LICENSE).
