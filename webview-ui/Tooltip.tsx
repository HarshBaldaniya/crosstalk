// One tooltip for the whole view: any element with `data-tip` shows it after a
// short pause on hover, or at once on keyboard focus. It is measured before it
// shows, centred on its element, kept inside the window, placed above (or
// below when there is no room), and its arrow always points at the element.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const DELAY_MS = 380;
const EDGE = 6;
const GAP = 8;

interface Target {
  text: string;
  rect: DOMRect;
}

export function TooltipLayer() {
  const [target, setTarget] = useState<Target | null>(null);
  const [style, setStyle] = useState<{ box: CSSProperties; arrow: CSSProperties; below: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const find = (e: Event) => ((e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null) ?? null;
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (text && el.isConnected) setTarget({ text, rect: el.getBoundingClientRect() });
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTarget(null);
    };
    const over = (e: MouseEvent) => {
      const el = find(e);
      if (el === current) return;
      clearTimeout(timer);
      setTarget(null);
      current = el;
      if (el) timer = setTimeout(() => show(el), DELAY_MS);
    };
    const focus = (e: FocusEvent) => {
      const el = find(e);
      if (el && (e.target as HTMLElement).matches(":focus-visible")) show(el);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Measure the tooltip as rendered, then place it.
  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setStyle(null);
      return;
    }
    const { width: w, height: h } = ref.current.getBoundingClientRect();
    const r = target.rect;
    const centre = r.left + r.width / 2;
    const left = Math.min(Math.max(centre - w / 2, EDGE), window.innerWidth - w - EDGE);
    const below = r.top - h - GAP < EDGE;
    const top = below ? r.bottom + GAP : r.top - h - GAP;
    const arrowX = Math.min(Math.max(centre - left, 10), w - 10);
    setStyle({ box: { left, top }, arrow: { left: arrowX }, below });
  }, [target]);

  if (!target) return null;
  return (
    <div
      ref={ref}
      className={`tooltip ${style?.below ? "below" : "above"} ${style ? "shown" : ""}`}
      role="tooltip"
      style={style ? style.box : { left: -9999, top: -9999 }}
    >
      {target.text}
      <span className="tiparrow" style={style?.arrow} aria-hidden="true" />
    </div>
  );
}
