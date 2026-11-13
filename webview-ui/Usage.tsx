// Fuel: tokens per agent (today and in total), per chat, and what each channel carried.
// The headline is new tokens (in + out + cache write); cache reads, the same
// context re-read every turn at a tenth of the price, are shown on their own.
import { useEffect, useMemo, useState } from "react";
import type { ViewState } from "../src/core/protocol";
import type { Tool, Usage } from "../src/core/types";
import { NO_USAGE } from "../src/core/types";
import { agoText, charsToTokens, contextPct, fresh, send, tokens } from "./api";
import { ArrowLeftRight, ArrowRight, Coins, I, StatusDot, ToolMark } from "./Icons";
import { PlanCards } from "./Plans";
import { typing } from "./Keys";


type Range = "today" | "total";

function add(a: Usage, b?: Usage): Usage {
  return b ? { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite } : a;
}

export function UsageView({ state }: { state: ViewState }) {
  const [range, setRange] = useState<Range>("today");
  const focusOn = !!state.focus;
  // The usage page's own keys (B and U, to switch pages, work everywhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (focusOn) send({ type: "fullscreen" });
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "r") send({ type: "plans" });
      else if (k === "d") setRange("today");
      else if (k === "a") setRange("total");
      else if (k === "f") send({ type: "fullscreen" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusOn]);
  const tools = Object.keys(state.totals) as Tool[];
  const all = tools.reduce((u, t) => add(u, state.totals[t]![range]), NO_USAGE);
  const pick = (u?: Usage) => (range === "today" ? u : u);
  const chats = useMemo(
    () =>
      [...state.sessions]
        .map((s) => ({ s, u: range === "today" ? s.usageToday : s.usage }))
        .filter((x) => x.u && (fresh(x.u) > 0 || x.u.cacheRead > 0))
        .sort((a, b) => fresh(b.u) - fresh(a.u))
        .slice(0, 50),
    [state.sessions, range],
  );
  const links = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: (typeof state.connections)[number]; b?: (typeof state.connections)[number] }[] = [];
    for (const c of state.connections) {
      if (seen.has(c.id)) continue;
      const back = state.connections.find((r) => r.from.id === c.to.id && r.to.id === c.from.id);
      seen.add(c.id);
      if (back) seen.add(back.id);
      out.push({ a: c, b: back });
    }
    return out;
  }, [state.connections]);
  const sent = state.connections.reduce((n, c) => n + c.chars, 0);
  const updates = state.connections.reduce((n, c) => n + c.updates, 0);

  return (
    <div className="usage">
      <PlanCards state={state} />
      <div className="usagehead">
        <div>
          <h2>Tokens</h2>
          <p className="muted small">For chats in this folder.</p>
        </div>
        <div className="seg" role="group" aria-label="Period">
          <button className={range === "today" ? "on" : ""} aria-pressed={range === "today"} onClick={() => setRange("today")} data-tip="Today (D)">
            Today
          </button>
          <button className={range === "total" ? "on" : ""} aria-pressed={range === "total"} onClick={() => setRange("total")} data-tip="All time (A)">
            All time
          </button>
        </div>
      </div>

      <div className="tile fuelused">
        <div className="tilelabel">
          <Coins {...I} /> Tokens used {range === "today" ? "today" : "in all"}
        </div>
        <div className="tilefig">{tokens(fresh(all))}</div>
        {tools.length > 1 && (
          <>
            <div className="fuelsplit" aria-hidden="true">
              {tools.map((t) => (
                <i key={t} className={`fueltool ${t.toLowerCase()}`} style={{ flexGrow: fresh(state.totals[t]![range]) }} />
              ))}
            </div>
            <div className="breakdown">
              {tools.map((t) => (
                <span key={t}>
                  <ToolMark tool={t} size={12} /> {t} {tokens(fresh(state.totals[t]![range]))}
                </span>
              ))}
            </div>
          </>
        )}
        {links.length > 0 && (
          <div className="muted small">
            {tokens(charsToTokens(sent))} shared between linked chats ({updates} update{updates === 1 ? "" : "s"})
          </div>
        )}
      </div>

      {links.length > 0 && (
        <section>
          <h3 className="section">Channels</h3>
          <div className="list">
            {links.map(({ a, b }) => {
              const conns = [a, b].filter(Boolean) as typeof state.connections;
              const paused = conns.every((c) => c.paused);
              const n = conns.reduce((x, c) => x + c.updates, 0);
              const chars = conns.reduce((x, c) => x + c.chars, 0);
              const last = Math.max(...conns.map((c) => c.lastAt ?? 0));
              return (
                <div key={a.id} className="listrow">
                  <span className="linkpair">
                    <ToolMark tool={a.from.tool} size={12} />
                    <span className="ellipsis">{a.from.title}</span>
                    <span className={`dirtag ${b ? "both" : "out"}`}>{b ? <ArrowLeftRight {...I} size={12} /> : <ArrowRight {...I} size={12} />}</span>
                    <ToolMark tool={a.to.tool} size={12} />
                    <span className="ellipsis">{a.to.title}</span>
                  </span>
                  <span className={paused ? "muted" : "live"}>{paused ? "Paused" : "Sharing"}</span>
                  <span className="num">
                    {n} update{n === 1 ? "" : "s"}
                  </span>
                  <span className="num">~{tokens(charsToTokens(chars))}</span>
                  <span className="num muted">{last ? agoText(last) : "–"}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h3 className="section">Chats</h3>
        {chats.length === 0 ? (
          <p className="muted">No tokens {range === "today" ? "today" : "recorded"} in this folder yet.</p>
        ) : (
          <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Chat</th>
                <th className="num">Tokens</th>
                <th className="num">How full</th>
              </tr>
            </thead>
            <tbody>
              {chats.map(({ s, u }) => {
                const full = contextPct(s.context);
                const heavy = full !== undefined && full >= 70;
                return (
                  <tr key={s.id} className="clickable" onClick={() => send({ type: "open", id: s.id })} data-tip={`${s.title}\nOpen in ${s.tool}`}>
                    <td>
                      <span className="cellchat">
                        <ToolMark tool={s.tool} size={12} />
                        <StatusDot status={s.status} />
                        <span className="ellipsis">{s.title}</span>
                      </span>
                    </td>
                    <td className="num strong">{tokens(fresh(pick(u)))}</td>
                    <td className="num">
                      {full === undefined ? (
                        <span className="muted">–</span>
                      ) : heavy ? (
                        <span className="heavy" data-tip="Nearly full: every message re-reads the whole chat">
                          {full}%
                        </span>                      ) : (
                        `${full}%`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** In, out and cache write as one stacked bar. */
function Bar({ u }: { u: Usage }) {
  const t = fresh(u) || 1;
  return (
    <div className="bar" aria-hidden="true">
      <span className="in" style={{ width: `${(u.input / t) * 100}%` }} />
      <span className="out" style={{ width: `${(u.output / t) * 100}%` }} />
      <span className="cw" style={{ width: `${(u.cacheWrite / t) * 100}%` }} />
    </div>
  );
}
