// DrawingContext.js
// Symbol-based drawing sync between linked panels.
// Each panel can toggle "linked" ON/OFF.
// When ON, any drawing added/changed is mirrored to ALL other panels
// that share the same symbol AND also have linking ON.
//
// CHANGES:
// 1. setAllLinked(val) — links/unlinks ALL registered panels at once (one-click link)
// 2. When a panel unlinks, its sharedDrawings are "absorbed" into local storage
//    so drawn lines stay visible and are not removed.
// 3. Unlink is fully synchronous — absorb + registry + localStorage all happen
//    before any React state update, so there's no render cascade lag.

import { createContext, useContext, useCallback, useRef, useState, useEffect } from "react";

// ─── Module-level registry (survives re-renders) ──────────────────────────────
// _panels: Map<panelId, { symbol, linked, notify, absorbShared, setLinkedState, storageKey }>
const _panels = new Map();

// Broadcast drawings to all panels sharing the same symbol (except the sender)
function broadcastDrawings(senderId, symbol, drawings) {
  _panels.forEach((entry, id) => {
    if (id === senderId) return;
    if (!entry.linked) return;
    if (entry.symbol !== symbol) return;
    entry.notify([...drawings]);
  });
}

// Link or unlink ALL panels at once — synchronous, no cascade
export function setAllLinked(val) {
  _panels.forEach((entry) => {
    // 1. Absorb shared drawings into local before clearing (only on unlink)
    if (!val && entry.absorbShared) {
      entry.absorbShared();
    }
    // 2. Update registry immediately (sync) so no stale linked state
    entry.linked = val;
    // 3. Persist to localStorage (sync)
    try { localStorage.setItem(entry.storageKey, JSON.stringify(val)); } catch { }
    // 4. Trigger React state update (one per panel, batched by React 18)
    if (entry.setLinkedState) entry.setLinkedState(val);
  });
}

// ─── Context ──────────────────────────────────────────────────────────────────
const DrawingContext = createContext(null);

export function DrawingProvider({ children }) {
  return (
    <DrawingContext.Provider value={{}}>
      {children}
    </DrawingContext.Provider>
  );
}

export function useDrawingContext() {
  return useContext(DrawingContext);
}

// ─── Hook for a panel to participate in symbol-based link sync ────────────────
export function usePanelLink(panelId, symbol) {
  const storageKey = "tgg_linked_" + panelId;
  const [linked, setLinkedState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey)) === true; } catch { return false; }
  });
  const [sharedDrawings, setSharedDrawings] = useState([]);
  const linkedRef = useRef(linked);
  const symbolRef = useRef(symbol);
  const absorbSharedRef = useRef(null);

  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { linkedRef.current = linked; }, [linked]);

  // Register / update this panel in the global registry
  useEffect(() => {
    _panels.set(panelId, {
      symbol,
      linked,
      storageKey,
      notify: (drawings) => setSharedDrawings(drawings),
      absorbShared: () => { if (absorbSharedRef.current) absorbSharedRef.current(); },
      setLinkedState,
    });
    return () => { _panels.delete(panelId); };
  }, [panelId, symbol, linked, storageKey]);

  // Per-panel setLinked — also synchronous
  const setLinked = useCallback((val) => {
    if (!val && absorbSharedRef.current) {
      absorbSharedRef.current();
    }
    linkedRef.current = val;
    try { localStorage.setItem(storageKey, JSON.stringify(val)); } catch { }
    // Update registry immediately
    const existing = _panels.get(panelId);
    if (existing) existing.linked = val;
    setLinkedState(val);
  }, [panelId, storageKey]);

  const publishDrawings = useCallback((drawings) => {
    if (!linkedRef.current) return;
    broadcastDrawings(panelId, symbolRef.current, drawings);
  }, [panelId]);

  const setAbsorbShared = useCallback((fn) => {
    absorbSharedRef.current = fn;
  }, []);

  return { linked, setLinked, sharedDrawings, setSharedDrawings, publishDrawings, setAbsorbShared };
}