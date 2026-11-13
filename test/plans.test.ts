// Plan limits, as each agent reports them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudePlanFrom, codexPlanFrom, geminiPlan } from "../src/core/plans";

const now = Date.parse("2026-11-12T12:00:00Z");

test("claude: account, every limit with its reset, where the use went, extra usage (the real answer's shape)", () => {
  const p = claudePlanFrom(
    { email: "me@example.com", organization: "My Org", subscriptionType: "Claude Ultra", apiProvider: "firstParty" },
    {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: { utilization: 45, resets_at: "2026-11-14T02:59:59.983198+00:00" },
        limits: [
          { kind: "weekly_all", percent: 45, resets_at: "2026-11-14T02:59:59.983198+00:00", scope: null },
          { kind: "weekly_scoped", percent: 0, resets_at: "2026-11-14T03:00:00+00:00", scope: { model: { display_name: "Fable" } } },
        ],
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, currency: null },
        seven_day_breakdown: { rows: [{ display_name: "Claude Code", percent: 97 }, { display_name: "Chats", percent: 3 }, { display_name: "Cowork", percent: 0 }] },
      },
    },
    now,
  );
  assert.equal(p.account?.plan, "Claude Ultra");
  assert.equal(p.account?.email, "me@example.com");
  assert.equal(p.account?.auth, "Claude account");
  assert.deepEqual(
    p.windows.map((w) => [w.label, w.pct, new Date(w.resetsAt!).toISOString()]),
    [
      ["Weekly (7 day)", 45, "2026-11-14T02:59:59.983Z"],
      ["Weekly Fable", 0, "2026-11-14T03:00:00.000Z"],
    ],
  );
  assert.deepEqual(p.breakdown, [
    { label: "Claude Code", pct: 97 },
    { label: "Chats", pct: 3 },
  ]);
  assert.deepEqual(p.extra, { enabled: false, used: null, limit: null, currency: null });
  assert.equal(p.source, "Claude Code");
});

test("claude: the older named windows are read too, and a plan name gets its brand", () => {
  const p = claudePlanFrom(
    { subscriptionType: "max" },
    { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: "2026-11-12T15:00:00Z" }, seven_day: { utilization: 60, resets_at: null }, model_scoped: [{ display_name: "Opus", utilization: 80, resets_at: null }] } },
    now,
  );
  assert.equal(p.account?.plan, "Claude Max");
  assert.deepEqual(p.windows.map((w) => [w.label, w.pct]), [
    ["Current session (5-hour)", 12],
    ["Weekly (7 day)", 60],
    ["Weekly Opus", 80],
  ]);
});

test("claude: an API key has no plan limits, and says so; no usage answer still shows the account", () => {
  const key = claudePlanFrom({ apiProvider: "firstParty" }, { rate_limits_available: false, rate_limits: null }, now);
  assert.equal(key.account?.auth, "API key");
  assert.equal(key.windows.length, 0);
  assert.match(key.note!, /API key/);
  const none = claudePlanFrom({ email: "me@example.com", subscriptionType: "pro" }, undefined, now);
  assert.equal(none.account?.plan, "Claude Pro");
  assert.match(none.note!, /didn't report/);
});

test("codex: its own records carry the 5-hour and weekly limits; a window that has reset since reads 0", () => {
  const at = "2026-11-12T11:00:00Z";
  const line = (rl: object, ts = at) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: rl } });
  const p = codexPlanFrom(
    [
      line({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 100 } }, "2026-11-12T08:00:00Z"),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } }),
      line({ primary: { used_percent: 23.5, window_minutes: 300, resets_in_seconds: 1800 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: Date.parse("2026-11-15T00:00:00Z") / 1000 }, plan_type: "plus" }),
    ],
    now,
  )!;
  assert.equal(p.tool, "Codex");
  assert.equal(p.account?.plan, "ChatGPT Plus");
  // The 5-hour window reset at 11:30, before now (12:00): nothing used in it since.
  assert.deepEqual(p.windows.map((w) => [w.label, w.pct]), [
    ["Current session (5-hour)", 0],
    ["Weekly (7 day)", 41],
  ]);
  assert.equal(new Date(p.windows[1].resetsAt!).toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(codexPlanFrom(["{}", "not json"], now), undefined);
});

test("gemini: who is signed in, and a plain note that its limits are not shared", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-gemini-plan-"));
  assert.match(geminiPlan(home, now).note!, /Sign in/);
  fs.writeFileSync(path.join(home, "google_accounts.json"), JSON.stringify({ active: "me@gmail.com", old: [] }));
  const p = geminiPlan(home, now);
  assert.equal(p.account?.email, "me@gmail.com");
  assert.match(p.note!, /\/stats/);
});
