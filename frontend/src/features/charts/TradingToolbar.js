import React, { useState, useRef, useEffect, useCallback } from "react";
import "./TradingToolbar.css";

// ─── SVG Icon Components ───────────────────────────────────────────────────────
const icons = {
  cursor: (
    <svg viewBox="0 0 18 18" fill="currentColor">
      <path d="M3 1l12 7-5.5 1.5L8 15 3 1z" />
    </svg>
  ),
  trendline: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="15" x2="16" y2="3" strokeLinecap="round" />
      <circle cx="2" cy="15" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="3" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  horizontal: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="1" y1="9" x2="17" y2="9" strokeLinecap="round" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="3" y1="4" x2="15" y2="4" strokeLinecap="round" />
      <line x1="9" y1="4" x2="9" y2="14" strokeLinecap="round" />
      <line x1="6" y1="14" x2="12" y2="14" strokeLinecap="round" />
    </svg>
  ),
  draw: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 14 Q6 9 9 7 Q12 5 14 3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="3" cy="14" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  fibRetracement: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="1" y1="4" x2="17" y2="4" strokeLinecap="round" />
      <line x1="1" y1="9" x2="17" y2="9" strokeLinecap="round" strokeDasharray="2,1" />
      <line x1="1" y1="14" x2="17" y2="14" strokeLinecap="round" />
      <line x1="3" y1="4" x2="3" y2="14" strokeLinecap="round" />
    </svg>
  ),
  fibExtension: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="1" y1="2" x2="17" y2="2" strokeLinecap="round" />
      <line x1="1" y1="6" x2="17" y2="6" strokeLinecap="round" strokeDasharray="2,1" />
      <line x1="1" y1="10" x2="17" y2="10" strokeLinecap="round" strokeDasharray="2,1" />
      <line x1="1" y1="14" x2="17" y2="14" strokeLinecap="round" />
    </svg>
  ),
  fibCircle: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="9" cy="9" r="7" />
      <circle cx="9" cy="9" r="4" strokeDasharray="2,1" />
      <circle cx="9" cy="9" r="1.5" />
    </svg>
  ),
  fibTime: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="2" x2="2" y2="16" strokeLinecap="round" />
      <line x1="6" y1="2" x2="6" y2="16" strokeLinecap="round" strokeDasharray="2,1" />
      <line x1="11" y1="2" x2="11" y2="16" strokeLinecap="round" strokeDasharray="2,1" />
      <line x1="17" y1="2" x2="17" y2="16" strokeLinecap="round" strokeDasharray="2,1" />
    </svg>
  ),
  eye: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1,9 Q4,4 9,4 Q14,4 17,9 Q14,14 9,14 Q4,14 1,9Z" />
      <circle cx="9" cy="9" r="2.5" />
    </svg>
  ),
  eyeOff: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1,9 Q4,4 9,4 Q14,4 17,9 Q14,14 9,14 Q4,14 1,9Z" />
      <line x1="3" y1="3" x2="15" y2="15" strokeLinecap="round" />
    </svg>
  ),
  // Link chain icon — solid when linked, broken when not
  linkOn: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 11l-2 2a2.83 2.83 0 1 1-4-4l2-2" strokeLinecap="round" />
      <path d="M11 7l2-2a2.83 2.83 0 1 1 4 4l-2 2" strokeLinecap="round" />
      <line x1="6.5" y1="11.5" x2="11.5" y2="6.5" strokeLinecap="round" />
    </svg>
  ),
  linkOff: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 11l-2 2a2.83 2.83 0 1 1-4-4l2-2" strokeLinecap="round" strokeDasharray="2,1.5" />
      <path d="M11 7l2-2a2.83 2.83 0 1 1 4 4l-2 2" strokeLinecap="round" strokeDasharray="2,1.5" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="2" y1="5" x2="16" y2="5" strokeLinecap="round" />
      <path d="M7,5 L7,3 L11,3 L11,5" strokeLinecap="round" />
      <path d="M4,5 L4.5,15.5 A0.5,0.5,0,0,0,5,16 L13,16 A0.5,0.5,0,0,0,13.5,15.5 L14,5" strokeLinecap="round" />
      <line x1="7" y1="8" x2="7" y2="13" strokeLinecap="round" />
      <line x1="11" y1="8" x2="11" y2="13" strokeLinecap="round" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
      <polyline points="3,2 7,5 3,8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

