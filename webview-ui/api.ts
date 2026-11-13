import { useEffect, useSyncExternalStore } from "react";
import type { FromWebview, ModelOption, ToWebview } from "../src/core/protocol";
import type { Tool } from "../src/core/types";
import type { Status, Usage } from "../src/core/types";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): any; setState(s: any): void };

const vscode = acquireVsCodeApi();

export function send(msg: FromWebview): void {
  vscode.postMessage(msg);
}

export function onMessage(fn: (msg: ToWebview) => void): () => void {
  const handler = (e: MessageEvent<ToWebview>) => fn(e.data);
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Small UI memory (filters, collapsed groups) that survives the view being hidden. */
export function remembered<T>(key: string, fallback: T): T {
  return (vscode.getState()?.[key] as T) ?? fallback;
}

export function remember(key: string, value: unknown): void {
  vscode.setState({ ...(vscode.getState() ?? {}), [key]: value });
}

export const STATUS_LABEL: Record<Status, string> = {
  working: "Working",
  waiting: "Needs you",
  done: "Done",
  idle: "Idle",
};

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`;
}

/** "just now", "12m ago", "3d ago". */
export function agoText(ms: number, now = Date.now()): string {
  const a = ago(ms, now);
  return a === "now" ? "just now" : `${a} ago`;
}

export function tokens(n: number): string {
  const short = (v: number, unit: string) => `${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return short(n / 1000, "K");
  if (n < 1_000_000_000) return short(n / 1_000_000, "M");
  return short(n / 1_000_000_000, "B");
}

/** Every token, cache reads included. */
export function total(u?: Usage): number {
  return u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
}

/**
 * The headline count: tokens the model newly took in or wrote. Cache reads are
 * the same context re-read on every turn (billed at a tenth), so they are shown
 * on their own rather than swamping this number.
 */
export function fresh(u?: Usage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Tokens a piece of text costs, roughly (four characters a token). */
export function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** "claude-opus-5-5" → "Opus 5.5", "gemini-2.5-pro" → "Gemini 2.5 Pro"; anything else as the tool names it. */
export function modelName(model?: string): string | undefined {
  if (!model) return undefined;
  const claude = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gemini = /^gemini-([\d.]+)-(\w+)/i.exec(model);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}`;
  // Codex: gpt-5.5-codex → GPT-5.5 Codex, gpt-5.1-codex-max → GPT-5.1 Codex Max.
  const gpt = /^gpt-([\d.]+)((?:-[a-z]+)*)$/i.exec(model);
  if (gpt) return `GPT-${gpt[1]}${gpt[2].split("-").filter(Boolean).map((w) => ` ${w[0].toUpperCase()}${w.slice(1)}`).join("")}`;
  return model;
}

/** A folder's own name ("/Users/me/work/api" → "api"). */
export function folderName(p?: string): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** How full a context window is, as a whole percentage. */
export function contextPct(c?: { used: number; window: number }): number | undefined {
  return c && c.window ? Math.min(100, Math.round((c.used / c.window) * 100)) : undefined;
}

/** The drag payload type for a chat, so drops from elsewhere are ignored. */
export const DRAG_TYPE = "application/x-crosstalk-chat";


// ---- each tool's own model list, asked for once and shared by every picker ----

type ModelEntry = { models?: ModelOption[]; error?: string; asked?: boolean };
const modelStore = new Map<Tool, ModelEntry>();
const modelListeners = new Set<() => void>();
window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  if (e.data?.type !== "models") return;
  modelStore.set(e.data.tool, { models: e.data.error ? undefined : e.data.models, error: e.data.error, asked: true });
  modelListeners.forEach((f) => f());
});

/** The models a tool offers, as the tool lists them; asked for the first time a picker opens. */
export function useModels(tool: Tool, wanted: boolean): ModelEntry {
  const entry = useSyncExternalStore(
    (f) => (modelListeners.add(f), () => modelListeners.delete(f)),
    () => modelStore.get(tool) ?? EMPTY,
  );
  useEffect(() => {
    if (wanted && !modelStore.get(tool)?.asked) {
      modelStore.set(tool, { asked: true });
      modelListeners.forEach((f) => f());
      send({ type: "models", tool });
    }
  }, [wanted, tool]);
  return entry;
}
const EMPTY: ModelEntry = {};


// ---- flags from the extension that small controls need (e.g. whether Claude auto-compacts) ----

let flags = { autoCompact: true };
const flagListeners = new Set<() => void>();
export function setFlags(next: Partial<typeof flags>): void {
  const merged = { ...flags, ...next };
  if (merged.autoCompact === flags.autoCompact) return;
  flags = merged;
  flagListeners.forEach((f) => f());
}
export function useFlags(): typeof flags {
  return useSyncExternalStore((f) => (flagListeners.add(f), () => flagListeners.delete(f)), () => flags);
}

/** Where "open in its folder" puts a chat: Claude's panel for Claude, a terminal for the others. */
export function whereItOpens(tool: string): string {
  return tool === "Claude" ? "with this chat in Claude" : `with this chat in a ${tool} terminal`;
}
