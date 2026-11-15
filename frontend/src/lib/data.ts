// Data access: prebuilt packs (static files) for preset targets, live API for any coordinates.
import { Frame, parseBlob } from "./sky";
import presetsJson from "../../../presets.json";

export type Track = { ra: number; dec: number; epoch: number; pm: [number, number]; plx?: number; source: string };
export type Preset = { slug: string; name: string; ra: number; dec: number; blurb: string; track: Track | null };
export const PRESETS = (presetsJson as { targets: Preset[] }).targets;
export type GaiaStar = { id: string; ra: number; dec: number; pmra: number | null; pmdec: number | null; plx: number | null; g: number | null };
export type FrameRef = { uri: string; mjd: number; det: number; release: string; pass: number };
export const FOVS: { label: string; n: number }[] = [{ label: "3′", n: 29 }, { label: "6′", n: 59 }, { label: "12′", n: 117 }, { label: "30′", n: 293 }];
export const PACK_N = 59;
export const CAP = 48;

let apiBase: string | null = null;
export async function getApi(): Promise<string> {
  if (apiBase !== null) return apiBase;
  const q = new URLSearchParams(location.search).get("api");
  if (q) return (apiBase = q.replace(/\/$/, ""));
  try {
    const c = await (await fetch("./config.json", { cache: "no-cache" })).json();
    apiBase = String(c.api || "").replace(/\/$/, "");
  } catch { apiBase = ""; }
  return apiBase;
}
async function api<T>(path: string): Promise<T> {
  const r = await fetch((await getApi()) + path);
  if (!r.ok) {
    let d = r.statusText;
    try { d = (await r.json()).detail || d; } catch { /* keep status text */ }
    throw new Error(d);
  }
  return r.json();
}

export const resolveName = (q: string) => api<{ ra: number; dec: number; name: string | null; via: string }>(`/api/resolve?q=${encodeURIComponent(q)}`);
export const liveFrames = (ra: number, dec: number) => api<{ frames: FrameRef[] }>(`/api/frames?ra=${ra}&dec=${dec}`);
export const liveGaia = (ra: number, dec: number, radius: number) => api<{ stars: GaiaStar[] }>(`/api/gaia?ra=${ra}&dec=${dec}&radius=${radius.toFixed(4)}`);

/** Up to `cap` frames of one detector: passes share the budget, evenly spread in time. */
export function choose(frames: FrameRef[], cap = CAP): FrameRef[] {
  const by = new Map<number, FrameRef[]>();
  for (const f of frames) (by.get(f.pass) ?? by.set(f.pass, []).get(f.pass)!).push(f);
  const per = Math.max(Math.floor(cap / Math.max(by.size, 1)), 1);
  const out: FrameRef[] = [];
  for (const fs of by.values()) {
    if (fs.length <= per) { out.push(...fs); continue; }
    const idx = new Set<number>();
    for (let i = 0; i < per; i++) idx.add(Math.round((i * (fs.length - 1)) / Math.max(per - 1, 1)));
    for (const i of idx) out.push(fs[i]);
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

export async function liveCutout(ref: FrameRef, ra: number, dec: number, n: number, signal?: AbortSignal): Promise<Frame> {
  const r = await fetch(`${await getApi()}/api/cutout?uri=${encodeURIComponent(ref.uri)}&ra=${ra}&dec=${dec}&n=${n}`, { signal });
  if (!r.ok) throw new Error(`cutout failed (${r.status})`);
  const f = parseBlob(await r.arrayBuffer());
  f.meta.pass = ref.pass;
  return f;
}

export type Manifest = {
  target: Preset; n: number; built: string; total_frames_in_archive: number; gaia: GaiaStar[];
  detectors: Record<string, { in_archive: number; frames: { offset: number; length: number; mjd: number; lam: number; pass: number }[] }>;
};
export async function packManifest(slug: string): Promise<Manifest> {
  const r = await fetch(`./packs/${slug}/manifest.json`);
  if (!r.ok) throw new Error("This preset's saved images are missing.");
  return r.json();
}
export async function packDetector(slug: string, det: number, man: Manifest): Promise<Frame[]> {
  const r = await fetch(`./packs/${slug}/D${det}.bin`);
  if (!r.ok) throw new Error("Saved images for this detector are missing.");
  const buf = await r.arrayBuffer();
  return man.detectors[String(det)].frames.map((x) => { const f = parseBlob(buf, x.offset); f.meta.pass = x.pass; return f; });
}
