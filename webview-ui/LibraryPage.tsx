// The Library: what each command is for. Commands on the left; the one you pick on the right, with
// what it does, what to type in your agent (a click copies it) and what it asks for. On a narrow
// screen the list and the details take turns.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Search, X } from "lucide-react";
import type { LibraryView } from "../src/core/protocol";
import type { Tool } from "../src/core/types";
import { onMessage, remember, remembered, send } from "./api";
import { I, ToolMark } from "./Icons";

type Cmd = LibraryView["commands"][number];
type AgentId = "claude" | "codex" | "gemini";

const AGENTS: { id: AgentId; tool: Tool; name: string; form: (n: string) => string }[] = [
  { id: "claude", tool: "Claude", name: "Claude", form: (n) => `/crosstalk:${n}` },
  { id: "codex", tool: "Codex", name: "Codex", form: (n) => `/prompts:${n}` },
  { id: "gemini", tool: "Gemini", name: "Gemini", form: (n) => `/${n}` },
];

export function LibraryPage() {
  const [data, setData] = useState<LibraryView | undefined>();
  const [q, setQ] = useState("");
  const [suggested, setSuggested] = useState<{ q: string; names: string[] } | undefined>();
  const [pick, setPick] = useState<string>(() => remembered("libraryPick", "plan"));
  const [agent, setAgent] = useState<AgentId>(() => remembered("libraryAgent", "claude"));
  // On a narrow screen: is the details side showing?
  const [opened, setOpened] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "library") setData(m.data);
        if (m.type === "librarySuggest") setSuggested({ q: m.q, names: m.names });
      }),
    [],
  );
  useEffect(() => send({ type: "library" }), []);
  useEffect(() => {
    if (!q.trim()) return setSuggested(undefined);
    const t = setTimeout(() => send({ type: "librarySuggest", q: q.trim() }), 140);
    return () => clearTimeout(t);
  }, [q]);

  const byName = useMemo(() => new Map((data?.commands ?? []).map((c) => [c.name, c])), [data]);
  const matches = suggested && suggested.q === q.trim() ? suggested.names.map((n) => byName.get(n)).filter((c): c is Cmd => !!c) : undefined;
  const groups = useMemo(() => {
    if (!data) return [];
    if (matches) return [{ id: "fits", title: "", cmds: matches }];
    const mine = data.commands.filter((c) => c.source !== "builtin");
    // What you reach for most stays at the top, however long the list grows.
    const most = [...data.commands].filter((c) => c.used > 0).sort((a, b) => b.used - a.used).slice(0, 5);
    return [...(most.length ? [{ id: "most", title: "Used most", cmds: most }] : []), ...(mine.length ? [{ id: "mine", title: "Yours", cmds: mine }] : []), ...data.packs.map((p) => ({ id: p.id, title: p.title, cmds: data.commands.filter((c) => c.pack === p.id && c.source === "builtin") }))].filter((g) => g.cmds.length);
  }, [data, matches]);
  const flat = groups.flatMap((g) => g.cmds);
  // The best fit is shown as you type.
  useEffect(() => {
    if (matches?.[0]) setPick(matches[0].name);
  }, [suggested]); // eslint-disable-line react-hooks/exhaustive-deps

  const present = (data?.agents ?? []).filter((a) => a.present);
  const agents = AGENTS.filter((a) => present.some((p) => p.id === a.id));
  const shownAgent = agents.find((a) => a.id === agent) ?? agents[0] ?? AGENTS[0];
  const notSetUp = present.filter((a) => !a.tools);
  const chosen = byName.get(pick) ?? flat[0];

  const choose = (name: string, scroll = false) => {
    setPick(name);
    remember("libraryPick", name);
    if (scroll) requestAnimationFrame(() => listRef.current?.querySelector(`[data-cmd="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (typing && t !== searchRef.current) return;
        e.preventDefault();
        const i = Math.max(0, flat.findIndex((c) => c.name === chosen?.name));
        const next = flat[Math.min(flat.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) choose(next.name, true);
      } else if (e.key === "Escape") {
        if (t === searchRef.current && q) setQ("");
        else setOpened(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data) return <div className="libpage" />;

  return (
    <div className={`libpage${opened ? " opened" : ""}`}>
      <div className="libgrid">
        <div className="libleft">
          <div className="libsearch">
            <Search {...I} />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="What do you want to do?" aria-label="Find a command" />
            {q ? (
              <button className="icon sm" onClick={() => setQ("")} aria-label="Clear">
                <X {...I} />
              </button>
            ) : (
              <kbd className="cbkey">/</kbd>
            )}
          </div>
          {notSetUp.length > 0 && (
            <div className="libnotice">
              <span>{notSetUp.map((a) => a.name).join(" and ")} can't use these yet.</span>
              <button className="linkbtn" onClick={() => send({ type: "setUpToolkit" })}>
                Set up
              </button>
            </div>
          )}
          <div className="liblist" ref={listRef} role="listbox" aria-label="Commands">
            {groups.map((g) => (
              <section key={g.id} className="libgroup">
                {g.title && <div className="libgrouptitle">{g.title}</div>}
                {g.cmds.map((c) => (
                  <button
                    key={`${g.id}:${c.name}`}
                    role="option"
                    aria-selected={c.name === chosen?.name}
                    className={`librow${c.name === chosen?.name ? " on" : ""}`}
                    data-cmd={c.name}
                    onClick={() => {
                      choose(c.name);
                      setOpened(true);
                    }}
                  >
                    <span className="librowtitle ellipsis">{c.title}</span>
                    <span className="librowname">/{c.name}</span>
                  </button>
                ))}
              </section>
            ))}
            {matches && !matches.length && <p className="libnothing">Nothing fits. Just ask your agent in your own words.</p>}
          </div>
        </div>

        <div className="libright">
          {chosen && (
            <Details
              key={chosen.name}
              c={chosen}
              agents={agents}
              agent={shownAgent}
              setAgent={(id) => {
                setAgent(id);
                remember("libraryAgent", id);
              }}
              back={() => setOpened(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** What a command is for, and how to use it. */
function Details({ c, agents, agent, setAgent, back }: { c: Cmd; agents: typeof AGENTS; agent: (typeof AGENTS)[number]; setAgent: (id: AgentId) => void; back: () => void }) {
  const [copied, setCopied] = useState(false);
  const main = c.args.find((a) => a.required);
  const copy = () => {
    send({ type: "libraryCopy", name: c.name, text: agent.form(c.name) });
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <article className="libdetail">
      <button className="libback linkbtn" onClick={back}>
        <ArrowLeft {...I} size={14} /> All commands
      </button>
      <div className="libname">/{c.name}</div>
      <h2>{c.title}</h2>
      <p className="libdesc">{c.description}</p>
      {c.needs && <p className="libneeds">Needs {c.needs} connected to your agent.</p>}

      <section className="libsection">
        <div className="libsectiontitle">
          <span>Type it in</span>
          {agents.length > 1 && (
            <div className="libagents" role="tablist" aria-label="Agent">
              {agents.map((a) => (
                <button key={a.id} role="tab" aria-selected={a.id === agent.id} className={a.id === agent.id ? "on" : ""} onClick={() => setAgent(a.id)}>
                  <ToolMark tool={a.tool} size={12} /> {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="libcode" onClick={copy} aria-label={`Copy ${agent.form(c.name)}`}>
          <span className="libcodetext ellipsis">
            {agent.form(c.name)}
            {main && <span className="libarg"> {`<${main.name}>`}</span>}
          </span>
          {copied ? <Check {...I} size={14} className="libcopied" /> : <Copy {...I} size={14} />}
        </button>
      </section>

      {c.args.length > 0 && (
        <section className="libsection">
          <div className="libsectiontitle">
            <span>It asks for</span>
          </div>
          <ul className="libargs">
            {c.args.map((a) => (
              <li key={a.name}>
                <span className="libargname">{a.name}</span>
                <span>
                  {a.description.replace(/\s*\(default:[^)]*\)/i, "")}
                  {!a.required && <span className="muted"> · optional</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
