// Replay benchmark for the code map: real asks from this folder's Claude chats, each checked for
// whether the files that chat went on to edit come back in the map's top 8, against a grep-style
// baseline over the same files. Read-only: the map is built in a temporary CROSSTALK_HOME.
//
//   npm run bench:map -- <folder> [--max 300]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMap } from "../src/codemap/index";
import { words } from "../src/codemap/search";
import { readAsksFrom } from "../src/core/record";
import { claudeProjectFolder } from "../src/core/paths";

const STOPISH = new Set(["the", "and", "for", "with", "this", "that", "here", "there", "what", "how", "lets", "let", "please", "make", "sure", "fix", "can", "also", "like", "way", "now", "all", "any", "some", "thing", "things", "want", "need"]);

function clean(ask: string): string {
  return ask
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[\+\d+ characters\]/g, " ")
    .slice(0, 600);
}

async function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const maxArg = process.argv.indexOf("--max");
  const max = maxArg > 0 ? Number(process.argv[maxArg + 1]) : 300;
  if (!process.env.CROSSTALK_HOME) process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-bench-"));

  const map = new CodeMap(root);
  const t0 = Date.now();
  const stats = await map.refresh({ full: true, yieldEvery: 1e9 });
  console.log(`map: ${stats.files} files, ${stats.decls} declarations, ${(stats.bytes ?? 0) / 1e6} MB, ${Date.now() - t0} ms`);

  // Every mappable file's words, for the grep baseline.
  const contents = new Map<string, string>();
  for (const f of map.entries()) {
    try {
      contents.set(f.p, fs.readFileSync(path.join(root, f.p), "utf8").toLowerCase());
    } catch {
      // Gone since the build.
    }
  }

  const dir = claudeProjectFolder(root);
  const transcripts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)) : [];
  interface Case {
    ask: string;
    edited: string[];
    before: string[];
  }
  const cases: Case[] = [];
  for (const t of transcripts) {
    let asks;
    try {
      asks = readAsksFrom("claude", t, 0, 0, { now: Date.now() + 1e9 }).asks;
    } catch {
      continue;
    }
    const before: string[] = [];
    for (const a of asks) {
      const edited = a.files
        .map((f) => path.relative(root, f).split(path.sep).join("/"))
        .filter((f) => !f.startsWith("..") && map.file(f));
      if (edited.length && clean(a.ask).trim().length > 15) cases.push({ ask: clean(a.ask), edited, before: [...before] });
      before.push(...edited);
    }
  }
  if (!cases.length) {
    console.log(`No Claude chats with edits found for ${root}.`);
    return;
  }
  const sample = cases.slice(-max);

  const topFiles = (hits: { doc: { file: { p: string } } }[], n: number) => {
    const out: string[] = [];
    for (const h of hits) {
      if (!out.includes(h.doc.file.p)) out.push(h.doc.file.p);
      if (out.length >= n) break;
    }
    return out;
  };

  const grepTop = (ask: string, n: number): string[] => {
    const ws = [...new Set(words(ask).filter((w) => w.length > 2 && !STOPISH.has(w)))];
    if (!ws.length) return [];
    const scored: [string, number][] = [];
    for (const [p, text] of contents) {
      let s = 0;
      for (const w of ws) if (text.includes(w)) s++;
      if (s) scored.push([p, s + (ws.some((w) => p.toLowerCase().includes(w)) ? 0.5 : 0)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, n).map(([p]) => p);
  };

  let mapHit = 0;
  let focusHit = 0;
  let grepHit = 0;
  let named = 0;
  let namedMap = 0;
  let namedGrep = 0;
  let mapTokens = 0;
  let mapMs = 0;
  for (const c of sample) {
    const t = Date.now();
    const hits = map.findHits(c.ask);
    mapMs += Date.now() - t;
    mapTokens += Math.ceil(map.find(c.ask).length / 4);
    const content = words(c.ask).filter((w) => w.length > 2 && !STOPISH.has(w)).length;
    const mapOk = topFiles(hits, 8).some((f) => c.edited.includes(f));
    const grepOk = grepTop(c.ask, 8).some((f) => c.edited.includes(f));
    if (content >= 4) {
      named++;
      if (mapOk) namedMap++;
      if (grepOk) namedGrep++;
    }
    if (mapOk) mapHit++;
    else if (process.env.BENCH_SHOW && Math.random() < 0.15) {
      console.log(`\nMISS ask: ${c.ask.replace(/\s+/g, " ").slice(0, 220)}\n  edited: ${c.edited.slice(0, 4).join(", ")}\n  map:    ${topFiles(hits, 5).join(", ")}`);
    }
    if (topFiles(map.findHits(c.ask, { focus: c.before.slice(-20) }), 8).some((f) => c.edited.includes(f))) focusHit++;
    if (grepOk) grepHit++;
  }
  const pct = (n: number, of = sample.length) => `${((100 * n) / Math.max(1, of)).toFixed(0)}%`;
  console.log(`asks replayed: ${sample.length} (from ${transcripts.length} chats)`);
  console.log(`an edited file in the top 8:`);
  console.log(`  grep-style baseline        ${pct(grepHit)}`);
  console.log(`  code map                   ${pct(mapHit)}`);
  console.log(`  code map + this chat's log ${pct(focusHit)}`);
  console.log(`  asks with at least 4 content words (${named}): grep ${pct(namedGrep, named)}, map ${pct(namedMap, named)}`);
  console.log(`map answer: ${(mapTokens / sample.length).toFixed(0)} tokens on average, ${(mapMs / sample.length).toFixed(1)} ms`);
  agentSearches(map, root, transcripts);
}

/**
 * The agent's own searches: before each edit, did any search the agent ran find the edited file?
 * Compares the map's answer to the same query with what grep actually returned in the chat.
 */
function agentSearches(map: CodeMap, root: string, transcripts: string[]) {
  let edits = 0;
  let grepFound = 0;
  let mapFound = 0;
  let either = 0;
  let grepChars = 0;
  let mapChars = 0;
  let searches = 0;
  const GREP = /(?:^|[|;&]\s*|\s)(?:grep|rg)\s+(?:-[\w-]+(?:\s+\d+)?\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/;
  for (const t of transcripts) {
    let lines: string[];
    try {
      lines = fs.readFileSync(t, "utf8").split("\n");
    } catch {
      continue;
    }
    const pending = new Map<string, string>(); // tool_use id → query
    let asked: { q: string; result: string; map: string[] }[] = [];
    const done = new Set<string>();
    for (const line of lines) {
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const content = o?.message?.content;
      if (o.type === "user" && typeof content === "string") {
        asked = [];
        done.clear();
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "text" && o.type === "user" && !content.some((x: any) => x?.type === "tool_result")) {
          asked = [];
          done.clear();
        }
        if (b?.type === "tool_use") {
          const inp = b.input ?? {};
          let q: string | undefined;
          if (b.name === "Grep") q = inp.pattern;
          else if (b.name === "Bash" && typeof inp.command === "string") {
            const m = GREP.exec(inp.command);
            q = m ? m[1] ?? m[2] ?? m[3] : undefined;
          }
          if (q && q.length > 2) pending.set(b.id, q);
          if ((b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit") && typeof inp.file_path === "string") {
            const rel = path.relative(root, inp.file_path).split(path.sep).join("/");
            if (rel.startsWith("..") || !map.file(rel) || done.has(rel) || !asked.length) continue;
            done.add(rel);
            edits++;
            const g = asked.some((a) => a.result.includes(rel));
            const mp = asked.some((a) => a.map.includes(rel));
            if (g) grepFound++;
            if (mp) mapFound++;
            if (g || mp) either++;
          }
        }
        if (b?.type === "tool_result" && pending.has(b.tool_use_id)) {
          const q = pending.get(b.tool_use_id)!;
          pending.delete(b.tool_use_id);
          const result = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x?.text ?? "").join("\n");
          const hits = map.findHits(q.replace(/\\[bswd]|[\\^$()[\]{}+?*|]/g, " "));
          const files: string[] = [];
          for (const h of hits) {
            if (!files.includes(h.doc.file.p)) files.push(h.doc.file.p);
            if (files.length >= 8) break;
          }
          asked.push({ q, result, map: files });
          searches++;
          grepChars += result.length;
          mapChars += map.find(q.replace(/\\[bswd]|[\\^$()[\]{}+?*|]/g, " ")).length;
        }
      }
    }
  }
  if (!edits) return;
  const pct = (n: number) => `${((100 * n) / edits).toFixed(0)}%`;
  console.log(`\nthe agent's own searches before an edit (${edits} edits, ${searches} searches):`);
  console.log(`  grep found the edited file      ${pct(grepFound)}`);
  console.log(`  map found it (same query)       ${pct(mapFound)}`);
  console.log(`  either                          ${pct(either)}`);
  console.log(`  tokens per search: grep ${(grepChars / 4 / searches).toFixed(0)}, map ${(mapChars / 4 / searches).toFixed(0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
