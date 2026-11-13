// Small controls for one chat, shared by the sidebar and the board card:
// switch its model, and compact its context. Both use the AI tool's own
// commands. For Claude Code, Crosstalk opens the chat with the command ready and
// the person presses Enter, and the model list is Claude Code's own (see
// useModels). Codex and Gemini CLI show their own picker for /model and run
// where the person started them, so Crosstalk copies the command to paste there.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ModelOption } from "../src/core/protocol";
import type { ChatSession } from "../src/core/types";
import { contextPct, modelName, send, useFlags, useModels } from "./api";
import { Check, ChevronDown, I } from "./Icons";

/** The listed model a chat is using: by the tool's id, the resolved id, or the name. */
function currentOf(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) return undefined;
  return (
    models.find((m) => m.value !== "default" && (m.resolved === model || m.value === model)) ??
    models.find((m) => m.value !== "default" && m.name === modelName(model))
  );
}

/**
 * Switching the model and compacting from Crosstalk are off for now: the model and the context are
 * shown, read only. Set to true to offer both again (all the wiring below and in the extension stays).
 */
export const CHAT_CONTROLS = false;

/** The chat's model: its name, or (with CHAT_CONTROLS) a menu to switch it. */
export function ModelPicker({ s }: { s: ChatSession }) {
  return CHAT_CONTROLS ? <ModelMenu s={s} /> : <span className="modelname ellipsis">{modelName(s.model) ?? "–"}</span>;
}

function ModelMenu({ s }: { s: ChatSession }) {
  const [open, setOpen] = useState(false);
  const { models, error } = useModels(s.tool, open);
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const close = (e: Event) => !menuRef.current?.contains(e.target as Node) && setOpen(false);
    const shut = () => setOpen(false);
    // Capture phase, so the board's canvas (which stops clicks) can't keep the menu open.
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", shut);
    // A click in the editor, another panel or another app never reaches this view: losing focus closes it.
    window.addEventListener("blur", shut);
    document.addEventListener("visibilitychange", shut);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", shut);
      window.removeEventListener("blur", shut);
      document.removeEventListener("visibilitychange", shut);
    };
  }, [open]);

  // Placed in the page's top layer, under the button (above it when there is no room), inside the window.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16);
    const left = Math.min(Math.max(r.left - 6, 8), window.innerWidth - w - 8);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    setPlace(
      below >= 220 || below >= above
        ? { left, top: r.bottom + 6, width: w, maxHeight: Math.max(160, below) }
        : { left, bottom: window.innerHeight - r.top + 6, width: w, maxHeight: Math.max(160, above) },
    );
  }, [open, models]);

  if (s.tool !== "Claude")
    return (
      <span className="modelpick nodrag nopan">
        <button className="modelbtn" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), send({ type: "chatCommand", id: s.id, command: "model" }))}>
          {modelName(s.model) ?? "Model"}
          <ChevronDown {...I} size={12} />
        </button>
      </span>
    );
  const current = models ? currentOf(models, s.model) : undefined;
  return (
    <span className="modelpick nodrag nopan" ref={ref}>
      <button
        className="modelbtn"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {current?.name ?? modelName(s.model) ?? "Model"}
        <ChevronDown {...I} size={12} />
      </button>
      {open &&
        createPortal(
        <div className="modelmenu" role="menu" ref={menuRef} style={place}>
          <div className="menusection">Select a model</div>
          {!models && !error && <div className="menuempty pulse">Asking {s.tool} for its models…</div>}
          {error && <div className="menuempty">{error}</div>}
          {models?.map((m) => {
            const on = m === current;
            return (
              <button
                key={m.value}
                role="menuitemradio"
                aria-checked={on}
                className={on ? "on" : ""}
                onClick={() => {
                  if (!on) send({ type: "chatCommand", id: s.id, command: "model", model: m.value });
                  setOpen(false);
                }}
              >
                <span className="mname">
                  {m.name}
                  <small>{m.description}</small>
                </span>
                {on && <Check {...I} size={14} />}
              </button>
            );
          })}
        </div>,
          document.body,
        )}
    </span>
  );
}

export function CompactButton({ s }: { s: ChatSession }) {
  return CHAT_CONTROLS ? <CompactControls s={s} /> : null;
}

function CompactControls({ s }: { s: ChatSession }) {
  const flags = useFlags();
  // Claude Code's auto-compact is a setting Crosstalk reads; Codex and Gemini CLI compact by themselves by default.
  const autoCompact = s.tool === "Claude" ? flags.autoCompact : true;
  const pct = contextPct(s.context) ?? 0;
  return (
    <span className="compactwrap nodrag nopan">
      {autoCompact && pct >= 80 && <span className="autonote">compacts itself when full</span>}
      {!autoCompact && pct >= 70 && (
        <button className="compactbtn" onClick={() => send({ type: "autoCompactOn" })}>
          Turn on auto-compact
        </button>
      )}
      <button className={`compactbtn ${!autoCompact && pct >= 70 ? "urgent" : ""}`} onClick={() => send({ type: "chatCommand", id: s.id, command: "compact" })}>
        Compact
      </button>
    </span>
  );
}
