// Dialogs both views use: Branch (start a new chat for a task, with this
// chat's context) and Peek (what is waiting to reach a chat).
import { useEffect, useRef, useState } from "react";
import type { Ask } from "../src/core/protocol";
import type { Tool } from "../src/core/types";
import { charsToTokens, send, tokens } from "./api";
import { Check, ChevronRight, I, Plus, ToolMark, X } from "./Icons";

export type Modal =
  | { kind: "loading"; label: string }
  | { kind: "branch"; id: string; title: string; tool: Tool; asks: Ask[]; contextChars: number; hooksOn: boolean }
  | { kind: "peek"; title: string; text: string };

export function Modals({ modal, close }: { modal: Modal | null; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  if (!modal) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      {modal.kind === "loading" && (
        <div className="dialog" role="dialog" aria-label={modal.label}>
          <p className="pulse">{modal.label}</p>
        </div>
      )}
      {modal.kind === "branch" && <BranchDialog m={modal} close={close} />}
      {modal.kind === "peek" && (
        <div className="dialog wide" role="dialog" aria-label="Waiting context">
          <h2>Arriving in “{modal.title}”</h2>
          <p className="muted small">This reaches the chat with its next message.</p>
          <pre className="peek">{modal.text}</pre>
          <div className="actions">
            <button className="btn primary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchDialog({ m, close }: { m: Extract<Modal, { kind: "branch" }>; close: () => void }) {
  const [task, setTask] = useState("");
  const [withContext, setWithContext] = useState(true);
  const [keep, setKeep] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showAsks, setShowAsks] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const go = () => {
    if (!task.trim()) return;
    send({ type: "branch", from: m.id, task, withContext, askIds: [...picked], keepConnected: keep });
    close();
  };
  return (
    <div className="dialog newtask" role="dialog" aria-label="New task">
      <div className="nthead">
        <div>
          <h2>New task</h2>
          <div className="ntfrom">
            from <ToolMark tool={m.tool} size={13} /> <span className="ellipsis" data-tip={m.title}>{m.title}</span>
          </div>
        </div>
        <button className="icon" onClick={close} aria-label="Close">
          <X {...I} />
        </button>
      </div>
      <textarea
        ref={ref}
        className="ntinput"
        rows={4}
        aria-label="What should the new chat do?"
        placeholder="What should the new chat do?"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && go()}
      />
      <div className="ntoptions" role="group" aria-label="Options">
        <button role="switch" aria-checked={withContext} className={`ntpill ${withContext ? "on" : ""}`} onClick={() => setWithContext((v) => !v)}>
          {withContext ? <Check {...I} size={12} /> : <Plus {...I} size={12} />} Bring context
          <span className="ntmeta">{tokens(charsToTokens(m.contextChars))}</span>
        </button>
        <button role="switch" aria-checked={keep} className={`ntpill ${keep ? "on" : ""}`} onClick={() => setKeep((v) => !v)}>
          {keep ? <Check {...I} size={12} /> : <Plus {...I} size={12} />} Keep connected
        </button>
        {m.asks.length > 0 && (
          <button className={`ntpill ${showAsks || picked.size ? "on" : ""}`} aria-expanded={showAsks} onClick={() => setShowAsks((v) => !v)}>
            <ChevronRight {...I} size={12} className={`chev ${showAsks ? "open" : ""}`} /> Earlier asks
            <span className="ntmeta">{picked.size ? `${picked.size} picked` : m.asks.length}</span>
          </button>
        )}
      </div>
      {showAsks && (
        <div className="ntasks">
          <div className="ntaskhead">Newest first</div>
          {m.asks.map((a, i) => (
            <label key={a.id} className={`ntask ${picked.has(a.id) ? "on" : ""}`}>
              <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="ntnum">{i + 1}</span>
              <span className="ellipsis">{a.text}</span>
            </label>
          ))}
        </div>
      )}
      {!m.hooksOn && <p className="muted small">Auto-sharing is off, so the context goes into the new chat’s message box.</p>}
      <div className="ntfoot">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn primary ntgo" disabled={!task.trim()} onClick={go}>
          Start chat <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
