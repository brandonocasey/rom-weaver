import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { formatByteSize } from "../../../presentation/workflow-presentation.ts";

type SizeProps = {
  as?: "span" | "code";
  bytes?: number | string | null;
  className?: string;
  value?: ReactNode;
};

const toFiniteBytes = (bytes: number | string | null | undefined) => {
  if (typeof bytes === "number" && Number.isFinite(bytes)) return Math.floor(bytes);
  if (typeof bytes === "string" && /^\d+$/.test(bytes.trim())) return Number.parseInt(bytes.trim(), 10);
  return undefined;
};

const toBytesTitle = (bytes: number | string | null | undefined) => {
  const value = toFiniteBytes(bytes);
  return typeof value === "number" ? `${value} B` : "";
};

function Size({ as = "span", bytes, className, value }: SizeProps) {
  const Element = as;
  const normalizedBytes = toFiniteBytes(bytes);
  const displayValue = value ?? (typeof normalizedBytes === "number" ? formatByteSize(normalizedBytes) : "");
  const title = toBytesTitle(bytes);
  const interactive = !!title;
  const tooltipId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const showTooltip = interactive && open;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [open]);

  if (!displayValue) return null;

  const resolvedClassName = [
    className || "",
    interactive ? "cursor-pointer touch-manipulation underline decoration-dotted underline-offset-2" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const toggleTooltip = () => {
    if (!interactive) return;
    setOpen((current) => !current);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleTooltip();
      return;
    }
    if (event.key === "Escape") setOpen(false);
  };
  return (
    <span className="relative inline-flex items-center" ref={rootRef}>
      <Element
        aria-describedby={interactive && open ? tooltipId : undefined}
        aria-expanded={interactive ? open : undefined}
        className={resolvedClassName || undefined}
        data-size-bytes={interactive ? title : undefined}
        onBlur={() => setOpen(false)}
        onClick={interactive ? toggleTooltip : undefined}
        onKeyDown={interactive ? handleKeyDown : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
      >
        {displayValue}
      </Element>
      {interactive ? (
        <span
          aria-hidden={showTooltip ? "false" : "true"}
          className={[
            "pointer-events-none absolute top-full left-1/2 z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] px-1.5 py-0.5 font-['JetBrains_Mono','IBM_Plex_Mono','SFMono-Regular',monospace] text-[10px] leading-[1.3] text-[var(--rom-weaver-color-text)] shadow-sm transition-opacity duration-100",
            showTooltip ? "opacity-100" : "opacity-0",
          ].join(" ")}
          id={tooltipId}
          role="tooltip"
        >
          {title}
        </span>
      ) : null}
    </span>
  );
}

export { Size, toBytesTitle, toFiniteBytes };
