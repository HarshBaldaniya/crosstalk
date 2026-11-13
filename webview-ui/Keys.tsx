import * as React from "react";
// The keyboard shortcut sheet, opened from the top bar or with "?" on any page.
import { I, Keyboard, X } from "./Icons";
import type { KeySection } from "./pagekeys";

/** The shortcuts sheet: this page's keys first, then the ones that work everywhere. */
export function KeySheet({ sections, close }: { sections: KeySection[]; close: () => void }) {
  return (
    <div className="keysheetwrap" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="keysheet" role="dialog" aria-label="Keyboard shortcuts">
        <div className="keysheethead">
          <Keyboard {...I} size={15} />
          <strong>Keyboard shortcuts</strong>
          <span className="grow" />
          <button className="icon sm" onClick={close} aria-label="Close">
            <X {...I} />
          </button>
        </div>
        {sections.map((sec) => (
          <section key={sec.title} className="keysection">
            <div className="keysectiontitle">{sec.title}</div>
            <dl className="keylist">
              {sec.keys.map(([ks, what]) => (
                <div key={ks.join("+") + what} className="keyrow">
                  <dt>
                    {ks.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Typing in a field: single-key shortcuts stay out of the way. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/**
 * Closes a menu or popover on a click anywhere outside `ref`, and on Esc (the Esc goes no further,
 * so it doesn't also clear a selection or leave focus). Only while `open`.
 */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) closeRef.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, ref]);
}
