import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import type { BoardTab } from "../src/core/protocol";
import type { ToWebview, ViewState } from "../src/core/protocol";
import { AlertTriangle, Info, Link2, Pause, Play, RefreshCw, Unlink, X } from "lucide-react";
import { onMessage, send, setFlags } from "./api";
import { Board } from "./Board";
import { Modals, type Modal } from "./Modals";
import { Sidebar } from "./Sidebar";
import { TooltipLayer } from "./Tooltip";

const view = document.body.dataset.view === "board" ? "board" : "sidebar";

const INITIAL: ViewState = {
  tools: [],
  sessions: [],
  connections: [],
  inbox: {},
  board: { members: [], positions: {} },
  totals: {},
  hooksOn: true,
  claudeExtension: true,
  loading: true,
};

type ToastMsg = Extract<ToWebview, { type: "toast" }>;
interface Toast extends ToastMsg {
  id: number;
  ms: number;
}

const TOAST_ICON = { link: Link2, unlink: Unlink, pause: Pause, play: Play, sync: RefreshCw, info: Info } as const;

function App() {
  const [state, setState] = useState<ViewState>(INITIAL);
  const [modal, setModal] = useState<Modal | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tab, setTab] = useState<BoardTab>("board");
  const close = useCallback(() => setModal(null), []);

  useEffect(() => {
    let n = 0;
    const off = onMessage((msg) => {
      if (msg.type === "state") {
        setState(msg.state);
        setFlags({ autoCompact: msg.state.autoCompact !== false });
      }
      if (msg.type === "tab") setTab(msg.tab);
      if (msg.type === "peek") setModal({ kind: "peek", title: msg.title, text: msg.text });
      if (msg.type === "branchInfo")
        setState((s) => {
          setModal({ kind: "branch", id: msg.id, title: msg.title, tool: msg.tool, asks: msg.asks, contextChars: msg.contextChars, hooksOn: s.hooks?.Claude ?? s.hooksOn });
          return s;
        });
      if (msg.type === "toast") {
        const id = ++n;
        const ms = msg.undo ? 8000 : 5500;
        setModal((m) => (m?.kind === "loading" ? null : m));
        setToasts([{ ...msg, id, ms }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
      }
    });
    send({ type: "ready" });
    return off;
  }, []);

  // A request that failed on the extension side leaves "loading" up; let it go after a while.
  useEffect(() => {
    if (modal?.kind !== "loading") return;
    const t = setTimeout(() => setModal(null), 15000);
    return () => clearTimeout(t);
  }, [modal]);

  return (
    <>
      {view === "board" ? <Board state={state} setModal={setModal} tab={tab} setTab={setTab} /> : <Sidebar state={state} setModal={setModal} />}
      <Modals modal={modal} close={close} />
      <TooltipLayer />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = t.tone === "warn" ? AlertTriangle : TOAST_ICON[t.icon ?? "info"];
          const dismiss = () => setToasts((all) => all.filter((x) => x.id !== t.id));
          return (
            <div key={t.id} className={`toast ${t.tone ?? "ok"} ${t.icon ?? ""}`} onClick={(e) => e.target === e.currentTarget && dismiss()}>
              <span className="toasticon" aria-hidden="true">
                <Icon size={15} strokeWidth={2} />
              </span>
              <div className="toastbody">
                {t.title && <b>{t.title}</b>}
                <span>{t.text}</span>
              </div>
              {t.undo && (
                <button
                  className="toastundo"
                  onClick={() => {
                    send(t.undo!);
                    dismiss();
                  }}
                >
                  Undo
                </button>
              )}
              <button className="icon sm toastclose" onClick={dismiss} aria-label="Dismiss">
                <X size={13} />
              </button>
              <span className="toastbar" style={{ animationDuration: `${t.ms}ms` }} aria-hidden="true" />
            </div>
          );
        })}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
