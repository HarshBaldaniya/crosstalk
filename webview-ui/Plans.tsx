// Plan limits, as each agent reports them: a one-line strip per agent at the foot of the sidebar,
// and full cards (account, every limit with its reset, extra usage, where the use went) on the
// Fuel page. Nothing here is worked out by Crosstalk: every number is the agent's own.
import type { ViewState } from "../src/core/protocol";
import type { PlanUsage, PlanWindow, Tool } from "../src/core/types";
import { agoText, send } from "./api";
import { Clock, I, RefreshCw, ToolMark } from "./Icons";

const ORDER: Tool[] = ["Claude", "Codex", "Gemini"];

export function planList(state: ViewState): PlanUsage[] {
  return ORDER.map((t) => state.plans?.[t]).filter((p): p is PlanUsage => !!p);
}

/** Agents with something to show: limits, or at least an account signed in. One not in use stays out of sight. */
export function shownPlans(state: ViewState): PlanUsage[] {
  return planList(state).filter((p) => p.windows.length > 0 || !!p.account?.email || !!p.account?.plan);
}

/** The limit nearest to running out: the one a person needs to watch. */
export function headline(p: PlanUsage): PlanWindow | undefined {
  return [...p.windows].filter((w) => w.pct != null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
}

export function level(pct: number | null | undefined): string {
  return pct == null ? "none" : pct >= 90 ? "full" : pct >= 70 ? "high" : "ok";
}

/** To the nearest minute: a limit that resets at 02:59:59.98 resets at 3:00, as the agent's own panel says. */
const minute = (at: number) => Math.round(at / 60_000) * 60_000;

/** "8:30 AM", always with AM or PM, whatever language the editor is in. */
const clockOf = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

/** The time zone's short name: "IST", "PST", "BST"; "GMT+5:30" only when no name is known. */
export function zoneOf(d: Date): string {
  let fallback = "";
  for (const locale of ["en-US", "en-IN", "en-GB", "en-AU"]) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
      if (name && !/^(GMT|UTC)[+-]/.test(name)) return name;
      fallback ||= name;
    } catch {
      // A locale this runtime lacks.
    }
  }
  return fallback;
}

function dayDiff(d: Date, now: number): number {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((day(d) - day(new Date(now))) / 86_400_000);
}

/** "Resets today · 7:43 PM IST", "Resets tomorrow · 9:00 AM IST", "Resets Sat, Nov 14 · 8:30 AM IST". */
export function resetText(at: number, now = Date.now()): string {
  const d = new Date(minute(at));
  const when = `${clockOf(d)} ${zoneOf(d)}`.trim();
  const diff = dayDiff(d, now);
  if (diff === 0) return `Resets today · ${when}`;
  if (diff === 1) return `Resets tomorrow · ${when}`;
  return `Resets ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${when}`;
}