// ─── Draw tool colour & thickness options ────────────────────────────────────
export const DRAW_COLORS = [
  { id: "white", label: "White", hex: "#e0e3eb" },
  { id: "blue", label: "Blue", hex: "#2962ff" },
  { id: "green", label: "Green", hex: "#26a69a" },
  { id: "black", label: "black", hex: "#00000000" },
];

// ─── Keyboard shortcut map ─────────────────────────────────────────────────────
export const TOOLBAR_SHORTCUTS = {
  "alt+a": "cursor",
  "escape": "cursor",
  "alt+t": "trendline",
  "alt+h": "horizontal",
  "alt+x": "text",
  "alt+d": "draw",
  "alt+j": "trendline",
  "alt+f": "fibRetracement",
};

// ─── Tool Group Definitions ───────────────────────────────────────────────────
const TOOL_GROUPS = [
  { id: "cursor", icon: icons.cursor, label: "Cursor — Pan Mode  (Esc / Alt+A)", subtools: [] },
  { id: "trendline", icon: icons.trendline, label: "Trend Line  (Alt+T)", subtools: [] },
  { id: "horizontal", icon: icons.horizontal, label: "Horizontal Line  (Alt+H)", subtools: [] },
  { id: "text", icon: icons.text, label: "Text  (Alt+X)", subtools: [] },
  { id: "draw", icon: icons.draw, label: "Freehand Draw  (Alt+D)", subtools: [], hasDraw: true },
  {
    id: "fibRetracement", icon: icons.fibRetracement, label: "Fib Retracement  (Alt+F)",
    subtools: [
      { id: "fibRetracement", icon: icons.fibRetracement, label: "Fib Retracement" },
      { id: "fibExtension", icon: icons.fibExtension, label: "Fib Extension" },
      { id: "fibCircle", icon: icons.fibCircle, label: "Fib Circles" },
      { id: "fibTime", icon: icons.fibTime, label: "Fib Time Zones" },
    ],
  },
  { id: "divider1", divider: true },
  { id: "hide", icon: icons.eye, label: "Hide / Show All Drawings", toggle: true, subtools: [] },
  // "link" is always injected here (below eye, above trash) for multi-panel sync
  { id: "divider2", divider: true },
  { id: "trash", icon: icons.trash, label: "Remove All Drawings", action: true, danger: true, subtools: [] },
];

// ─── SubDrawer ────────────────────────────────────────────────────────────────
function SubDrawer({ group, position, selectedTool, onSelect, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className="tv-subdrawer" ref={ref} style={{ top: Math.max(0, position) }}>
      <div className="tv-subdrawer-label">{group.label}</div>
      {group.subtools.map((tool) => (
        <button
          key={tool.id}
          className={`tv-subdrawer-btn ${selectedTool === tool.id ? "active" : ""}`}
          onClick={() => { onSelect(tool.id); onClose(); }}
          title={tool.label}
        >
          <span className="tv-subdrawer-icon">{tool.icon}</span>
          <span className="tv-subdrawer-text">{tool.label}</span>
          {selectedTool === tool.id && <span className="tv-subdrawer-check">✓</span>}
        </button>
      ))}
    </div>
  );
}

// ─── DrawOptionsPanel ─────────────────────────────────────────────────────────
function DrawOptionsPanel({ position, drawColor, onColorChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className="tv-draw-options" ref={ref} style={{ top: Math.max(0, position) }}>
      <div className="tv-subdrawer-label">Draw Colour</div>
      <div className="tv-draw-colors">
        {DRAW_COLORS.map((c) => (
          <button
            key={c.id}
            className={`tv-draw-color-btn ${drawColor === c.id ? "active" : ""}`}
            style={{ background: c.hex }}
            onClick={() => onColorChange(c.id)}
            title={c.label}
          />
        ))}
      </div>
    </div>
  );
}

// ─── SR icon ──────────────────────────────────────────────────────────────────
const srIcon = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <line x1="1" y1="4" x2="13" y2="4" strokeLinecap="round" />
    <line x1="1" y1="10" x2="13" y2="10" strokeLinecap="round" />
    <line x1="1" y1="7" x2="4" y2="7" strokeLinecap="round" strokeDasharray="1.5,1.5" />
    <line x1="10" y1="7" x2="13" y2="7" strokeLinecap="round" strokeDasharray="1.5,1.5" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// ─── Main Toolbar ──────────────────────────────────────────────────────────────
