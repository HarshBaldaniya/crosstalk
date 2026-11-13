// Where a chat's tokens went: finding code (searches, reads) against doing the work (edits, commands,
// writing), the biggest single reads, files read again and again, and what would have saved tokens.
// Read from the chat's own file, a slice at a time; nothing is sent anywhere.
import * as fs from "node:fs";
import type { RecordTool } from "./record";

export type Kind = "finding" | "doing" | "other";

export interface TokenReport {
  /** What the agent itself reported, summed over replies */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Context held at the last reply */
  contextNow?: number;
  replies: number;
  /** Tool output by kind, in tokens (about 4 characters each) */
  byKind: Record<Kind, number>;
  /** Per tool name, tokens and calls */
  byTool: { name: string; tokens: number; calls: number }[];
  /** Whole files read, largest first */
  bigReads: { file: string; tokens: number }[];
  /** Files read three or more times */
  rereads: { file: string; times: number; tokens: number }[];
  /** Calls to Crosstalk's map */
  mapCalls: number;
  tips: string[];
}

const SEARCH_CMD = /^\s*(cd [^&;]+(&&|;)\s*)?(grep|rg|ag|ack|find|fd|ls|tree|git (grep|ls-files))\b/;
const READ_CMD = /^\s*(cd [^&;]+(&&|;)\s*)?(cat|head|tail|sed -n|less|bat|nl|wc|git (show|log|diff|blame))\b/;
const tokensOf = (chars: number) => Math.round(chars / 4);

function kindOf(name: string, input: Record<string, unknown>): Kind {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name) || /crosstalk_map|map_find|search/i.test(name)) return "finding";
  if (name === "Bash" || name === "shell" || name === "exec_command" || name === "local_shell" || name === "run_shell_command") {
    const cmd = String((input.command as string | string[] | undefined) ?? "");
    const c = Array.isArray(input.command) ? (input.command as string[]).join(" ") : cmd;
    const real = c.replace(/^bash -lc\s+/, "").replace(/^['"]|['"]$/g, "");
    if (SEARCH_CMD.test(real) || READ_CMD.test(real)) return "finding";
    return "doing";
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|replace)$/.test(name)) return "doing";
  if (/^(read_file|read_many_files|glob|search_file_content|list_directory|grep)$/.test(name)) return "finding";
  return "other";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text ?? "") : "")).join("\n");
  return "";
}

