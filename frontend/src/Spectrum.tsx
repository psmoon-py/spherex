// Spectrum built on the fly: aperture flux against wavelength for one sky spot.
export type SpecPoint = { lam: number; flux: number; err: number; pass: number; ok: boolean; sat?: boolean; date: string; det: number };
export const PASS_COLOURS = ["#5ab0ff", "#ffb347", "#7ee081", "#ff7b9c", "#c9a0ff", "#f2e85c", "#6fe0d6", "#ff9d6f"];

export function Spectrum({ points, current }: { points: SpecPoint[]; current: number | null }) {
  const W = 640, H = 250, L = 58, R = 12, T = 12, B = 36;
  const good = points.filter((p) => p.ok && Number.isFinite(p.flux));
  if (good.length < 2) {
    const sat = points.filter((p) => p.sat).length;
    if (points.length >= 2 && sat >= points.length / 2)
      return <p className="hint"><strong>Too bright for SPHEREx here.</strong> The core of this source is flagged as saturated in {sat} of {points.length} loaded images, so its brightness cannot be trusted and is not plotted. Click a fainter star nearby to see a spectrum.</p>;
    return <p className="hint">Not enough clean measurements at this spot yet. Load more detectors, or click a star.</p>;
  }
  const ys = good.map((p) => p.flux).sort((a, b) => a - b);
  const q = (f: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(f * (ys.length - 1))))];
  let y0 = Math.min(0, q(0.02)), y1 = q(0.98);
  const pad = 0.12 * (y1 - y0 || 1); y1 += pad; y0 -= y0 < 0 ? pad : 0;
  const X = (l: number) => L + ((l - 0.7) / (5.1 - 0.7)) * (W - L - R);
  const Y = (v: number) => T + (1 - (Math.max(y0, Math.min(y1, v)) - y0) / (y1 - y0)) * (H - T - B);
  const unit = y1 > 20000 ? { k: 1000, name: "mJy" } : { k: 1, name: "µJy" };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => y0 + f * (y1 - y0));
  const passes = [...new Set(good.map((p) => p.pass))].sort((a, b) => a - b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spectrum" role="img" aria-label="Brightness against wavelength at the marked spot">
      {[1, 2, 3, 4, 5].map((l) => <g key={l}><line x1={X(l)} x2={X(l)} y1={T} y2={H - B} className="grid" /><text x={X(l)} y={H - B + 15} textAnchor="middle">{l}</text></g>)}
      {ticks.map((t, i) => <g key={i}><line x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} className="grid" /><text x={L - 6} y={Y(t) + 4} textAnchor="end">{(t / unit.k).toFixed(Math.abs(y1 / unit.k) < 20 ? 1 : 0)}</text></g>)}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle">wavelength (µm)</text>
      <text transform={`translate(13 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">brightness ({unit.name})</text>
      {current !== null && <line x1={X(current)} x2={X(current)} y1={T} y2={H - B} className="cursor" />}
      {good.map((p, i) => (
        <g key={i} stroke={PASS_COLOURS[p.pass % PASS_COLOURS.length]} fill={PASS_COLOURS[p.pass % PASS_COLOURS.length]}>
          <line x1={X(p.lam)} x2={X(p.lam)} y1={Y(p.flux - p.err)} y2={Y(p.flux + p.err)} strokeWidth={1} opacity={0.6} />
          <circle cx={X(p.lam)} cy={Y(p.flux)} r={2.4} stroke="none"><title>{`${p.date.slice(0, 10)}  D${p.det}  ${p.lam.toFixed(3)} µm  ${p.flux.toFixed(0)} ± ${p.err.toFixed(0)} µJy`}</title></circle>
        </g>
      ))}
      {passes.map((p, i) => <g key={p} transform={`translate(${L + 8 + i * 74} ${T + 10})`}><circle r={4} fill={PASS_COLOURS[p % PASS_COLOURS.length]} /><text x={8} y={4}>pass {p + 1}</text></g>)}
    </svg>
  );
}