/** For the sidebar: "today 7:43 PM IST", "tomorrow 9:00 AM IST", "Sat 8:30 AM IST" this week, "Nov 20" later. */
export function resetShort(at: number, now = Date.now()): string {
  const d = new Date(minute(at));
  const when = `${clockOf(d)} ${zoneOf(d)}`.trim();
  const diff = dayDiff(d, now);
  if (diff === 0) return `today ${when}`;
  if (diff === 1) return `tomorrow ${when}`;
  if (diff < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${when}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const shortLabel = (l: string) => l.replace("Current session (5-hour)", "5-hour").replace("Weekly (7 day)", "Weekly");

/**
 * Foot of the sidebar: a small card per agent with its plan, the limit nearest to running out
 * (big %, a full-width bar) and exactly when it resets. Click: the Fuel page with everything.
 */
export function PlanStrip({ state }: { state: ViewState }) {
  // Only agents reporting limits: the foot of the sidebar is for numbers, not notes.
  const plans = planList(state).filter((p) => headline(p));
  if (!plans.length) return null;
  return (
    <footer className="planstrip" aria-label="Plan usage">
      {plans.map((p) => {
        const w = headline(p);
        const name = p.account?.plan ?? p.tool;
        if (!w) return null;
        const lvl = level(w.pct);
        return (
          <button key={p.tool} className={`plancardmini ${lvl}`} onClick={() => send({ type: "openBoard", tab: "usage" })} data-tip="Open Fuel" aria-label={`${name}: ${w.pct}% of ${w.label} used. Open the Fuel page`}>
            <span className="pcmtop">
              <ToolMark tool={p.tool} size={14} />
              <span className="pcmname ellipsis">{name}</span>
              <span className={`pcmpct ${lvl}`}>
                {w.pct}
                <small>%</small>
              </span>
            </span>
            <span className={`planbar wide ${lvl}`} aria-hidden="true">
              <span style={{ width: `${Math.max(2, w.pct ?? 0)}%` }} />
            </span>
            <span className="pcmmeta ellipsis">
              {shortLabel(w.label)}
              {w.resetsAt ? ` · resets ${resetShort(w.resetsAt)}` : ""}
            </span>
          </button>
        );
      })}
    </footer>
  );
}

/** A ring that fills as a limit is used, its % in the middle. */
function Gauge({ pct, size = 92 }: { pct: number | null; size?: number }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <span className={`gauge ${level(pct)}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="gaugebg" />
        <circle cx={size / 2} cy={size / 2} r={r} className="gaugefg" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="gaugetext">
        {pct == null ? "–" : pct}
        <small>%</small>
      </span>
    </span>
  );
}

const productName = (t: Tool) => (t === "Claude" ? "Claude Code" : t === "Gemini" ? "Gemini CLI" : "Codex");

/** An organization named only after the email adds nothing: it is left out. */
const orgWorthShowing = (org?: string, email?: string) => !!org && !(email && org.toLowerCase().startsWith(email.toLowerCase()));

const SEGMENT = ["seg-a", "seg-b", "seg-c", "seg-d"];

/** The Fuel page: one card per agent with everything it reports. */
export function PlanCards({ state }: { state: ViewState }) {
  const plans = shownPlans(state);
  return (
    <section className="plans">
      <div className="pagehead">
        <div>
          <h2>Plans and limits</h2>
          <p className="muted small">As each agent reports them, for the account signed in on this computer.</p>
        </div>
        <button className="btn small ghostbtn" onClick={() => send({ type: "plans" })} disabled={state.plansLoading} data-tip="Read them again (R)">
          <RefreshCw {...I} size={13} className={state.plansLoading ? "spin" : ""} /> {state.plansLoading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {!plans.length && <p className="muted">{state.plansLoading ? "Asking your agents…" : "No agent has reported its plan yet."}</p>}
      <div className={`plancards ${plans.length === 1 ? "single" : ""}`}>
        {plans.map((p) => {
          const top = headline(p);
          const acct = p.account;
          const who = [acct?.auth, acct?.email, orgWorthShowing(acct?.organization, acct?.email) ? acct?.organization : undefined].filter(Boolean).join(" · ");
          return (
            <article key={p.tool} className="plancard">
              <header className="plancardhead">
                <span className={`plantile tool-${p.tool.toLowerCase()}`}>
                  <ToolMark tool={p.tool} size={18} />
                </span>
                <span className="plantitle">
                  <strong>{productName(p.tool)}</strong>
                  {who && <span className="planwho ellipsis">{who}</span>}
                </span>
                {acct?.plan && <span className="planbadge">{acct.plan}</span>}
              </header>

              {/* Left: the headline gauge. Right: every limit and where the use went. Side by side
                  when the card is wide, stacked when it is narrow. */}
              <div className="plancardbody">
              <div className="pcleft">
              {top ? (
                <div className="planhero">
                  <Gauge pct={top.pct} />
                  <div className="planherotext">
                    <span className="planherolabel">{top.label}</span>
                    <span className="planherohint">{top.pct != null && top.pct >= 90 ? "Almost used up" : top.pct != null && top.pct >= 70 ? "Getting close" : "Plenty left"}</span>
                    {top.resetsAt && (
                      <span className="planheroreset">
                        <Clock {...I} size={12} />
                        {/* "Resets tomorrow" and "8:30 AM IST" each stay whole; a narrow card wraps between them */}
                        {resetText(top.resetsAt)
                          .split(" · ")
                          .map((part, i) => (
                            <span key={i} className="rpart">
                              {i ? `· ${part}` : part}
                            </span>
                          ))}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="plannote muted">{p.note ?? "No limits reported."}</p>
              )}
              </div>
              {/* Only when there is more to show: an empty column left a gap under the gauge. */}
              {(p.windows.length > 1 || !!p.breakdown) && (
              <div className="pcright">
              {p.windows.length > 1 && (
                <div className="plangroup">
                  <div className="plangrouphead">All limits</div>
                  <div className="limitrows">
                    {p.windows.map((w) => (
                      <div key={w.label} className="limitrow">
                        <span className="limitname ellipsis">{w.label.replace("Current session (5-hour)", "5-hour session")}</span>
                        <span className={`planbar wide ${level(w.pct)}`} aria-hidden="true">
                          <span style={{ width: `${Math.max(1, w.pct ?? 0)}%` }} />
                        </span>
                        <span className={`planpct ${level(w.pct)}`}>{w.pct == null ? "–" : `${w.pct}%`}</span>
                        <span className="limitreset">{w.resetsAt ? resetShort(w.resetsAt) : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.breakdown && (
                <div className="plangroup">
                  <div className="plangrouphead">Where this week’s use went</div>
                  <div className="segbar" aria-hidden="true">
                    {p.breakdown.map((b, i) => (
                      <span key={b.label} className={SEGMENT[i % SEGMENT.length]} style={{ width: `${b.pct}%` }} />
                    ))}
                  </div>
                  <div className="seglegend">
                    {p.breakdown.map((b, i) => (
                      <span key={b.label}>
                        <i className={SEGMENT[i % SEGMENT.length]} /> {b.label} <b>{b.pct}%</b>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              </div>
              )}
              </div>

              <footer className="planfoot">
                {p.extra && (
                  <span className={`planchip ${p.extra.enabled ? "on" : ""}`}>
                    Extra usage {p.extra.enabled ? (p.extra.used != null ? `on · ${p.extra.used}${p.extra.limit != null ? ` of ${p.extra.limit}` : ""} ${p.extra.currency ?? ""}` : "on") : "off"}
                  </span>
                )}
                {p.windows.length > 0 && p.note && <span className="muted small">{p.note}</span>}
                <span className="grow" />
                <span className="muted small">
                  {p.source} · {agoText(p.at)}
                </span>
                {p.tool === "Claude" && (
                  <a className="small" href="https://claude.ai/settings/usage">
                    Manage on claude.ai
                  </a>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