/** Reads a chat file line by line in slices, without holding it all in memory at once. */
function eachLine(file: string, fn: (line: string) => void, maxBytes = 512 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0;
    let rest = Buffer.alloc(0);
    while (pos < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let buf = Buffer.concat([rest, chunk.subarray(0, n)]);
      let start = 0;
      for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
        fn(buf.toString("utf8", start, i));
        start = i + 1;
      }
      rest = Buffer.from(buf.subarray(start));
      buf = Buffer.alloc(0);
    }
    if (rest.length) fn(rest.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

export function tokenReport(tool: RecordTool, file: string): TokenReport {
  const r: TokenReport = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    replies: 0,
    byKind: { finding: 0, doing: 0, other: 0 },
    byTool: [],
    bigReads: [],
    rereads: [],
    mapCalls: 0,
    tips: [],
  };
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const perTool = new Map<string, { tokens: number; calls: number }>();
  const reads = new Map<string, { times: number; tokens: number; whole: number }>();
  const usage = new Map<string, { i: number; o: number; cr: number; cw: number }>();

  const addResult = (id: string | undefined, text: string) => {
    const call = id ? calls.get(id) : undefined;
    const name = call?.name ?? "?";
    const t = tokensOf(text.length);
    r.byKind[call ? kindOf(name, call.input) : "other"] += t;
    const pt = perTool.get(name) ?? { tokens: 0, calls: 0 };
    pt.tokens += t;
    pt.calls++;
    perTool.set(name, pt);
    const path = call && (call.input.file_path ?? call.input.absolute_path ?? call.input.path);
    if (call && typeof path === "string" && /^(Read|read_file)$/.test(name)) {
      const rd = reads.get(path) ?? { times: 0, tokens: 0, whole: 0 };
      rd.times++;
      rd.tokens += t;
      if (!call.input.offset && !call.input.limit) rd.whole = Math.max(rd.whole, t);
      reads.set(path, rd);
    }
  };

  eachLine(file, (line) => {
    if (!line) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (tool === "claude") {
      const m = o.message;
      if (o.type === "assistant" && m?.usage && m.id && !o.isSidechain) {
        const u = m.usage;
        usage.set(m.id, { i: u.input_tokens ?? 0, o: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0 });
        r.contextNow = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
      if (!Array.isArray(m?.content)) return;
      for (const b of m.content) {
        if (b?.type === "tool_use") {
          calls.set(b.id, { name: b.name, input: b.input ?? {} });
          if (/crosstalk_map/.test(b.name)) r.mapCalls++;
        } else if (b?.type === "tool_result") addResult(b.tool_use_id, resultText(b.content));
      }
    } else if (tool === "codex") {
      const p = o.payload ?? o;
      if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        let input: Record<string, unknown> = {};
        try {
          input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments ?? p.action ?? {});
        } catch {
          input = { command: String(p.arguments ?? "") };
        }
        calls.set(p.call_id, { name: p.name ?? "shell", input });
        if (/crosstalk_map/.test(p.name ?? "")) r.mapCalls++;
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        addResult(p.call_id, out);
      } else if (p.type === "token_count" && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        usage.set("codex", { i: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), o: u.output_tokens ?? 0, cr: u.cached_input_tokens ?? 0, cw: 0 });
        const last = p.info.last_token_usage;
        if (last) r.contextNow = (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
      }
    }
  });

  for (const u of usage.values()) {
    r.input += u.i;
    r.output += u.o;
    r.cacheRead += u.cr;
    r.cacheWrite += u.cw;
  }
  r.replies = tool === "codex" ? 0 : usage.size;
  r.byTool = [...perTool.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  r.bigReads = [...reads.entries()].filter(([, v]) => v.whole > 0).map(([file, v]) => ({ file, tokens: v.whole })).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  r.rereads = [...reads.entries()].filter(([, v]) => v.times >= 3).map(([file, v]) => ({ file, times: v.times, tokens: v.tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  r.tips = tips(r);
  return r;
}

function tips(r: TokenReport): string[] {
  const out: string[] = [];
  const total = r.byKind.finding + r.byKind.doing + r.byKind.other;
  if (!total) return out;
  const findShare = r.byKind.finding / total;
  if (findShare > 0.35) {
    out.push(
      `${Math.round(findShare * 100)}% of what tools returned was searching and reading (${fmt(r.byKind.finding)} tokens).${r.mapCalls ? "" : " crosstalk_map with find answers \"where is X\" in about 250 tokens; outline shows a file's parts so only the needed lines are read."}`,
    );
  }
  const big = r.bigReads.filter((b) => b.tokens > 4000);
  if (big.length) out.push(`${big.length} whole-file read${big.length === 1 ? "" : "s"} over 4k tokens (largest: ${short(big[0].file)}, ${fmt(big[0].tokens)}). Outline the file first, then read the lines you need.`);
  if (r.rereads.length) out.push(`${short(r.rereads[0].file)} was read ${r.rereads[0].times} times (${fmt(r.rereads[0].tokens)} tokens). Read it once, or the part that changed.`);
  if (r.contextNow && r.contextNow > 150_000) out.push(`This chat holds about ${fmt(r.contextNow)} tokens of context now. Every message pays for it: /handoff to a fresh chat keeps what matters for a fraction.`);
  return out;
}

export function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const short = (p: string) => p.split("/").slice(-2).join("/");

export function renderTokenReport(r: TokenReport, name: string): string {
  const total = r.byKind.finding + r.byKind.doing + r.byKind.other;
  const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : "0%");
  const lines = [
    `${name}: ${r.replies ? `${r.replies} replies, ` : ""}${fmt(r.output)} written, ${fmt(r.input + r.cacheRead + r.cacheWrite)} read in (${fmt(r.cacheRead)} from cache)${r.contextNow ? `; context now ${fmt(r.contextNow)}` : ""}.`,
    `Tool output: finding ${pct(r.byKind.finding)} (${fmt(r.byKind.finding)}) · doing ${pct(r.byKind.doing)} (${fmt(r.byKind.doing)}) · other ${pct(r.byKind.other)}.`,
  ];
  if (r.byTool.length) lines.push(`By tool: ${r.byTool.slice(0, 5).map((t) => `${t.name} ${fmt(t.tokens)} (${t.calls})`).join(" · ")}.`);
  if (r.bigReads.length) lines.push(`Biggest whole reads: ${r.bigReads.slice(0, 3).map((b) => `${short(b.file)} ${fmt(b.tokens)}`).join(" · ")}.`);
  if (r.tips.length) lines.push("To save tokens:", ...r.tips.map((t) => `- ${t}`));
  else lines.push("Nothing stands out: this chat spends its tokens on the work.");
  return lines.join("\n");
}
