// The Runs page: agents working by themselves, each in its own copy of the repo with a budget, and
// the automations that start them. Nothing reaches your checkout until you apply it.
import { useEffect, useState } from "react";
import { CirclePause, CirclePlay, FileText, FolderOpen, GitMerge, OctagonX, Play, Plus, Square, Trash2, Zap } from "lucide-react";
import type { RunsView } from "../src/core/protocol";
import type { Run } from "../src/core/runs";
import { onMessage, send, tokens } from "./api";
import { I, ToolMark } from "./Icons";

const AGENTS = [
  { id: "claude" as const, tool: "Claude" as const, name: "Claude" },
  { id: "codex" as const, tool: "Codex" as const, name: "Codex" },
  { id: "gemini" as const, tool: "Gemini" as const, name: "Gemini" },
];
const LANES: { title: string; states: Run["state"][] }[] = [
  { title: "Running", states: ["running"] },
  { title: "Needs you", states: ["needs-you"] },
  { title: "In review", states: ["in-review"] },
  { title: "Done and stopped", states: ["done", "stopped", "failed"] },
];
const TRIGGER_TEXT: Record<string, string> = { "chat-finished": "When a chat finishes", schedule: "On a schedule", "file-saved": "When a file is saved", "ci-failed": "When CI fails" };

