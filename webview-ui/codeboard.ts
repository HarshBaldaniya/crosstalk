// The Code board's engine: where everything sits, how it is drawn, and what is under the pointer.
// Each part of the project is a small galaxy: its files on a sunflower spiral, the most imported at the
// centre. Parts of one folder pull together into a soft cloud; parts that import each other pull
// gently closer. Parts can be dragged and stay where they are put. Drawn on a canvas, so a project of
// thousands of files still pans and zooms smoothly.
import { forceCollide, forceLink, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import type { CodeMapView } from "../src/core/protocol";

export interface Dot {
  i: number;
  p: string;
  name: string;
  part: Sys;
  importers: number;
  dx: number;
  dy: number;
  r: number;
}
export interface Sys extends SimulationNodeDatum {
  id: string;
  label: string;
  folder: string;
  files: Dot[];
  count: number;
  R: number;
}
export interface Model {
  systems: Sys[];
  byId: Map<string, Sys>;
  dots: Dot[];
  dotByPath: Map<string, Dot>;
  folders: { id: string; label: string; parts: Sys[] }[];
  edges: { a: Sys; b: Sys; w: number }[];
  /** Per file: what it imports and what imports it (indices into dots) */
  out: number[][];
  inn: number[][];
  sim: Simulation<Sys, undefined>;
}
export interface Cam {
  x: number;
  y: number;
  k: number;
}
export type Target = { kind: "part"; id: string } | { kind: "file"; i: number };
export interface Theme {
  fg: string;
  bg: string;
  uses: string;
  usedby: string;
  focus: string;
}

const SPACING = 7.4;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const groupOf = (id: string) => (id === "." ? "." : id.split("/")[0]);
const folderLabel = (g: string) => (g === "." ? "top level" : g);

/** `shape` is the board's height over its width: a tall phone gets a tall map, a wide screen a wide one. */
export function buildModel(data: CodeMapView, pins: Record<string, [number, number]>, shape = 1): Model {
  const pullX = Math.min(0.26, Math.max(0.03, 0.08 * shape));
  const pullY = Math.min(0.26, Math.max(0.03, 0.08 / shape));
  const groups = new Map<string, string[]>();
  for (const m of data.modules) {
    const g = groupOf(m.id);
    groups.set(g, [...(groups.get(g) ?? []), m.id]);
  }
  // Short names: the folder's group already says where a part lives, so a part shows only its own
  // last folder ("navigation", not "components/custom/shared/navigation"), or two when that clashes.
  const shortName = (id: string, depth: number) => id.split("/").slice(-depth).join("/");
  const systems: Sys[] = data.modules.map((m) => {
    const g = groupOf(m.id);
    const siblings = groups.get(g) ?? [];
    let label = m.id === "." ? "top level" : siblings.length <= 1 || m.id === g ? folderLabel(g) : shortName(m.id, 1);
    if (m.id !== g && siblings.length > 1 && siblings.filter((x) => x !== g && shortName(x, 1) === label).length > 1) label = shortName(m.id, 2);
    return { id: m.id, label, folder: g, files: [], count: m.files, R: 0 };
  });
  const byId = new Map(systems.map((s) => [s.id, s]));
  const dots: Dot[] = data.allFiles.map((f, i) => ({ i, p: f.p, name: f.p.split("/").pop() ?? f.p, part: byId.get(f.m)!, importers: f.importers, dx: 0, dy: 0, r: 1.6 + Math.min(1.9, Math.sqrt(f.importers) * 0.42) }));
  for (const d of dots) d.part?.files.push(d);
  for (const s of systems) {
    // The sunflower: most imported first, so the busiest files sit at the heart of the part.
    s.files.sort((a, b) => b.importers - a.importers || a.p.localeCompare(b.p));
    s.files.forEach((d, n) => {
      const rad = SPACING * Math.sqrt(n);
      d.dx = Math.cos(n * GOLDEN) * rad;
      d.dy = Math.sin(n * GOLDEN) * rad;
    });
    s.R = Math.max(16, SPACING * Math.sqrt(Math.max(s.files.length, s.count)) + 10);
  }
  const out: number[][] = dots.map(() => []);
  const inn: number[][] = dots.map(() => []);
  for (const [a, b] of data.links) {
    out[a]?.push(b);
    inn[b]?.push(a);
  }

  const edges = data.edges.map((e) => ({ a: byId.get(e.from)!, b: byId.get(e.to)!, w: e.weight })).filter((e) => e.a && e.b);
  const folderIds = [...groups.keys()];

  // 1. Place the folders: each a circle big enough for its parts, pulled towards the folders it
  //    imports from or is imported by, never overlapping. Folders start on a spiral, so the same
  //    project settles the same way every time.
  type F = SimulationNodeDatum & { id: string; r: number };
  const fnodes: F[] = folderIds.map((g, i) => {
    const area = systems.filter((s) => s.folder === g).reduce((n, s) => n + (s.R + 10) ** 2, 0);
    return { id: g, r: Math.sqrt(area) * 1.4 + 30, x: Math.cos(i * GOLDEN) * 40 * Math.sqrt(i + 1), y: Math.sin(i * GOLDEN) * 40 * Math.sqrt(i + 1) };
  });
  const fw = new Map<string, number>();
  for (const e of edges) {
    if (e.a.folder === e.b.folder) continue;
    const key = [e.a.folder, e.b.folder].sort().join("\u0000");
    fw.set(key, (fw.get(key) ?? 0) + e.w);
  }
  const maxW = Math.max(1, ...fw.values());
  const flinks = [...fw.entries()].map(([key, w]) => {
    const [source, target] = key.split("\u0000");
    return { source, target, w };
  });
  const fsim = forceSimulation<F>(fnodes)
    .force("link", forceLink<F, { source: string | F; target: string | F; w: number }>(flinks).id((n) => n.id).distance(0).strength((l) => 0.04 + 0.2 * Math.sqrt(l.w / maxW)))
    .force("collide", forceCollide<F>((n) => n.r + 110).iterations(4))
    .force("x", forceX<F>(0).strength(pullX))
    .force("y", forceY<F>(0).strength(pullY))
    .stop();
  for (let i = 0; i < 400; i++) fsim.tick();
  const centre = new Map(fnodes.map((f) => [f.id, { x: f.x ?? 0, y: f.y ?? 0 }]));

  // 2. Settle each folder's parts around its centre, biggest in the middle. The same forces keep
  //    running while a part is dragged, so its neighbours make room and the folder stays together.
  const order = new Map<string, number>();
  for (const g of folderIds) systems.filter((x) => x.folder === g).sort((a, b) => b.R - a.R).forEach((x, n) => order.set(x.id, n));
  for (const sy of systems) {
    const c = centre.get(sy.folder)!;
    const n = order.get(sy.id) ?? 0;
    const pin = pins[sy.id];
    sy.x = pin ? pin[0] : c.x + Math.cos(n * GOLDEN) * 40 * Math.sqrt(n);
    sy.y = pin ? pin[1] : c.y + Math.sin(n * GOLDEN) * 40 * Math.sqrt(n);
    if (pin) {
      sy.fx = pin[0];
      sy.fy = pin[1];
    }
  }
  const sim = forceSimulation<Sys>(systems)
    .force("x", forceX<Sys>((n) => centre.get(n.folder)!.x).strength(0.06))
    .force("y", forceY<Sys>((n) => centre.get(n.folder)!.y).strength(0.06))
    // Room between parts for their names and for the wires to pass.
    .force("collide", forceCollide<Sys>((n) => n.R + 30).iterations(4))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  sim.alpha(0);

  const folders = folderIds.map((g) => ({ id: g, label: folderLabel(g), parts: systems.filter((s) => s.folder === g) }));
  return { systems, byId, dots, dotByPath: new Map(dots.map((d) => [d.p, d])), folders, edges, out, inn, sim };
}

/** Each folder's middle and the edge of its cloud: where its joints sit. */
export function folderGeo(m: Model): Map<string, { x: number; y: number; r: number }> {
  const out = new Map<string, { x: number; y: number; r: number }>();
  for (const f of m.folders) {
    if (!f.parts.length) continue;
    const x = f.parts.reduce((n, p) => n + (p.x ?? 0), 0) / f.parts.length;
    const y = f.parts.reduce((n, p) => n + (p.y ?? 0), 0) / f.parts.length;
    const r = Math.max(...f.parts.map((p) => Math.hypot((p.x ?? 0) - x, (p.y ?? 0) - y) + p.R)) + 20;
    out.set(f.id, { x, y, r });
  }
  return out;
}

export const dotX = (d: Dot) => (d.part.x ?? 0) + d.dx;
export const dotY = (d: Dot) => (d.part.y ?? 0) + d.dy;

export function bounds(m: Model): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of m.systems) {
    x0 = Math.min(x0, (s.x ?? 0) - s.R);
    y0 = Math.min(y0, (s.y ?? 0) - s.R);
    x1 = Math.max(x1, (s.x ?? 0) + s.R);
    y1 = Math.max(y1, (s.y ?? 0) + s.R);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -100, y0: -100, x1: 100, y1: 100 };
}

