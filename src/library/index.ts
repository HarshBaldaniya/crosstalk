// The Library: Crosstalk's own commands (review, PR, spec, tests, update ...) plus the person's own,
// served to every agent as slash commands. Each is a short Markdown file: a small header, then the
// instructions an agent follows. The person's own live in ~/.crosstalk/library/ and stay private.
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkFile } from "../core/paths";
import { editDistance, words } from "../codemap/search";
import ci from "./content/ci.md";
import design from "./content/design.md";
import docs from "./content/docs.md";
import email from "./content/email.md";
import meeting from "./content/meeting.md";
import notion from "./content/notion.md";
import pr from "./content/pr.md";
import prReview from "./content/pr-review.md";
import research from "./content/research.md";
import review from "./content/review.md";
import roadmap from "./content/roadmap.md";
import scope from "./content/scope.md";
import security from "./content/security.md";
import slack from "./content/slack.md";
import spec from "./content/spec.md";
import tests from "./content/tests.md";
import update from "./content/update.md";
import userDocs from "./content/user-docs.md";
import plan from "./content/plan.md";
import build from "./content/build.md";
import audit from "./content/audit.md";
import cleanup from "./content/cleanup.md";
import retro from "./content/retro.md";
import recall from "./content/recall.md";
import catchup from "./content/catchup.md";
import handoff from "./content/handoff.md";
import tokens from "./content/tokens.md";
import moduleDocs from "./content/module-docs.md";

export type Pack = "workflow" | "sessions" | "engineering" | "product" | "connected" | "mine";

export const PACKS: { id: Pack; title: string; blurb: string }[] = [
  // Titles are what someone wants to do that day, in their words; the list will keep growing.
  { id: "workflow", title: "Make a change", blurb: "Plan, build, audit, clean up, learn: a change from idea to done" },
  { id: "sessions", title: "Pick up past work", blurb: "Recall, catch up, hand off, and see where tokens went" },
  { id: "engineering", title: "Check and ship", blurb: "Spec, review, PR, tests, security, CI, docs" },
  { id: "product", title: "Write for your team", blurb: "Scope, updates, research, roadmap, help articles" },
  { id: "connected", title: "Email, Slack and meetings", blurb: "Drafts for email, Slack, meetings and Notion; you send" },
  { id: "mine", title: "Yours", blurb: "Commands you add in ~/.crosstalk/library; private" },
];

export interface CommandArg {
  name: string;
  description: string;
  required: boolean;
}

export interface LibraryCommand {
  name: string;
  title: string;
  pack: Pack;
  description: string;
  args: CommandArg[];
  triggers: string[];
  /** A connected app it needs (gmail, slack, granola, notion) */
  needs?: string;
  body: string;
  /** Where it came from: shipped with Crosstalk, or the person's own file */
  source: "builtin" | string;
}

const BUILTIN_TEXT = [
  plan, build, audit, cleanup, retro, moduleDocs,
  recall, catchup, handoff, tokens,
  spec, review, pr, prReview, tests, security, design, ci, docs,
  scope, update, research, roadmap, userDocs,
  email, slack, meeting, notion,
];

/** Reads one command file: a `---` header of `key: value` lines, then the instructions. */
export function parseCommand(text: string, source: LibraryCommand["source"] = "builtin"): LibraryCommand | undefined {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return undefined;
  const head: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const name = (head.name ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return undefined;
  const args: CommandArg[] = [];
  // Arguments are `name = description` separated by ";", and a description may hold ";" itself.
  for (const part of (head.args ?? "").split(/;\s*(?=[a-z][a-z0-9_]*\*?\s*=)/i)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let argName = part.slice(0, eq).trim();
    const required = argName.endsWith("*");
    argName = argName.replace(/\*$/, "").trim();
    if (/^[a-z][a-z0-9_]*$/i.test(argName)) args.push({ name: argName, description: part.slice(eq + 1).trim(), required });
  }
  const pack = (["workflow", "sessions", "engineering", "product", "connected"].includes(head.pack) ? head.pack : "mine") as Pack;
  return {
    name,
    title: head.title || name,
    pack: source === "builtin" ? pack : "mine",
    description: head.description || head.title || name,
    args,
    triggers: (head.triggers ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    needs: head.needs || undefined,
    body: m[2].trim(),
    source,
  };
}

let builtins: LibraryCommand[] | undefined;

export function builtinCommands(): LibraryCommand[] {
  return (builtins ??= BUILTIN_TEXT.map((t) => parseCommand(t)).filter((c): c is LibraryCommand => !!c));
}

export function userLibraryDir(): string {
  return crosstalkFile("library");
}

/** The line a new command starts with. A file that still says it was never written, so it is not listed. */
export const STARTER_DESCRIPTION = "One line: what it does, for whom.";

/** The person's own commands: every .md in ~/.crosstalk/library (one folder deep), except untouched starters. */
export function userCommands(): LibraryCommand[] {
  const dir = userLibraryDir();
  const out: LibraryCommand[] = [];
  const read = (d: string, depth: number) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory() && depth < 1) read(p, depth + 1);
      else if (it.isFile() && it.name.endsWith(".md")) {
        try {
          const c = parseCommand(fs.readFileSync(p, "utf8"), p);
          if (c && c.description !== STARTER_DESCRIPTION) out.push(c);
        } catch {
          // An unreadable file is left out.
        }
      }
    }
  };
  read(dir, 0);
  return out;
}

/** Every command, the person's own first: one of theirs with a shipped name replaces the shipped one. */
export function allCommands(): LibraryCommand[] {
  const mine = userCommands();
  const taken = new Set(mine.map((c) => c.name));
  return [...mine, ...builtinCommands().filter((c) => !taken.has(c.name))];
}

/** The instructions with arguments filled in; a missing one says what to assume instead. */
export function renderCommand(cmd: LibraryCommand, values: Record<string, string | undefined> = {}): string {
  return cmd.body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_m, key: string) => {
    const v = values[key]?.trim();
    if (v) return v;
    const arg = cmd.args.find((a) => a.name === key);
    if (!arg) return "";
    // "Branch, diff or PR (default: this branch against its base)" → "this branch against its base"
    const fallback = /\(default:\s*([^)]*)\)/i.exec(arg.description)?.[1]?.trim();
    return fallback ?? `(${arg.description.toLowerCase()}: not given; ask if you need it)`;
  });
}

export interface Suggestion {
  command: LibraryCommand;
  score: number;
}

/** The commands that fit an ask best: trigger phrases count most, then the title and description. */
export function suggest(ask: string, commands: LibraryCommand[] = allCommands(), n = 3): Suggestion[] {
  const q = words(ask);
  if (!q.length) return [];
  const lowerAsk = ask.toLowerCase();
  const out: Suggestion[] = [];
  for (const c of commands) {
    let score = 0;
    for (const t of c.triggers) if (lowerAsk.includes(t.toLowerCase())) score += 6;
    const fields: [string[], number][] = [
      [words(c.triggers.join(" ")), 2],
      [words(`${c.name} ${c.title}`), 2.5],
      [words(c.description), 1],
    ];
    for (const w of new Set(q)) {
      let best = 0;
      for (const [ws, weight] of fields) {
        for (const x of ws) {
          if (x === w) best = Math.max(best, weight);
          else if (w.length >= 5 && x.length >= 5 && x[0] === w[0] && editDistance(w, x, 1) <= 1) best = Math.max(best, weight * 0.7);
        }
      }
      score += best;
    }
    if (score > 0) out.push({ command: c, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}