export function RunsPage() {
  const [data, setData] = useState<RunsView | undefined>();
  const [task, setTask] = useState("");
  const [agents, setAgents] = useState<Set<string>>(new Set(["claude"]));
  const [budget, setBudget] = useState(2_000_000);
  const [minutes, setMinutes] = useState(30);
  const [leases, setLeases] = useState("");

  useEffect(() => onMessage((m) => m.type === "runs" && setData(m.data)), []);
  useEffect(() => send({ type: "runs" }), []);
  // While something runs, its numbers move: read them again every few seconds.
  const running = data?.runs.some((r) => r.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => send({ type: "runs" }), 3000);
    return () => clearInterval(t);
  }, [running]);

  const start = () => {
    if (!task.trim() || !agents.size) return;
    send({ type: "runStart", task: task.trim(), agents: [...agents] as ("claude" | "codex" | "gemini")[], tokens: budget, minutes, leases: leases.split(",").map((x) => x.trim()).filter(Boolean) });
    setTask("");
  };
  const toggle = (id: string) => {
    const next = new Set(agents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAgents(next);
  };

  if (!data) {
    return (
      <div className="usage runspage">
        <div className="pagehead">
          <div>
            <h2>Runs</h2>
            <p className="muted small">Loading…</p>
          </div>
        </div>
      </div>
    );
  }
  const active = data.runs.some((r) => r.state === "running") || data.automations.some((a) => a.enabled);

  return (
    <div className="usage runspage">
      <div className="pagehead">
        <div>
          <h2>Runs</h2>
          <p className="muted small">Agents working by themselves, each in its own copy of the repo, with a budget. Nothing reaches your files until you apply it.</p>
        </div>
        {active && (
          <button className="btn small danger" onClick={() => send({ type: "stopAll" })} data-tip="Stop every run and pause every automation">
            <OctagonX {...I} /> Stop everything
          </button>
        )}
      </div>

      <section className="tile newrun">
        <label className="muted small" htmlFor="runtask">
          New run
        </label>
        <textarea id="runtask" value={task} onChange={(e) => setTask(e.target.value)} rows={2} placeholder="What should it do? “Add tests for the billing service”, “Fix the flaky upload test”" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && start()} />
        <div className="newrunrow">
          <div className="agentpick" role="group" aria-label="Agents">
            {AGENTS.map((a) => (
              <button key={a.id} className={`agentchip${agents.has(a.id) ? " ok" : ""}`} aria-pressed={agents.has(a.id)} onClick={() => toggle(a.id)}>
                <ToolMark tool={a.tool} size={12} /> {a.name}
              </button>
            ))}
            {agents.size > 1 && <span className="muted small">same task to {agents.size} agents: compare</span>}
          </div>
          <label className="budgetpick">
            <span className="muted small">Budget</span>
            <select value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
              {[500_000, 1_000_000, 2_000_000, 4_000_000].map((b) => (
                <option key={b} value={b}>
                  {tokens(b)} tokens
                </option>
              ))}
            </select>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[10, 20, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
          <input className="leaseinput" value={leases} onChange={(e) => setLeases(e.target.value)} placeholder="Folders it may change (optional): src/billing, tests" aria-label="Folders it may change" />
          <button className="btn small primary" onClick={start} disabled={!task.trim() || !agents.size}>
            <Play {...I} /> Start
          </button>
        </div>
      </section>

      <div className="lanes">
        {LANES.map((lane) => {
          const runs = data.runs.filter((r) => lane.states.includes(r.state));
          return (
            <section key={lane.title} className="lane">
              <h3 className="section">
                {lane.title} <span className="muted">{runs.length || ""}</span>
              </h3>
              {runs.length === 0 && <div className="muted small laneempty">None</div>}
              {runs.map((r) => (
                <RunCard key={r.id} r={r} />
              ))}
            </section>
          );
        })}
      </div>

      <section className="automations">
        <div className="usagehead">
          <div>
            <h2>Automations</h2>
            <p className="muted small">Runs that start on their own. Each has a budget and a daily cap, never starts from another run, and its result waits for you.</p>
          </div>
          <button className={`btn small${data.paused ? " primary" : " ghostbtn"}`} onClick={() => send({ type: "automationsPaused", paused: !data.paused })}>
            {data.paused ? <CirclePlay {...I} /> : <CirclePause {...I} />} {data.paused ? "Turn automations back on" : "Pause all"}
          </button>
        </div>
        {data.automations.length === 0 && <p className="muted small">None yet. Start from one of these:</p>}
        <div className="autolist">
          {data.automations.map((a) => (
            <div key={a.id} className={`autorow${a.enabled && !data.paused ? "" : " off"}`}>
              <Zap {...I} />
              <div className="autotext">
                <div className="ellipsis">{a.name}</div>
                <div className="muted small ellipsis">
                  {TRIGGER_TEXT[a.on.kind]}
                  {a.on.kind === "schedule" ? ` at ${a.on.at}` : a.on.kind === "file-saved" ? `: ${a.on.glob}` : ""} · {a.agent} · up to {a.dailyCap} a day · {tokens(a.budget.tokens)} tokens, {a.budget.minutes} min each
                </div>
              </div>
              <button className="btn small ghostbtn" onClick={() => send({ type: "automation", id: a.id, action: a.enabled ? "off" : "on" })}>
                {a.enabled ? "Switch off" : "Switch on"}
              </button>
              <button className="icon sm" onClick={() => send({ type: "automation", id: a.id, action: "remove" })} aria-label={`Remove ${a.name}`} data-tip="Remove">
                <Trash2 {...I} />
              </button>
            </div>
          ))}
        </div>
        <div className="templates">
          {data.templates.map((t) => (
            <button key={t.index} className="btn small ghostbtn" onClick={() => send({ type: "automationAdd", index: t.index })}>
              <Plus {...I} /> {t.name}
            </button>
          ))}
        </div>
        {data.audit.length > 0 && (
          <details className="auditlog">
            <summary className="muted small">What automations decided ({data.audit.length})</summary>
            <ul>
              {data.audit.slice(0, 20).map((l, i) => (
                <li key={i} className="small">
                  <span className="muted">{new Date(l.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> {data.automations.find((a) => a.id === l.automation)?.name ?? l.automation}: {l.decision === "started" ? "started a run" : `skipped (${l.why})`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function RunCard({ r }: { r: Run }) {
  const pct = Math.min(100, Math.round((100 * r.used.tokens) / Math.max(1, r.budget.tokens)));
  const mins = Math.round((r.state === "running" ? Date.now() - r.createdAt : r.used.ms) / 60000);
  const agent = AGENTS.find((a) => a.id === r.agent)!;
  return (
    <div className={`runcard ${r.state}`}>
      <div className="runtop">
        <ToolMark tool={agent.tool} size={14} />
        <span className="runtask" data-tip={r.task}>
          {r.task}
        </span>
      </div>
      <div className="runmeta muted small">
        {r.trigger !== "you" && <span className="docbadge none">{r.trigger}</span>}
        {r.group && <span className="docbadge draft">compare</span>}
        <span>
          {tokens(r.used.tokens)} of {tokens(r.budget.tokens)} · {mins} of {r.budget.minutes} min
        </span>
      </div>
      <div className="runbar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : ""} />
      </div>
      {r.diff && r.diff.files > 0 && (
        <div className="small rundiff">
          <span className="plus">+{r.diff.added}</span> <span className="minus">−{r.diff.removed}</span> · {r.diff.files} file{r.diff.files === 1 ? "" : "s"}
          <span className="muted ellipsis"> · {r.diff.names.slice(0, 3).join(", ")}</span>
        </div>
      )}
      {r.summary && <p className="runsummary small">{r.summary}</p>}
      {r.reason && <p className="muted small">{r.reason}</p>}
      <div className="runactions">
        {r.state === "running" && (
          <button className="btn small" onClick={() => send({ type: "run", id: r.id, action: "stop" })}>
            <Square {...I} /> Stop
          </button>
        )}
        {r.state === "in-review" && (
          <button className="btn small primary" onClick={() => send({ type: "run", id: r.id, action: "apply" })} data-tip="Its changes, into your checkout as uncommitted edits">
            <GitMerge {...I} /> Apply
          </button>
        )}
        {r.state !== "running" && (
          <button className="btn small ghostbtn" onClick={() => send({ type: "run", id: r.id, action: "open" })} data-tip="Open its copy in a new window">
            <FolderOpen {...I} /> Open
          </button>
        )}
        <button className="btn small ghostbtn" onClick={() => send({ type: "run", id: r.id, action: "log" })}>
          <FileText {...I} /> Log
        </button>
        {r.state !== "running" && (
          <button className="icon sm" onClick={() => send({ type: "run", id: r.id, action: "discard" })} aria-label="Discard this run" data-tip="Discard: remove its copy and branch">
            <Trash2 {...I} />
          </button>
        )}
      </div>
    </div>
  );
}