/** The camera that shows the whole project with room around it. */
export function fitCam(m: Model, w: number, h: number, top = 0): Cam {
  const b = bounds(m);
  // Room for the labels under the parts and above the folders, and for whatever floats on top.
  const pad = 44;
  const k = Math.min(2, Math.max(0.08, Math.min((w - pad * 2) / Math.max(1, b.x1 - b.x0), (h - top - pad * 2) / Math.max(1, b.y1 - b.y0 + 30))));
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - top / 2 / k, k };
}

/** What is under a point, in world units: a file first (they are on top), then a part. */
export function hitTest(m: Model, x: number, y: number, k: number): Target | undefined {
  let best: Dot | undefined;
  let bestD = Infinity;
  const reach = 7 / k;
  for (const d of m.dots) {
    const dd = Math.hypot(dotX(d) - x, dotY(d) - y);
    if (dd <= Math.max(d.r + 1, reach) && dd < bestD) {
      best = d;
      bestD = dd;
    }
  }
  // Far out, the dots are too small to aim at: the part is what is meant.
  if (best && k >= 0.9) return { kind: "file", i: best.i };
  let sys: Sys | undefined;
  let sysD = Infinity;
  for (const s of m.systems) {
    const dd = Math.hypot((s.x ?? 0) - x, (s.y ?? 0) - y);
    if (dd <= s.R + 8 / k && dd < sysD) {
      sys = s;
      sysD = dd;
    }
  }
  return sys ? { kind: "part", id: sys.id } : undefined;
}

