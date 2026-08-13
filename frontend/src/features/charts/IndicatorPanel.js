// IndicatorPanel.js
import React, { useState, useEffect, useRef } from "react";
import { INDICATOR_REGISTRY } from "../../indicators/indicatorRegistry";
import "./IndicatorPanel.css";

export default function IndicatorPanel({ indicators, onChange }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  // Only count boolean indicator toggles (not numeric params like bubbleGap)
  const enabledCount = INDICATOR_REGISTRY.filter((ind) => !!indicators[ind.id]).length;

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick, true);
    return () => document.removeEventListener("mousedown", handleOutsideClick, true);
  }, [open]);

  return (
    <div className="ind-panel" ref={panelRef}>
      <button
        className={`ind-trigger ${open ? "ind-trigger--open" : ""}`}
        onClick={() => setOpen((p) => !p)}
        title="Indicators"
      >
        <svg className="ind-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="14" y2="18" />
        </svg>
      </button>

      {open && (
        <div className="ind-dropdown">
          <div className="ind-dropdown-header">
            <span className="ind-dropdown-title">INDICATORS</span>
            <span className="ind-dropdown-count">
              {enabledCount} / {INDICATOR_REGISTRY.length} active
            </span>
          </div>

          <div className="ind-list">
            {INDICATOR_REGISTRY.map((ind) => {
              const enabled = !!indicators[ind.id];
              return (
                <div key={ind.id} className={`ind-row-wrap ${enabled ? "ind-row-wrap--on" : ""}`}>
                  {/* Main toggle row */}
                  <div
                    className={`ind-row ${enabled ? "ind-row--on" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Toggle ${ind.label}`}
                    onClick={() => onChange(ind.id, !enabled)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onChange(ind.id, !enabled);
                      }
                    }}
                  >
                    <span className="ind-row-left">
                      <span
                        className="ind-color-dot"
                        style={{ background: ind.color, opacity: enabled ? 1 : 0.3 }}
                      />
                      <span className="ind-row-info">
                        <span className="ind-row-label">{ind.label}</span>
                      </span>
                    </span>

                    {/* Inline extra input — shown between label and toggle when enabled */}
                    {ind.extraInput && enabled && (
                      <span
                        className="ind-extra-inline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="ind-extra-label">{ind.extraInput.label}</span>
                        <input
                          type="number"
                          className="ind-extra-input"
                          min={ind.extraInput.min}
                          max={ind.extraInput.max}
                          value={indicators[ind.extraInput.key] ?? ind.extraInput.defaultValue}
                          onChange={(e) => {
                            const v = Math.max(
                              ind.extraInput.min,
                              Math.min(ind.extraInput.max, Number(e.target.value) || ind.extraInput.defaultValue)
                            );
                            onChange(ind.extraInput.key, v);
                          }}
                        />
                      </span>
                    )}

                    <span
                      className={`ind-toggle ${enabled ? "ind-toggle--on" : ""}`}
                      role="switch"
                      aria-checked={enabled}
                    >
                      <span className="ind-toggle-thumb" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}