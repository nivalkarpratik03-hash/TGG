/**
 * LayoutPicker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layout picker dropdown and layout icon SVG component.
 * Previously defined inside ChartsPage.js and exported from there (wrong).
 *
 * Consumers:
 *   StatusBar.js  → imports LayoutPicker
 *   ChartsPage.js → imports LAYOUTS, LayoutPicker
 */
import React, { useState, useEffect, useRef } from "react";

// ─── Layout definitions ───────────────────────────────────────────────────────
// Single source of truth — imported by ChartsPage and LayoutPicker both.
export const LAYOUTS = [
  { id: "1", label: "Single", cols: 1, rows: 1, panels: 1, icon: "1x1" },
  { id: "2h", label: "2 Side-by-Side", cols: 2, rows: 1, panels: 2, icon: "2h" },
  { id: "2v", label: "2 Stacked", cols: 1, rows: 2, panels: 2, icon: "2v" },
  { id: "3h", label: "3 Side-by-Side", cols: 3, rows: 1, panels: 3, icon: "3h" },
  { id: "3", label: "3 Panels", cols: 2, rows: 2, panels: 3, icon: "3" },
  { id: "4", label: "4 Panels", cols: 2, rows: 2, panels: 4, icon: "4" },
];

// ─── LayoutIcon — SVG thumbnail of each layout shape ─────────────────────────
export function LayoutIcon({ icon, size = 18 }) {
  const s = size, p = 2, gap = 2;
  const inner = s - p * 2;
  const half = (inner - gap) / 2;
  switch (icon) {
    case "1x1":
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none"><rect x={p} y={p} width={inner} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} /></svg>;
    case "2h":
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={p} y={p} width={half} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + half + gap} y={p} width={half} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
      </svg>;
    case "2v":
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={p} y={p} width={inner} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p} y={p + half + gap} width={inner} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
      </svg>;
    case "3h": {
      const third = (inner - gap * 2) / 3;
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={p} y={p} width={third} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + third + gap} y={p} width={third} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + (third + gap) * 2} y={p} width={third} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
      </svg>;
    }
    case "3":
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={p} y={p} width={half} height={inner} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + half + gap} y={p} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + half + gap} y={p + half + gap} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
      </svg>;
    case "4":
      return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <rect x={p} y={p} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + half + gap} y={p} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p} y={p + half + gap} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
        <rect x={p + half + gap} y={p + half + gap} width={half} height={half} rx={1.5} stroke="currentColor" strokeWidth={1.5} />
      </svg>;
    default: return null;
  }
}

// ─── LayoutPicker dropdown ────────────────────────────────────────────────────
export function LayoutPicker({ currentLayout, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = LAYOUTS.find((l) => l.id === currentLayout) || LAYOUTS[0];

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Change layout"
        style={{
          display: "flex", alignItems: "center", gap: 5,
          background: open ? "var(--accent-dim)" : "var(--bg3)",
          border: `1px solid ${open ? "var(--accent)" : "var(--border2)"}`,
          borderRadius: 5,
          color: open ? "var(--accent)" : "var(--text2)",
          fontFamily: "var(--font-mono)",
          fontSize: 11, fontWeight: 700,
          padding: "3px 10px",
          cursor: "pointer",
          letterSpacing: "0.04em",
          flexShrink: 0,
          transition: "background 0.15s, color 0.15s, border-color 0.15s",
        }}
      >
        <LayoutIcon icon={current.icon} size={15} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0,
          background: "var(--bg3)", border: "1px solid var(--border2)",
          borderRadius: 8, zIndex: 9999, padding: 10,
          boxShadow: "0 8px 32px var(--shadow)", minWidth: 210,
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 8 }}>
            Select Layout
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {LAYOUTS.map((layout) => {
              const active = layout.id === currentLayout;
              return (
                <button
                  key={layout.id}
                  onClick={() => { onSelect(layout.id); setOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    background: active ? "var(--accent-dim)" : "transparent",
                    border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
                    borderRadius: 5,
                    color: active ? "var(--accent)" : "var(--text2)",
                    padding: "6px 10px", cursor: "pointer", textAlign: "left",
                    fontFamily: "var(--font-mono)", fontSize: 11, width: "100%",
                    fontWeight: active ? 700 : 400,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "var(--bg2)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text2)"; } }}
                >
                  <span style={{ flexShrink: 0, color: active ? "var(--accent)" : "var(--text3)" }}>
                    <LayoutIcon icon={layout.icon} size={17} />
                  </span>
                  <span>{layout.label}</span>
                  {active && (
                    <svg style={{ marginLeft: "auto", flexShrink: 0 }} width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1.5 5l2.5 2.5L8.5 2" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}