/** What lights up for the part or file in focus. */
export interface Lit {
  part?: Sys;
  file?: Dot;
  usesParts: Map<Sys, number>;
  usedByParts: Map<Sys, number>;
  usesFiles: Set<number>;
  usedByFiles: Set<number>;
}
export function litFor(m: Model, t: Target | undefined): Lit | undefined {
  if (!t) return undefined;
  const lit: Lit = { usesParts: new Map(), usedByParts: new Map(), usesFiles: new Set(), usedByFiles: new Set() };
  if (t.kind === "part") {
    const s = m.byId.get(t.id);
    if (!s) return undefined;
    lit.part = s;
    for (const e of m.edges) {
      if (e.a === s && e.b !== s) lit.usesParts.set(e.b, e.w);
      if (e.b === s && e.a !== s) lit.usedByParts.set(e.a, e.w);
    }
  } else {
    const d = m.dots[t.i];
    if (!d) return undefined;
    lit.file = d;
    for (const j of m.out[d.i] ?? []) lit.usesFiles.add(j);
    for (const j of m.inn[d.i] ?? []) lit.usedByFiles.add(j);
  }
  return lit;
}

interface DrawState {
  w: number;
  h: number;
  dpr: number;
  cam: Cam;
  theme: Theme;
  lit?: Lit;
  /** 0..1: how far the board has dimmed towards the focus */
  fade: number;
  hover?: Target;
  selected?: Target;
  pulse?: { i: number; t: number };
  now: number;
  /** No motion: the person asked their system for less */
  still?: boolean;
  /** Files a search found */
  found?: Set<number>;
}