export default function TradingToolbar({
  selectedTool,
  setSelectedTool,
  drawingsHidden,
  onToggleHide,
  onTrashAll,
  srLines = [],
  onDrawSRLines,
  srLinesDrawn = false,
  drawColor,
  setDrawColor,
  // Link sync props — link button always visible; panelCount kept for back-compat
  panelCount = 1,
  linked = false,
  onLinkToggle,
}) {
  const [openDrawer, setOpenDrawer] = useState(null);
  const [drawerPos, setDrawerPos] = useState(0);

  const [groupPrimary, setGroupPrimary] = useState(() => {
    const map = {};
    TOOL_GROUPS.forEach((g) => {
      if (!g.divider && g.subtools?.length > 0) map[g.id] = g.subtools[0].id;
    });
    return map;
  });

  const btnRefs = useRef({});
  const toolbarRef = useRef(null);

  // Build final tool list — always inject link tool (after "hide", before divider2)
  const toolList = React.useMemo(() => {
    const result = [];
    for (const g of TOOL_GROUPS) {
      result.push(g);
      if (g.id === "hide") {
        result.push({ id: "link", isLink: true });
      }
    }
    return result;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const key = e.key.toLowerCase();
      let toolId = null;
      if (key === "escape") toolId = "cursor";
      else if (e.altKey && !e.ctrlKey && !e.shiftKey) toolId = TOOLBAR_SHORTCUTS["alt+" + key] || null;
      if (!toolId) return;
      e.preventDefault();
      const group = TOOL_GROUPS.find((g) => !g.divider && (g.id === toolId || g.subtools?.some((s) => s.id === toolId)));
      if (!group) return;
      if (group.id !== toolId) setGroupPrimary((prev) => ({ ...prev, [group.id]: toolId }));
      setSelectedTool(toolId === group.id && group.subtools?.length > 0 ? (groupPrimary[group.id] || group.subtools[0].id) : toolId);
      setOpenDrawer(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSelectedTool, groupPrimary]);

  const findGroupForTool = useCallback((toolId) => TOOL_GROUPS.find((g) => !g.divider && g.subtools?.some((st) => st.id === toolId)), []);

  const getGroupIcon = useCallback((group) => {
    if (group.id === "hide") return drawingsHidden ? icons.eyeOff : icons.eye;
    const primaryId = groupPrimary[group.id];
    if (primaryId) { const st = group.subtools.find((s) => s.id === primaryId); if (st) return st.icon; }
    return group.icon;
  }, [groupPrimary, drawingsHidden]);

  const isGroupActive = useCallback((group) => {
    if (group.id === "hide") return drawingsHidden;
    if (!group.subtools || group.subtools.length === 0) return selectedTool === group.id;
    const primaryId = groupPrimary[group.id] || group.subtools?.[0]?.id;
    return selectedTool === primaryId;
  }, [selectedTool, groupPrimary, drawingsHidden]);

  const openPanelAt = useCallback((groupId) => {
    const btn = btnRefs.current[groupId];
    const toolbar = toolbarRef.current;
    if (btn && toolbar) {
      const btnRect = btn.getBoundingClientRect();
      const tbRect = toolbar.getBoundingClientRect();
      setDrawerPos(btnRect.top - tbRect.top);
    }
    setOpenDrawer(groupId);
  }, []);

  const handleMainClick = useCallback((group) => {
    if (group.divider) return;
    if (group.id === "hide") { if (onToggleHide) onToggleHide(); setOpenDrawer(null); return; }
    if (group.id === "trash") { if (onTrashAll) onTrashAll(); setOpenDrawer(null); return; }
    if (group.hasDraw) {
      setSelectedTool("draw");
      openDrawer === "draw" ? setOpenDrawer(null) : openPanelAt("draw");
      return;
    }
    if (group.subtools.length === 0) { setSelectedTool(group.id); setOpenDrawer(null); return; }
    if (openDrawer === group.id) { setOpenDrawer(null); return; }
    const primaryToolId = groupPrimary[group.id] || group.subtools?.[0]?.id;
    if (primaryToolId) setSelectedTool(primaryToolId);
    openPanelAt(group.id);
  }, [openDrawer, onToggleHide, onTrashAll, groupPrimary, setSelectedTool, openPanelAt]);

  const handleChevronClick = useCallback((group, e) => {
    e.stopPropagation();
    if (group.hasDraw) { openDrawer === "draw" ? setOpenDrawer(null) : openPanelAt("draw"); return; }
    if (group.subtools.length === 0) return;
    openDrawer === group.id ? setOpenDrawer(null) : openPanelAt(group.id);
  }, [openDrawer, openPanelAt]);

  const handleSubSelect = useCallback((groupId, toolId) => {
    setGroupPrimary((prev) => ({ ...prev, [groupId]: toolId }));
    setSelectedTool(toolId);
  }, [setSelectedTool]);

  useEffect(() => {
    const group = findGroupForTool(selectedTool);
    if (group) setGroupPrimary((prev) => ({ ...prev, [group.id]: selectedTool }));
  }, [selectedTool, findGroupForTool]);

  const activeGroup = openDrawer ? TOOL_GROUPS.find((g) => g.id === openDrawer) : null;

  return (
    <div className="tv-toolbar" ref={toolbarRef}>
      {toolList.map((group) => {
        // Divider
        if (group.divider) return <div key={group.id} className="tv-toolbar-divider" />;

        // ── Link toggle button ──────────────────────────────────────────────
        if (group.isLink) {
          return (
            <div
              key="link"
              className={`tv-tool-wrap ${linked ? "active" : ""}`}
              title={linked ? "Unlink drawings from other panels (same symbol)" : "Link drawings — syncs to panels with same symbol"}
            >
              <button
                ref={(el) => (btnRefs.current["link"] = el)}
                className={`tv-tool-btn tv-link-btn ${linked ? "active" : ""}`}
                onClick={() => onLinkToggle && onLinkToggle(!linked)}
                title={linked ? "Linked — drawings sync to same-symbol panels" : "Click to link drawings across same-symbol panels"}
              >
                <span className="tv-tool-icon">
                  {linked ? icons.linkOn : icons.linkOff}
                </span>
              </button>
            </div>
          );
        }

        // ── Regular tool ────────────────────────────────────────────────────
        const active = isGroupActive(group);
        const hasChevron = (group.subtools && group.subtools.length > 0) || group.hasDraw;
        const drawerOpen = openDrawer === group.id;

        return (
          <div key={group.id} className={`tv-tool-wrap ${active ? "active" : ""} ${drawerOpen ? "drawer-open" : ""}`}>
            <button
              ref={(el) => (btnRefs.current[group.id] = el)}
              className={`tv-tool-btn ${active ? "active" : ""} ${group.danger ? "danger" : ""}`}
              onClick={() => handleMainClick(group)}
              title={group.label}
            >
              <span className="tv-tool-icon">{getGroupIcon(group)}</span>
            </button>

            {hasChevron && (
              <button
                className={`tv-chevron-btn ${drawerOpen ? "open" : ""}`}
                onClick={(e) => handleChevronClick(group, e)}
                title={group.hasDraw ? "Draw options" : `${group.label} options`}
              >
                {icons.chevronRight}
              </button>
            )}
          </div>
        );
      })}

      {/* Subdrawer flyout (fib etc.) */}
      {activeGroup && !activeGroup.hasDraw && activeGroup.subtools.length > 0 && (
        <SubDrawer
          group={activeGroup}
          position={drawerPos}
          selectedTool={selectedTool}
          onSelect={(toolId) => handleSubSelect(activeGroup.id, toolId)}
          onClose={() => setOpenDrawer(null)}
        />
      )}

      {/* Draw options panel */}
      {openDrawer === "draw" && (
        <DrawOptionsPanel
          position={drawerPos}
          drawColor={drawColor}
          onColorChange={setDrawColor}
          onClose={() => setOpenDrawer(null)}
        />
      )}

      {/* S&R button */}
      {srLines.length > 0 && onDrawSRLines && (
        <>
          <div className="tv-toolbar-divider" />
          <button
            className={`tv-sr-draw-btn ${srLinesDrawn ? "active" : ""}`}
            onClick={onDrawSRLines}
            title={srLinesDrawn ? "Clear S&R lines from chart" : "Draw S&R levels on chart"}
          >
            {srIcon}
          </button>
        </>
      )}
    </div>
  );
}