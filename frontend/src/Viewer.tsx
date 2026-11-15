// Canvas image view with an SVG overlay (markers, compass, scale bar).
import { useEffect, useRef } from "react";
import { CLASS, PIX } from "./lib/sky";

export type Marker = { col: number; row: number; kind: "gaia" | "track" | "entered" | "point"; label?: string };
type Props = {
  image: Float32Array | null; mask: Uint8Array | null; n: number; lo: number; hi: number; asinh: boolean;
  diverging: boolean; showFlags: boolean; markers: Marker[]; onPick: (col: number, row: number) => void;
};

const FLAG_RGB: [number, [number, number, number]][] = [
  [CLASS.bad, [200, 40, 40]], [CLASS.saturated, [255, 140, 0]], [CLASS.transient, [250, 220, 60]],
  [CLASS.persistence, [170, 90, 255]], [CLASS.artifact, [255, 70, 200]], [CLASS.other, [120, 200, 200]],
];

export function Viewer({ image, mask, n, lo, hi, asinh, diverging, showFlags, markers, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = n; canvas.height = n;
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(n, n), d = imgData.data;
    const range = hi - lo || 1, a = asinh ? Math.asinh(10) : 1;
    for (let i = 0; i < n * n; i++) {
      const v = image ? image[i] : NaN;
      let r: number, g: number, b: number;
      if (!Number.isFinite(v)) { r = 38; g = 30; b = 52; } // missing data: never looks like sky
      else if (diverging) {
        const t = Math.max(-1, Math.min(1, v / (hi || 1)));
        if (t >= 0) { r = 20 + 235 * t; g = 20 + 150 * t; b = 24; } else { r = 20; g = 20 + 130 * -t; b = 24 + 231 * -t; }
      } else {
        let t = Math.max(0, Math.min(1, (v - lo) / range));
        if (asinh) t = Math.asinh(10 * t) / a;
        r = g = b = 255 * t;
      }
      if (showFlags && mask) for (const [bit, c] of FLAG_RGB) if (mask[i] & bit) { r = 0.45 * r + 0.55 * c[0]; g = 0.45 * g + 0.55 * c[1]; b = 0.45 * b + 0.55 * c[2]; break; }
      d[4 * i] = r; d[4 * i + 1] = g; d[4 * i + 2] = b; d[4 * i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }, [image, mask, n, lo, hi, asinh, diverging, showFlags]);

  const arcmin = 60 / PIX; // pixels per arcminute
  const sw = Math.max(n / 220, 0.12);
  return (
    <div className="viewer">
      <canvas ref={canvasRef} aria-label="SPHEREx image of the selected sky position, north up, east left" />
      <svg viewBox={`0 0 ${n} ${n}`} onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onPick(((e.clientX - r.left) / r.width) * n - 0.5, ((e.clientY - r.top) / r.height) * n - 0.5);
      }}>
        {markers.map((m, i) => {
          const x = m.col + 0.5, y = m.row + 0.5;
          if (x < 0 || y < 0 || x > n || y > n) return null;
          if (m.kind === "gaia") return <circle key={i} cx={x} cy={y} r={1.25} className="mk-gaia" strokeWidth={sw * 0.8} />;
          if (m.kind === "track") return <g key={i}><circle cx={x} cy={y} r={3} className="mk-track" strokeWidth={sw * 1.4} />{m.label && <text x={x > n * 0.7 ? x - 3.6 : x + 3.6} y={y - 3.4} textAnchor={x > n * 0.7 ? "end" : "start"} className="mk-text" fontSize={Math.max(n / 30, 1.6)}>{m.label}</text>}</g>;
          if (m.kind === "entered") return <path key={i} d={`M${x - 2.4} ${y}H${x - 0.9}M${x + 0.9} ${y}H${x + 2.4}M${x} ${y - 2.4}V${y - 0.9}M${x} ${y + 0.9}V${y + 2.4}`} className="mk-entered" strokeWidth={sw} />;
          return <circle key={i} cx={x} cy={y} r={2} className="mk-point" strokeWidth={sw * 1.4} />;
        })}
        <g className="furniture" strokeWidth={sw} fontSize={Math.max(n / 28, 1.7)}>
          <path d={`M${n * 0.04} ${n * 0.95}h${arcmin}`} />
          <text x={n * 0.04} y={n * 0.93}>1′</text>
          <path d={`M${n * 0.93} ${n * 0.12}V${n * 0.05}M${n * 0.93} ${n * 0.12}H${n * 0.86}`} />
          <text x={n * 0.92} y={n * 0.04}>N</text>
          <text x={n * 0.815} y={n * 0.135}>E</text>
        </g>
      </svg>
    </div>
  );
}