const sameTarget = (a?: Target, b?: Target) => !!a && !!b && a.kind === b.kind && (a.kind === "part" ? a.id === (b as { id: string }).id : a.i === (b as { i: number }).i);

export function draw(ctx: CanvasRenderingContext2D, m: Model, s: DrawState): void {
  const { w, h, dpr, cam, theme, lit, fade } = s;
  const k = cam.k;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  // The board: a dot grid that moves with the camera, like the Tower.
  let gap = 24 * k;
  while (gap < 12) gap *= 2;
  const ox = (w / 2 - cam.x * k) % gap;
  const oy = (h / 2 - cam.y * k) % gap;
  ctx.fillStyle = theme.fg;
  ctx.globalAlpha = 0.17;
  for (let x = ox; x < w; x += gap) for (let y = oy; y < h; y += gap) ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);

  const sx = (x: number) => w / 2 + (x - cam.x) * k;
  const sy = (y: number) => h / 2 + (y - cam.y) * k;
  const dim = (on: boolean) => (on ? 1 : 1 - 0.78 * fade);
  const partOn = (p: Sys) => !lit || (lit.part ? p === lit.part || lit.usesParts.has(p) || lit.usedByParts.has(p) : p === lit.file?.part);

  // Folder clouds: one fill of all its parts' circles, so overlaps don't darken.
  for (const f of m.folders) {
    if (f.parts.length < 2) continue;
    ctx.beginPath();
    for (const p of f.parts) {
      ctx.moveTo(sx(p.x ?? 0) + (p.R + 20) * k, sy(p.y ?? 0));
      ctx.arc(sx(p.x ?? 0), sy(p.y ?? 0), (p.R + 20) * k, 0, Math.PI * 2);
    }
    ctx.fillStyle = theme.fg;
    ctx.globalAlpha = 0.045 * dim(f.parts.some(partOn));
    ctx.fill();
  }

  // Wires, bundled: every wire between two folders is one smooth curve pulled towards the same two
  // points on the folders' edges, so wires going the same way run together and part again near their
  // ends, with no knots or corners. Wires inside a folder go straight across. In focus, the wires of
  // the part or file light up and flow the way the import goes: blue to what it uses, orange from
  // what uses it.
  const geo = folderGeo(m);
  const gate = (a: string, b: string) => {
    const A = geo.get(a)!;
    const B = geo.get(b)!;
    const l = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    return { x: A.x + ((B.x - A.x) / l) * A.r, y: A.y + ((B.y - A.y) / l) * A.r };
  };
  // A point on a part's ring, facing somewhere.
  const rim = (p: Sys, tx: number, ty: number) => {
    const l = Math.hypot(tx - (p.x ?? 0), ty - (p.y ?? 0)) || 1;
    return { x: (p.x ?? 0) + ((tx - (p.x ?? 0)) / l) * p.R, y: (p.y ?? 0) + ((ty - (p.y ?? 0)) / l) * p.R };
  };
  /** One wire, in world points. `off` places it across its bundle, in screen pixels, so wires that
   *  travel together lie side by side like a ribbon instead of on top of each other. */
  const route = (a: { x: number; y: number }, fa: string, b: { x: number; y: number }, fb: string, off = 0) => {
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sy(a.y));
    if (fa === fb) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const bend = l * 0.12;
      ctx.quadraticCurveTo(sx((a.x + b.x) / 2 - (dy / l) * bend), sy((a.y + b.y) / 2 + (dx / l) * bend), sx(b.x), sy(b.y));
      return;
    }
    const g1 = gate(fa, fb);
    const g2 = gate(fb, fa);
    const l = Math.hypot(g2.x - g1.x, g2.y - g1.y) || 1;
    const nx = (-(g2.y - g1.y) / l) * off;
    const ny = ((g2.x - g1.x) / l) * off;
    ctx.bezierCurveTo(sx(g1.x) + nx, sy(g1.y) + ny, sx(g2.x) + nx, sy(g2.y) + ny, sx(b.x), sy(b.y));
  };
  /** Each wire's place in its bundle: wires between the same two folders, ordered across the bundle by
   *  where they start, so neighbours stay neighbours and the ribbon never twists. */
  const ribbon = <T>(items: T[], ends: (t: T) => readonly [{ x: number; y: number }, string, { x: number; y: number }, string]) => {
    const groups = new Map<string, { t: T; key: number }[]>();
    for (const t of items) {
      const [a, fa, b, fb] = ends(t);
      if (fa === fb) continue;
      // One direction per pair of folders, so wires both ways share one ribbon.
      const flip = fa > fb;
      const [p, f1, f2] = flip ? [b, fb, fa] : [a, fa, fb];
      const g1 = gate(f1, f2);
      const g2 = gate(f2, f1);
      const l = Math.hypot(g2.x - g1.x, g2.y - g1.y) || 1;
      const key = (p.x - g1.x) * (-(g2.y - g1.y) / l) + (p.y - g1.y) * ((g2.x - g1.x) / l);
      const id = `${f1}\u0000${f2}`;
      groups.set(id, [...(groups.get(id) ?? []), { t, key: flip ? -key : key }]);
    }
    const out = new Map<T, number>();
    for (const g of groups.values()) {
      g.sort((x, y) => x.key - y.key);
      const gap = Math.min(2.6, 30 / g.length);
      g.forEach((x, n) => out.set(x.t, (n - (g.length - 1) / 2) * gap));
    }
    return out;
  };
  const ends = (a: Sys, b: Sys) => {
    // Each end leaves its ring facing where the wire is headed first.
    const ta = a.folder === b.folder ? { x: b.x ?? 0, y: b.y ?? 0 } : gate(a.folder, b.folder);
    const tb = a.folder === b.folder ? { x: a.x ?? 0, y: a.y ?? 0 } : gate(b.folder, a.folder);
    return [rim(a, ta.x, ta.y), rim(b, tb.x, tb.y)] as const;
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // At rest: every wire, faint, so the bundles show by themselves.
  const rest = 1 - 0.8 * fade;
  ctx.strokeStyle = theme.fg;
  // The more wires, the fainter each one at rest, so a big project reads as a few soft bundles.
  const quiet = Math.min(1, Math.sqrt(120 / Math.max(1, m.edges.length)));
  const edgeEnds = new Map(m.edges.map((e) => [e, ends(e.a, e.b)] as const));
  const place = ribbon(m.edges, (e) => {
    const [a, b] = edgeEnds.get(e)!;
    return [a, e.a.folder, b, e.b.folder] as const;
  });
  for (const e of m.edges) {
    const [a, b] = edgeEnds.get(e)!;
    route(a, e.a.folder, b, e.b.folder, place.get(e) ?? 0);
    ctx.globalAlpha = (e.a.folder === e.b.folder ? 0.07 : 0.1) * quiet * rest;
    ctx.lineWidth = Math.min(2.6, 0.8 + Math.log2(1 + e.w) * 0.4);
    ctx.stroke();
  }

  // In focus: each wire whole, a soft line with light flowing along it.
  const flow = (color: string) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.setLineDash([5, 9]);
    ctx.lineDashOffset = s.still ? 0 : -((s.now / 45) % 14);
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (lit?.part) {
    const P = lit.part;
    for (const e of m.edges) {
      if (e.a !== P && e.b !== P) continue;
      const [a, b] = edgeEnds.get(e)!;
      route(a, e.a.folder, b, e.b.folder, place.get(e) ?? 0);
      flow(e.a === P ? theme.uses : theme.usedby);
    }
  } else if (lit?.file) {
    const f = lit.file;
    const wires = [
      ...[...lit.usesFiles].map((j) => ({ a: f, b: m.dots[j], color: theme.uses })),
      ...[...lit.usedByFiles].map((j) => ({ a: m.dots[j], b: f, color: theme.usedby })),
    ].filter((x) => x.a && x.b);
    const at = (d: Dot) => ({ x: dotX(d), y: dotY(d) });
    const filePlace = ribbon(wires, (x) => [at(x.a), x.a.part.folder, at(x.b), x.b.part.folder] as const);
    for (const x of wires) {
      route(at(x.a), x.a.part.folder, at(x.b), x.b.part.folder, filePlace.get(x) ?? 0);
      flow(x.color);
    }
  }

  // Parts: a ring around each galaxy.
  for (const p of m.systems) {
    const x = sx(p.x ?? 0);
    const y = sy(p.y ?? 0);
    const r = p.R * k;
    if (x + r < -40 || x - r > w + 40 || y + r < -40 || y - r > h + 40) continue;
    const isSel = s.selected?.kind === "part" && s.selected.id === p.id;
    const isHover = s.hover?.kind === "part" && s.hover.id === p.id;
    const tint = lit?.usesParts.has(p) ? theme.uses : lit?.usedByParts.has(p) ? theme.usedby : undefined;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = (tint ? 0.12 : 0.045) * dim(partOn(p));
    ctx.fillStyle = tint ?? theme.fg;
    ctx.fill();
    ctx.globalAlpha = (isSel || isHover ? 0.95 : tint ? 0.85 : 0.2) * dim(partOn(p));
    ctx.strokeStyle = isSel ? theme.focus : tint ?? theme.fg;
    ctx.lineWidth = isSel ? 2 : isHover || tint ? 1.5 : 1;
    if (isSel) {
      ctx.shadowColor = theme.focus;
      ctx.shadowBlur = 14;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Files: the stars. Brighter when more of the code imports them.
  for (const d of m.dots) {
    const x = sx(dotX(d));
    const y = sy(dotY(d));
    if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
    const r = Math.max(0.7, d.r * k);
    let color = theme.fg;
    let on = partOn(d.part);
    if (s.found && !lit) {
      // A search glows where its files are; everything else steps back.
      const hit = s.found.has(d.i);
      ctx.beginPath();
      ctx.arc(x, y, hit ? Math.max(r, 3) : r, 0, Math.PI * 2);
      ctx.fillStyle = hit ? theme.focus : theme.fg;
      ctx.globalAlpha = hit ? 1 : 0.12;
      ctx.fill();
      if (hit) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(r, 3) + 4, 0, Math.PI * 2);
        ctx.strokeStyle = theme.focus;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      continue;
    }
    if (lit?.file) {
      on = d === lit.file || lit.usesFiles.has(d.i) || lit.usedByFiles.has(d.i);
      if (d === lit.file) color = theme.focus;
      else if (lit.usesFiles.has(d.i)) color = theme.uses;
      else if (lit.usedByFiles.has(d.i)) color = theme.usedby;
    }
    ctx.beginPath();
    ctx.arc(x, y, color === theme.fg ? r : Math.max(r, 2.6), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = (color === theme.fg ? 0.32 + 0.6 * Math.min(1, Math.sqrt(d.importers / 16)) : 1) * (lit?.file ? (on ? 1 : 1 - 0.85 * fade) : dim(on));
    ctx.fill();
  }

  // A file found by search pulses three times.
  if (s.pulse) {
    const d = m.dots[s.pulse.i];
    const t = (s.now - s.pulse.t) / 1000;
    if (d && t < 3) {
      const ph = t % 1;
      ctx.beginPath();
      ctx.arc(sx(dotX(d)), sy(dotY(d)), 4 + ph * 22, 0, Math.PI * 2);
      ctx.strokeStyle = theme.focus;
      ctx.globalAlpha = 1 - ph;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Labels, in screen pixels: folders, then parts, then files when zoomed in. None overlap.
  const taken: [number, number, number, number][] = [];
  const free = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 < 0 || x0 > w || y1 < 0 || y0 > h) return false;
    for (const t of taken) if (x0 < t[2] && x1 > t[0] && y0 < t[3] && y1 > t[1]) return false;
    taken.push([x0, y0, x1, y1]);
    return true;
  };
  const label = (text: string, x: number, y: number, font: string, alpha: number, color = theme.fg, align: CanvasTextAlign = "center", force = false) => {
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const x0 = align === "center" ? x - tw / 2 : x;
    if (!free(x0 - 3, y - 9, x0 + tw + 3, y + 7) && !force) return;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.globalAlpha = alpha;
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = theme.bg;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const UI = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  // The focused file's name always shows, then the rest where they fit.
  const focusDot = s.hover?.kind === "file" ? m.dots[s.hover.i] : s.selected?.kind === "file" ? m.dots[s.selected.i] : undefined;
  if (focusDot) label(focusDot.name, sx(dotX(focusDot)) + 8, sy(dotY(focusDot)), `600 12px ${UI}`, 1, theme.fg, "left", true);
  const parts = [...m.systems].sort((a, b) => b.R - a.R);
  for (const p of parts) {
    const on = partOn(p);
    const isSel = (s.selected?.kind === "part" && s.selected.id === p.id) || (s.hover?.kind === "part" && s.hover.id === p.id);
    label(p.label, sx(p.x ?? 0), sy(p.y ?? 0) + p.R * k + 13, `${isSel ? 700 : 600} 12px ${UI}`, dim(on), theme.fg, "center", isSel);
  }
  for (const f of m.folders) {
    if (f.parts.length < 2) continue;
    let top = Infinity;
    let cx = 0;
    for (const p of f.parts) {
      top = Math.min(top, (p.y ?? 0) - p.R - 20);
      cx += p.x ?? 0;
    }
    label(f.label.toUpperCase(), sx(cx / f.parts.length), sy(top) - 9, `700 11px ${UI}`, 0.6 * dim(f.parts.some(partOn)), theme.fg, "center", true);
  }
  if (k >= 1.8) {
    const files = [...m.dots].sort((a, b) => b.importers - a.importers);
    let shown = 0;
    for (const d of files) {
      if (shown > 220) break;
      const on = lit?.file ? d === lit.file || lit.usesFiles.has(d.i) || lit.usedByFiles.has(d.i) : partOn(d.part);
      const before = taken.length;
      label(d.name, sx(dotX(d)) + d.r * k + 5, sy(dotY(d)), `11px ${UI}`, 0.8 * (lit?.file ? (on ? 1 : 0.15) : dim(on)), theme.fg, "left");
      if (taken.length > before) shown++;
    }
  }
  ctx.globalAlpha = 1;
}

/** A gentle arc from one circle's edge to another's. */
function curve(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, r1: number, r2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ax = x1 + ux * r1;
  const ay = y1 + uy * r1;
  const bx = x2 - ux * r2;
  const by = y2 - uy * r2;
  const bend = Math.min(60, len * 0.12);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo((ax + bx) / 2 - uy * bend, (ay + by) / 2 + ux * bend, bx, by);
}

export { sameTarget };
