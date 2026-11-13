// Plan limits, as each agent itself reports them. Crosstalk never reads a login token: Claude's come
// from the person's own Claude Code (its /usage data), Codex's from the rate limits Codex writes
// into its own chat records after each reply. Gemini CLI keeps its quota to itself.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanUsage, PlanWindow } from "./types";

type Win = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type Limit = { kind?: string; percent?: number | null; resets_at?: string | null; scope?: { model?: { display_name?: string | null } | null } | null };

export interface ClaudeAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiProvider?: string;
}

export interface ClaudeUsageAnswer {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: Win;
    seven_day?: Win;
    seven_day_opus?: Win;
    seven_day_sonnet?: Win;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
    limits?: Limit[];
    extra_usage?: { is_enabled?: boolean; monthly_limit?: number | null; used_credits?: number | null; currency?: string | null } | null;
    seven_day_breakdown?: { rows?: { display_name?: string; percent?: number }[] } | null;
  } | null;
}

const time = (iso?: string | null) => (iso ? Date.parse(iso) || undefined : undefined);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Claude Code's account and /usage answer, as one plan summary. */
export function claudePlanFrom(acct: ClaudeAccount, usage: ClaudeUsageAnswer | undefined, now = Date.now()): PlanUsage {
  const sub = acct.subscriptionType ?? usage?.subscription_type ?? undefined;
  const plan = sub ? (/^claude/i.test(sub) ? sub : `Claude ${cap(sub)}`) : undefined;
  const firstParty = !acct.apiProvider || acct.apiProvider === "firstParty";
  const out: PlanUsage = {
    tool: "Claude",
    account: {
      email: acct.email,
      organization: acct.organization,
      plan,
      auth: !firstParty ? cap(acct.apiProvider!) : sub ? "Claude account" : "API key",
    },
    windows: [],
    at: now,
    source: "Claude Code",
  };
  const rl = usage?.rate_limits;
  if (!usage?.rate_limits_available || !rl) {
    out.note = firstParty && !sub ? "Plan limits apply to Claude subscriptions; this sign-in uses an API key." : "Claude Code didn't report plan limits right now.";
    return out;
  }
  const windows: PlanWindow[] = [];
  if (rl.limits?.length) {
    // The newer, complete list: every limit, the plan-wide ones and those for one model.
    for (const l of rl.limits) {
      const model = l.scope?.model?.display_name;
      const kind = l.kind ?? "";
      const label = /session|five_hour|5h/i.test(kind)
        ? "Current session (5-hour)"
        : /weekly/i.test(kind)
          ? model
            ? `Weekly ${model}`
            : "Weekly (7 day)"
          : model
            ? `${cap(kind.replace(/_/g, " "))} · ${model}`
            : cap(kind.replace(/_/g, " "));
      windows.push({ label, pct: l.percent ?? null, resetsAt: time(l.resets_at) });
    }
  } else {
    const named: [string, Win][] = [
      ["Current session (5-hour)", rl.five_hour],
      ["Weekly (7 day)", rl.seven_day],
      ["Weekly Opus", rl.seven_day_opus],
      ["Weekly Sonnet", rl.seven_day_sonnet],
    ];
    for (const [label, w] of named) if (w) windows.push({ label, pct: w.utilization ?? null, resetsAt: time(w.resets_at) });
    for (const m of rl.model_scoped ?? []) windows.push({ label: `Weekly ${m.display_name}`, pct: m.utilization, resetsAt: time(m.resets_at) });
  }
  out.windows = windows;
  if (rl.extra_usage) out.extra = { enabled: !!rl.extra_usage.is_enabled, used: rl.extra_usage.used_credits, limit: rl.extra_usage.monthly_limit, currency: rl.extra_usage.currency };
  const rows = rl.seven_day_breakdown?.rows?.filter((r) => r.display_name && (r.percent ?? 0) > 0);
  if (rows?.length) out.breakdown = rows.map((r) => ({ label: r.display_name!, pct: r.percent! }));
  return out;
}

const windowLabel = (minutes?: number) =>
  !minutes ? "Limit" : minutes === 300 ? "Current session (5-hour)" : minutes === 10080 ? "Weekly (7 day)" : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${Math.round(minutes / 60)}-hour`;

/**
 * Codex's limits from its own chat records: each reply's token_count event carries the account's
 * rate limits (primary, usually 5 hours, and secondary, usually weekly) as they stood then.
 */
export function codexPlanFrom(lines: string[], now = Date.now()): PlanUsage | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("rate_limits")) continue;
    let o: { timestamp?: string; type?: string; payload?: { type?: string; rate_limits?: Record<string, unknown> } };
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const rl = o.payload?.rate_limits as
      | { primary?: CodexWin | null; secondary?: CodexWin | null; plan_type?: string | null }
      | undefined;
    if (!rl) continue;
    const at = Date.parse(o.timestamp ?? "") || now;
    const windows: PlanWindow[] = [];
    for (const w of [rl.primary, rl.secondary]) {
      if (!w) continue;
      const resetsAt = w.resets_at ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : w.resets_in_seconds != null ? at + w.resets_in_seconds * 1000 : undefined;
      // A window that has started over since this was written is back at nothing used.
      const pct = resetsAt && resetsAt < now ? 0 : (w.used_percent ?? null);
      windows.push({ label: windowLabel(w.window_minutes), pct, resetsAt: resetsAt && resetsAt < now ? undefined : resetsAt });
    }
    if (!windows.length) continue;
    return {
      tool: "Codex",
      account: rl.plan_type ? { plan: `ChatGPT ${cap(rl.plan_type)}`, auth: "ChatGPT account" } : undefined,
      windows,
      at,
      source: "Codex's chat records",
    };
  }
  return undefined;
}

interface CodexWin {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
  resets_in_seconds?: number;
}

/** Gemini CLI: who is signed in (its accounts file holds just the address); its limits aren't shared. */
export function geminiPlan(home = process.env.CROSSTALK_GEMINI_HOME || path.join(os.homedir(), ".gemini"), now = Date.now()): PlanUsage {
  let email: string | undefined;
  try {
    email = (JSON.parse(fs.readFileSync(path.join(home, "google_accounts.json"), "utf8")) as { active?: string }).active || undefined;
  } catch {
    // Not signed in yet.
  }
  return {
    tool: "Gemini",
    account: email ? { email, auth: "Google account" } : undefined,
    windows: [],
    at: now,
    source: "Gemini CLI",
    note: email ? "Gemini CLI keeps its limits to itself. Type /stats in Gemini to see them." : "Sign in to Gemini CLI (run gemini) to use it here.",
  };
}
