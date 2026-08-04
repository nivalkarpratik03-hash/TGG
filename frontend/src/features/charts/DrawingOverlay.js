// DrawingOverlay.js
// SVG drawing overlay for lightweight-charts.
// Tools: trendline, horizontal, fibRetracement, text, draw (freehand)
// Features:
//   - Ctrl+Z: undo last drawing
//   - Delete key on hovered drawing: delete that drawing
//   - Hover works in BOTH cursor mode and drawing mode
//   - Fib: time+price anchored, stretches with zoom/scroll like Fyers
//   - Fib drag: fully window-level so it works regardless of SVG pointerEvents state
//   - Drawings stored in {time, price} coordinates — move with chart on pan/zoom
//   - Link sync: when linkColor is set, linked drawings are shared with other panels

import React, {
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
  useCallback,
} from "react";
import { DRAW_COLORS } from "./TradingToolbar";
import { getTimeframeColor } from "../../utils/timeframeColors";
import {
  HIT_SLOP, FIB_LEVELS,
  distToSegment, uid,
  loadDrawings, saveDrawings, buildDrawing,
} from "./drawingUtils";
import { FreehandPreview, LivePreview, DrawingShape } from "./DrawingShapes";

// ─── Component ────────────────────────────────────────────────────────────────
const DrawingOverlay = forwardRef(function DrawingOverlay(
  {
    chartRef,
    candleSeriesRef,
    selectedTool,
    setSelectedTool,
    containerRef,
    hidden,
    drawColor = "white",
    drawThickness = 1,
    lastBarTime = null,
    secondLastBarTime = null,
    onContextMenu = null,
    // Drawing sync props
    linkColor = null,
    sharedDrawings = [],
    onPublishDrawings = null,
    setAbsorbShared = null,
    onClearSharedDrawings = null,
    // Panel activation — only active panel accepts new drawing input
    isActivePanel = true,
    onPanelActivate = null,
    // Per-panel storage key for drawings isolation
    panelKey = "",
    // Current chart resolution (minutes) — used to colour manual fib with the TF colour
    resolution = null,
    // ── Synced crosshair across panels ──────────────────────────────────────
    syncedCrosshairPrice = null,
    onSyncCrosshair = null,
  },
  ref
) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Local (private) drawings — loaded from localStorage
  const localDrawingsRef = useRef(loadDrawings(panelKey));
  const [localDrawings, setLocalDrawings] = useState(localDrawingsRef.current);

  const [pendingText, setPendingText] = useState(null);
  const pendingTextRef = useRef(null);
  const textInputRef = useRef(null);

  // freehand draw state
  const freehandRef = useRef({ active: false, points: [] });
  const [freehandPreview, setFreehandPreview] = useState(null);

  // keep a ref so event handlers always see the latest color
  const drawColorRef = useRef(drawColor);
  useEffect(() => { drawColorRef.current = drawColor; }, [drawColor]);

  // keep a ref so the window-level mouseup always sees the current resolution
  const resolutionRef = useRef(resolution);
  useEffect(() => { resolutionRef.current = resolution; }, [resolution]);

  // keep a ref to linkColor
  const linkColorRef = useRef(linkColor);
  useEffect(() => { linkColorRef.current = linkColor; }, [linkColor]);

  // keep a ref to onPanelActivate so event handlers don't go stale
  const onPanelActivateRef = useRef(onPanelActivate);
  useEffect(() => { onPanelActivateRef.current = onPanelActivate; }, [onPanelActivate]);

  // ── All drawings = local (unlinked) + shared (linked, from context) ────────
  // Local drawings that are NOT linked to any group
  // + sharedDrawings from the link group
  // When linked, newly created drawings get flagged {linked:true} and are published
  const allDrawings = [
    ...localDrawingsRef.current.filter((d) => !d.linked),
    ...sharedDrawings,
  ];

  const NUDGE_STEP = 0.05;

  // commitLocalDrawings — saves and re-renders local drawings
  const commitLocalDrawings = useCallback((next) => {
    localDrawingsRef.current = next;
    saveDrawings(next, panelKey);
    setLocalDrawings([...next]);
  }, [panelKey]);

  // publishLinked — after adding a linked drawing, broadcast to group
  const publishLinked = useCallback((allLocal) => {
    const linked = allLocal.filter((d) => d.linked);
    if (onPublishDrawings) onPublishDrawings(linked, false);
  }, [onPublishDrawings]);

  // ── Absorb shared drawings into local on unlink ──────────────────────────
  const sharedDrawingsRef = useRef(sharedDrawings);
  sharedDrawingsRef.current = sharedDrawings;

  useEffect(() => {
    if (!setAbsorbShared) return;
    setAbsorbShared(() => {
      const shared = sharedDrawingsRef.current;
      if (!shared || shared.length === 0) return;
      const existingIds = new Set(localDrawingsRef.current.map((d) => d.id));
      const toAbsorb = shared
        .filter((d) => !existingIds.has(d.id))
        .map((d) => ({ ...d, linked: false }));
      if (toAbsorb.length === 0) return;
      const merged = [...localDrawingsRef.current, ...toAbsorb];
      commitLocalDrawings(merged);
      if (onClearSharedDrawings) onClearSharedDrawings();
    });
  }, [setAbsorbShared, commitLocalDrawings, onClearSharedDrawings]);



  // ── New-drawing drag ────────────────────────────────────────────────────────
  const dragRef = useRef({ active: false, tool: null, start: null, current: null });

  // ── Edit drag for fib ───────────────────────────────────────────────────────
  const editDragRef = useRef({
    active: false, id: null, mode: null,
    startCoord: null, origP1: null, origP2: null,
    isShared: false,
  });

  const [hoveredId, setHoveredId] = useState(null);
  const hoveredIdRef = useRef(null);

  const [selectedHLineId, setSelectedHLineId] = useState(null);

  // ── Synced crosshair ref (always-current) ────────────────────────────────
  const onSyncCrosshairRef = useRef(onSyncCrosshair);
  useEffect(() => { onSyncCrosshairRef.current = onSyncCrosshair; }, [onSyncCrosshair]);
  const selectedHLineIdRef = useRef(null);
  const setSelectedHL = (id) => {
    selectedHLineIdRef.current = id;
    setSelectedHLineId(id);
  };

  const coordToDataRef = useRef(null);
  const dataToCoordRef = useRef(null);
  const hitTestRef = useRef(null);
  const fibHitDetailRef = useRef(null);

  // ── Coordinate helpers ───────────────────────────────────────────────────

  const getPxPerBar = useCallback(() => {
    try {
      const ts = chartRef.current?.timeScale();
      if (!ts || lastBarTime == null || secondLastBarTime == null) return null;
      const x1 = ts.timeToCoordinate(secondLastBarTime);
      const x2 = ts.timeToCoordinate(lastBarTime);
      if (x1 == null || x2 == null) return null;
      const diff = Math.abs(x2 - x1);
      return diff > 0 ? diff : null;
    } catch { return null; }
  }, [chartRef, lastBarTime, secondLastBarTime]);

  const coordToData = useCallback((x, y) => {
    try {
      const ts = chartRef.current?.timeScale();
      let time = ts?.coordinateToTime(x) ?? null;
      let barOffset = null;

      // x is past the last candle — coordinateToTime returns null here.
      // Compute barOffset = how many bars to the right of lastBarTime.
      if (time == null && ts != null && lastBarTime != null) {
        try {
          const anchorX = ts.timeToCoordinate(lastBarTime);
          const pxPerBar = getPxPerBar();
          if (anchorX != null && pxPerBar != null && pxPerBar > 0) {
            barOffset = (x - anchorX) / pxPerBar;
          }
        } catch { /* stays null */ }
      }

      const price = candleSeriesRef.current?.coordinateToPrice(y) ?? null;
      return { x, y, time, price, barOffset };
    } catch { return { x, y, time: null, price: null, barOffset: null }; }
  }, [chartRef, candleSeriesRef, lastBarTime, getPxPerBar]);

  const dataToCoord = useCallback((time, price, barOffset = null) => {
    try {
      const ts = chartRef.current?.timeScale();
      let x = null;

      if (time == null && barOffset != null && ts != null && lastBarTime != null) {
        // Future point: anchor to lastBarTime pixel + barOffset × current pxPerBar
        const anchorX = ts.timeToCoordinate(lastBarTime);
        const pxPerBar = getPxPerBar();
        if (anchorX != null && pxPerBar != null) {
          x = anchorX + barOffset * pxPerBar;
        }
      } else if (time != null) {
        x = ts?.timeToCoordinate(time) ?? null;
      }

      const y = price != null ? candleSeriesRef.current?.priceToCoordinate(price) : null;
      return { x, y };
    } catch { return { x: null, y: null }; }
  }, [chartRef, candleSeriesRef, lastBarTime, getPxPerBar]);

  useEffect(() => { coordToDataRef.current = coordToData; }, [coordToData]);
  useEffect(() => { dataToCoordRef.current = dataToCoord; }, [dataToCoord]);

  // Repaint when chart scrolls/zooms — drawings follow the price/time axes
  useEffect(() => {
    if (!chartRef.current) return;
    const repaint = () => {
      setLocalDrawings((d) => [...d]);
    };
    chartRef.current.timeScale().subscribeVisibleLogicalRangeChange(repaint);
    chartRef.current.subscribeCrosshairMove(repaint);
    return () => {
      try {
        chartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(repaint);
        chartRef.current?.unsubscribeCrosshairMove(repaint);
      } catch { }
    };
  }, [chartRef]);

  // Repaint when the panel container is resized (panel divider drag, window resize,
  // layout change) — without this, drawings stay at stale pixel coordinates while
  // the SVG stretches to fill the new size, making fibs appear shifted/wrong.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setLocalDrawings((d) => [...d]);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // ── Hit test (works on both local and shared drawings) ───────────────────
  const hitTest = useCallback((drawing, px, py) => {
    const dtc = dataToCoordRef.current;
    if (!dtc) return false;
    try {
      if (drawing.type === "trendline") {
        const c1 = dtc(drawing.p1.time, drawing.p1.price, drawing.p1.barOffset ?? null);
        const c2 = dtc(drawing.p2.time, drawing.p2.price, drawing.p2.barOffset ?? null);
        if (c1.y == null || c2.y == null) return false;
        const x1 = c1.x ?? drawing.p1.px ?? null;
        const x2 = c2.x ?? drawing.p2.px ?? null;
        if (x1 == null || x2 == null) return false;
        return distToSegment(px, py, x1, c1.y, x2, c2.y) < HIT_SLOP;
      }
      if (drawing.type === "horizontal") {
        const c = dtc(null, drawing.price);
        if (c.y == null) return false;
        return Math.abs(py - c.y) < HIT_SLOP;
      }
      if (drawing.type === "fibRetracement") {
        const c1 = dtc(drawing.p1.time, drawing.p1.price, drawing.p1.barOffset ?? null);
        const c2 = dtc(drawing.p2.time, drawing.p2.price, drawing.p2.barOffset ?? null);
        const ax1 = c1.x ?? drawing.p1.px ?? null;
        const ax2 = c2.x ?? drawing.p2.px ?? null;
        if (ax1 == null && ax2 == null) return false;
        const bx1 = Math.min(ax1 ?? 0, ax2 ?? 0);
        const bx2 = Math.max(ax1 ?? 0, ax2 ?? 0);
        if (px < bx1 || px > bx2) return false;
        const priceRange = drawing.p2.price - drawing.p1.price;
        for (const lvl of FIB_LEVELS) {
          const price = drawing.p1.price + priceRange * lvl.ratio;
          const c = dtc(null, price);
          if (c.y != null && Math.abs(py - c.y) < HIT_SLOP) return true;
        }
        return false;
      }
      if (drawing.type === "text") {
        const c = dtc(drawing.time, drawing.price);
        const cx = c.x ?? drawing.x;
        const cy = c.y ?? drawing.y;
        if (cx == null || cy == null) return false;
        const textW = (drawing.content?.length ?? 4) * 8 + 16;
        const textH = 22;
        return px >= cx - 4 && px <= cx + textW && py >= cy - textH && py <= cy + 4;
      }
      if (drawing.type === "freehand" && drawing.points?.length > 1) {
        // Reproject time+price to current pixel coords for accurate hit-test
        const projPts = drawing.points.map((p) => {
          if (p.time != null && p.price != null) {
            const c = dtc(p.time, p.price);
            return { x: c.x ?? p.x, y: c.y ?? p.y };
          }
          return { x: p.x, y: p.y };
        });
        for (let i = 0; i < projPts.length - 1; i++) {
          const p1 = projPts[i];
          const p2 = projPts[i + 1];
          if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) < HIT_SLOP) return true;
        }
        return false;
      }
    } catch { }
    return false;
  }, []); // dataToCoordRef is a ref — no dep needed

  useEffect(() => { hitTestRef.current = hitTest; }, [hitTest]);

  // ── Fib hit detail ───────────────────────────────────────────────────────
  const fibHitDetail = useCallback((drawing, px, py) => {
    if (drawing.type !== "fibRetracement") return null;
    const dtc = dataToCoordRef.current;
    if (!dtc) return null;
    const c1 = dtc(drawing.p1.time, drawing.p1.price, drawing.p1.barOffset ?? null);
    const c2 = dtc(drawing.p2.time, drawing.p2.price, drawing.p2.barOffset ?? null);
    const ax1 = c1.x ?? drawing.p1.px ?? null;
    const ax2 = c2.x ?? drawing.p2.px ?? null;
    if (ax1 != null && Math.hypot(px - ax1, py - (c1.y ?? 0)) < 12) return "p1";
    if (ax2 != null && Math.hypot(px - ax2, py - (c2.y ?? 0)) < 12) return "p2";
    if (ax1 == null && ax2 == null) return null;
    const bx1 = Math.min(ax1 ?? 0, ax2 ?? 0);
    const bx2 = Math.max(ax1 ?? 0, ax2 ?? 0);
    if (px < bx1 || px > bx2) return null;
    const priceRange = drawing.p2.price - drawing.p1.price;
    for (const lvl of FIB_LEVELS) {
      const price = drawing.p1.price + priceRange * lvl.ratio;
      const c = dtc(null, price);
      if (c.y != null && Math.abs(py - c.y) < HIT_SLOP) return "body";
    }
    return null;
  }, []);

  useEffect(() => { fibHitDetailRef.current = fibHitDetail; }, [fibHitDetail]);

  // ── Delete a drawing ──────────────────────────────────────────────────────
  const deleteDrawing = useCallback((id, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    hoveredIdRef.current = null;
    setHoveredId(null);
    // Try local first, then shared (shared can only be removed from their own panel)
    const nextLocal = localDrawingsRef.current.filter((d) => d.id !== id);
    commitLocalDrawings(nextLocal);
    publishLinked(nextLocal);
  }, [commitLocalDrawings, publishLinked]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const isActivePanelRef = useRef(isActivePanel);
  useEffect(() => { isActivePanelRef.current = isActivePanel; }, [isActivePanel]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (!isActivePanelRef.current) return;

      if (e.key === "Escape") {
        if (selectedHLineIdRef.current != null) {
          e.preventDefault();
          setSelectedHL(null);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        if (localDrawingsRef.current.length === 0) return;
        hoveredIdRef.current = null;
        setHoveredId(null);
        setSelectedHL(null);
        const next = localDrawingsRef.current.slice(0, -1);
        commitLocalDrawings(next);
        publishLinked(next);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        const target = selectedHLineIdRef.current ?? hoveredIdRef.current;
        if (target == null) return;
        e.preventDefault();
        setSelectedHL(null);
        deleteDrawing(target);
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const hid = selectedHLineIdRef.current;
        if (hid == null) return;
        const sel = localDrawingsRef.current.find((d) => d.id === hid);
        if (!sel || sel.type !== "horizontal") return;
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        const snapped = Math.round(sel.price / NUDGE_STEP) * NUDGE_STEP;
        const newPrice = snapped + NUDGE_STEP * dir;
        const next = localDrawingsRef.current.map((d) =>
          d.id === hid ? { ...d, price: Math.round(newPrice * 1e6) / 1e6 } : d
        );
        commitLocalDrawings(next);
        publishLinked(next);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commitLocalDrawings, deleteDrawing, publishLinked, isActivePanel]);

  // ── Text commit ───────────────────────────────────────────────────────────
  const commitTextInput = useCallback((value) => {
    const pt = pendingTextRef.current;
    if (!pt) return;
    setPendingText(null);
    pendingTextRef.current = null;
    if (!value || !value.trim()) return;
    const linked = !!linkColorRef.current;
    const newDrawing = {
      id: uid(), type: "text", content: value.trim(),
      price: pt.price, time: pt.time, x: pt.x, y: pt.y,
      fontSize: 13, color: "var(--text)",
      linked,
    };
    const next = [...localDrawingsRef.current, newDrawing];
    commitLocalDrawings(next);
    publishLinked(next);
    // Auto-return to cursor after placing text
    if (setSelectedTool) setSelectedTool("cursor");
  }, [commitLocalDrawings, publishLinked, setSelectedTool]);

  useEffect(() => {
    if (pendingText && textInputRef.current) setTimeout(() => textInputRef.current?.focus(), 30);
  }, [pendingText]);

  // ── SVG-relative coords from a MouseEvent ────────────────────────────────
  const svgRelCoord = useCallback((e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // ── All drawings for hit-testing (local unlinked + shared) ───────────────
  const getAllDrawingsForHit = useCallback(() => {
    return [
      ...localDrawingsRef.current.filter((d) => !d.linked),
      ...sharedDrawings,
      ...localDrawingsRef.current.filter((d) => d.linked),
    ];
  }, [sharedDrawings]);

  // ────────────────────────────────────────────────────────────────────────────
  // WINDOW-LEVEL MOUSE HANDLERS
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    function onWindowMouseDown(e) {
      if (e.button !== 0) return;
      if (hidden) return;
      const selectedToolVal = selectedToolRef.current;
      if (selectedToolVal !== "cursor") return;
      // Don't interfere if a drawing drag is already in progress
      if (dragRef.current.active || freehandRef.current.active) return;

      const { x, y } = svgRelCoord(e);
      const allForHit = getAllDrawingsForHit();

      let hitId = null;
      for (const d of allForHit) {
        if (hitTestRef.current?.(d, x, y)) { hitId = d.id; break; }
      }

      const clickedDrawing = hitId != null
        ? allForHit.find((d) => d.id === hitId)
        : null;

      if (clickedDrawing?.type === "horizontal") {
        e.stopPropagation();
        e.preventDefault();
        const alreadySelected = selectedHLineIdRef.current === hitId;
        setSelectedHL(alreadySelected ? null : hitId);
        return;
      }

      if (selectedHLineIdRef.current != null) {
        setSelectedHL(null);
      }

      if (clickedDrawing?.type === "fibRetracement") {
        const detail = fibHitDetailRef.current?.(clickedDrawing, x, y);
        if (!detail) return;
        e.stopPropagation();
        e.preventDefault();
        const pt = coordToDataRef.current?.(x, y) ?? { price: null, time: null };
        editDragRef.current = {
          active: true,
          id: clickedDrawing.id,
          mode: detail,
          startCoord: { price: pt.price, time: pt.time, x, y },
          origP1: { ...clickedDrawing.p1 },
          origP2: { ...clickedDrawing.p2 },
          isShared: !!clickedDrawing.linked || sharedDrawings.some((d) => d.id === clickedDrawing.id),
        };
        setLocalDrawings((d) => [...d]);
      }
    }

    function onWindowMouseMove(e) {
      if (hidden) return;
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const r = svgEl.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;

      // ── Sync price to other panels (same-symbol panels show synced horizontal) ──
      // Only the ACTIVE panel broadcasts — inactive panels stay silent so they
      // cannot overwrite with null when the mouse is outside their bounds.
      if (isActivePanelRef.current) {
        const inside =
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom;
        if (inside) {
          const pt = coordToDataRef.current?.(x, y);
          const price = pt?.price ?? null;
          if (onSyncCrosshairRef.current) onSyncCrosshairRef.current(price);
        } else {
          if (onSyncCrosshairRef.current) onSyncCrosshairRef.current(null);
        }
      }

      if (freehandRef.current.active) {
        const fpt = coordToDataRef.current?.(x, y) ?? { x, y, time: null, price: null };
        freehandRef.current.points.push({ x, y, time: fpt.time, price: fpt.price });
        setFreehandPreview([...freehandRef.current.points]);
        return;
      }

      if (editDragRef.current.active) {
        const ed = editDragRef.current;
        const cur = coordToDataRef.current?.(x, y);
        if (!cur || cur.price == null) return;

        // Edit local drawings (including linked ones)
        const idx = localDrawingsRef.current.findIndex((d) => d.id === ed.id);
        if (idx < 0) return;
        const d = localDrawingsRef.current[idx];

        const dPrice = cur.price - ed.startCoord.price;
        const dTime = cur.time != null && ed.startCoord.time != null
          ? cur.time - ed.startCoord.time : 0;

        let newP1 = { ...ed.origP1 };
        let newP2 = { ...ed.origP2 };

        if (ed.mode === "move") {
          const dPx = x - ed.startCoord.x;
          newP1 = {
            price: ed.origP1.price + dPrice,
            time: ed.origP1.time != null ? ed.origP1.time + dTime : null,
            px: ed.origP1.px != null ? ed.origP1.px + dPx : null,
          };
          newP2 = {
            price: ed.origP2.price + dPrice,
            time: ed.origP2.time != null ? ed.origP2.time + dTime : null,
            px: ed.origP2.px != null ? ed.origP2.px + dPx : null,
          };
        } else if (ed.mode === "p1") {
          newP1 = { price: cur.price, time: cur.time, px: x, barOffset: cur.barOffset ?? null };
        } else if (ed.mode === "p2") {
          newP2 = { price: cur.price, time: cur.time, px: x, barOffset: cur.barOffset ?? null };
        }

        const updated = [...localDrawingsRef.current];
        updated[idx] = { ...d, p1: newP1, p2: newP2 };
        localDrawingsRef.current = updated;
        setLocalDrawings([...updated]);
        return;
      }

      if (dragRef.current.active) {
        const dpt = coordToDataRef.current?.(x, y);
        dragRef.current.current = dpt;
        setLocalDrawings((d) => [...d]);
        return;
      }

      // hover hit-test
      const inside =
        e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom;

      if (!inside) {
        if (hoveredIdRef.current !== null) { hoveredIdRef.current = null; setHoveredId(null); }
        return;
      }

      const allForHit = getAllDrawingsForHit();
      let hitId = null;
      for (const drawing of allForHit) {
        if (hitTestRef.current?.(drawing, x, y)) { hitId = drawing.id; break; }
      }
      if (hitId !== hoveredIdRef.current) {
        hoveredIdRef.current = hitId;
        setHoveredId(hitId);
      }

      if (svgEl) {
        if (hitId != null) {
          const hd = allForHit.find((d) => d.id === hitId);
          if (hd?.type === "fibRetracement") {
            const detail = fibHitDetailRef.current?.(hd, x, y);
            svgEl.style.cursor = (detail === "p1" || detail === "p2") ? "ew-resize" : "move";
          } else {
            svgEl.style.cursor = "pointer";
          }
        } else {
          svgEl.style.cursor = "";
        }
      }
    }

    function onWindowMouseUp(e) {
      if (editDragRef.current.active) {
        editDragRef.current = {
          active: false, id: null, mode: null,
          startCoord: null, origP1: null, origP2: null, isShared: false,
        };
        saveDrawings(localDrawingsRef.current, panelKey);
        publishLinked(localDrawingsRef.current);
        setLocalDrawings((d) => [...d]);
        return;
      }

      // Complete active trendline/horizontal/fib drag on window mouseup
      // This fires even when mouse is released outside the SVG
      const drag = dragRef.current;
      if (drag.active) {
        const linked = !!linkColorRef.current;
        const d = buildDrawing(drag, linked, resolutionRef.current);
        if (d) {
          const next = [...localDrawingsRef.current, d];
          commitLocalDrawings(next);
          publishLinked(next);
        }
        dragRef.current = { active: false, tool: null, start: null, current: null };
        if (setSelectedTool) setSelectedTool("cursor");
      }

      // Complete freehand on window mouseup (in case pointerup didn't fire)
      if (freehandRef.current.active) {
        const pts = freehandRef.current.points;
        freehandRef.current = { active: false, points: [] };
        setFreehandPreview(null);
        if (pts.length > 1) {
          const colorHex =
            DRAW_COLORS.find((c) => c.id === drawColorRef.current)?.hex || "#e0e3eb";
          const linked = !!linkColorRef.current;
          const next = [...localDrawingsRef.current, {
            id: uid(), type: "freehand", points: pts, color: colorHex, width: 1.8, linked,
          }];
          commitLocalDrawings(next);
          publishLinked(next);
        }
        if (setSelectedTool) setSelectedTool("cursor");
      }
    }

    window.addEventListener("mousedown", onWindowMouseDown, { capture: true });
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      window.removeEventListener("mousedown", onWindowMouseDown, { capture: true });
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
    // getAllDrawingsForHit / publishLinked / commitLocalDrawings are stable
    // useCallback instances. svgRelCoord and hidden are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, svgRelCoord, getAllDrawingsForHit, publishLinked, commitLocalDrawings, setSelectedTool]);

  const selectedToolRef = useRef(selectedTool);
  useEffect(() => {
    selectedToolRef.current = selectedTool;
    if (selectedTool === "cursor") {
      if (onSyncCrosshairRef.current) onSyncCrosshairRef.current(null);
    }
  }, [selectedTool]);

  // ── Imperative API ───────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    clearAll() {
      hoveredIdRef.current = null;
      setHoveredId(null);
      setPendingText(null);
      pendingTextRef.current = null;
      freehandRef.current = { active: false, points: [] };
      setFreehandPreview(null);
      commitLocalDrawings([]);
      if (onPublishDrawings) onPublishDrawings([], false);
    },
    getDrawings() { return localDrawingsRef.current; },
    addFibDrawing({ p1Price, p1Time = null, p2Price, p2Time = null, resolution = null }) {
      if (p1Price == null || p2Price == null) return;
      // p1 = wave tip (ratio 0), p2 = wave origin (ratio 1) — as sent by FibDashboard
      // Bull: p1=High(0=top), p2=Low(1=bottom)   Bear: p1=Low(0=bottom), p2=High(1=top)
      const linked = !!linkColorRef.current;
      // Derive timeframe color — null means "use per-level colors" (manual fib draw)
      const tfColor = resolution != null ? getTimeframeColor(resolution, null) : null;
      const next = [...localDrawingsRef.current, {
        id: uid(), type: "fibRetracement",
        p1: { price: p1Price, time: p1Time },
        p2: { price: p2Price, time: p2Time },
        linked,
        tfColor,   // stored on the drawing; null = per-level colors
      }];
      commitLocalDrawings(next);
      publishLinked(next);
    },
  }));

  const DRAWING_TOOLS = ["trendline", "horizontal", "fibRetracement", "text", "draw"];

  const relCoord = useCallback((e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // ── SVG pointer handlers ─────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (selectedToolRef.current === "cursor") return;
    if (!DRAWING_TOOLS.includes(selectedToolRef.current)) return;

    // Auto-activate this panel when user draws on it (no "click to activate" step needed)
    if (!isActivePanel && onPanelActivateRef.current) {
      onPanelActivateRef.current();
    }

    e.stopPropagation();
    const { x, y } = relCoord(e);
    const pt = coordToDataRef.current?.(x, y) ?? { x, y, time: null, price: null };

    if (selectedToolRef.current === "text") {
      if (pendingTextRef.current) commitTextInput(textInputRef.current?.value ?? "");
      const newPt = { x, y, price: pt.price, time: pt.time };
      pendingTextRef.current = newPt;
      setPendingText({ ...newPt });
      return;
    }

    if (selectedToolRef.current === "draw") {
      // Store time+price so freehand sticks to chart on pan/zoom
      freehandRef.current = { active: true, points: [{ x, y, time: pt.time, price: pt.price }] };
      setFreehandPreview([{ x, y, time: pt.time, price: pt.price }]);
      try { svgRef.current?.setPointerCapture(e.pointerId); } catch { }
      return;
    }

    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { }
    dragRef.current = {
      active: true,
      tool: selectedToolRef.current,
      start: pt,
      current: { ...pt },
    };
  }, [relCoord, commitTextInput]);

  const onPointerMove = useCallback((_e) => {
    // Trendline/fib drag is now handled by window-level mousemove for smooth tracking
  }, []);

  // onPointerUp is now a no-op — all drag completion is handled by window mouseup
  // (works even when mouse is released outside the SVG element)
  const onPointerUp = useCallback((_e) => { }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  const drag = dragRef.current;
  const svgW = containerRef.current?.clientWidth ?? 800;
  const svgH = containerRef.current?.clientHeight ?? 500;
  const isDrawing = DRAWING_TOOLS.includes(selectedTool);
  const isEditDragging = editDragRef.current.active;

  // Compute Y pixel for the synced crosshair price (from another panel)
  let syncedY = null;
  if (syncedCrosshairPrice != null && candleSeriesRef.current) {
    try { syncedY = candleSeriesRef.current.priceToCoordinate(syncedCrosshairPrice); } catch (_) { }
  }

  const needsPointerEvents =
    !hidden && (isDrawing || hoveredId != null || isEditDragging);

  // Combined drawings to render: local unlinked + shared + local linked
  const drawingsToRender = [
    ...localDrawings.filter((d) => !d.linked),
    ...sharedDrawings,
    ...localDrawings.filter((d) => d.linked),
  ];

  let pendingInputX = 0, pendingInputY = 0;
  if (pendingText) {
    const c = dataToCoord(pendingText.time, pendingText.price);
    pendingInputX = c.x ?? pendingText.x ?? 100;
    pendingInputY = c.y ?? pendingText.y ?? 100;
  }

  const drawCursor =
    selectedTool === "draw" ? "crosshair"
      : selectedTool === "text" ? "text"
        : hoveredId ? "pointer"
          : "crosshair";

  return (
    <div
      ref={wrapRef}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 25 }}
    >
      <svg
        ref={svgRef}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          pointerEvents: needsPointerEvents ? "all" : "none",
          cursor: isEditDragging
            ? (editDragRef.current.mode === "move" ? "move" : "ew-resize")
            : isDrawing ? drawCursor
              : hoveredId ? "pointer"
                : "default",
          overflow: "visible",
          visibility: hidden ? "hidden" : "visible",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          if (onContextMenu) onContextMenu(e);
        }}
      >
        {/* Transparent hit surface for drawing tools */}
        {isDrawing && (
          <rect
            x={0} y={0} width={svgW} height={svgH}
            fill="transparent"
            style={{ pointerEvents: "all" }}
          />
        )}

        {/* Committed drawings */}
        {!hidden && drawingsToRender.map((d) => (
          <DrawingShape
            key={d.id}
            drawing={d}
            dataToCoord={dataToCoord}
            svgW={svgW}
            svgH={svgH}
            hovered={hoveredId === d.id}
            selected={selectedHLineId === d.id}
            interactive={true}
            lastBarTime={lastBarTime}
          />
        ))}

        {/* Live preview while dragging */}
        {drag.active && drag.start && drag.current && (
          <LivePreview
            drag={drag}
            svgW={svgW}
            svgH={svgH}
            dataToCoord={dataToCoord}
            tfColor={resolution != null ? getTimeframeColor(resolution, null) : null}
          />
        )}

        {/* Freehand live preview */}
        {freehandPreview && freehandPreview.length > 1 && (
          <FreehandPreview
            points={freehandPreview}
            color={
              DRAW_COLORS.find((c) => c.id === drawColorRef.current)?.hex || "#e0e3eb"
            }
            width={1.8}
          />
        )}
        {/* ── Synced horizontal line from another panel (same symbol = same price) ── */}
        {syncedY != null && (
          <line x1={0} y1={syncedY} x2={svgW} y2={syncedY}
            stroke="#3d84ff" strokeWidth={1} strokeDasharray="4 3" opacity={0.9}
            style={{ pointerEvents: "none" }} />
        )}
      </svg>

      {/* ── Price label on right axis for SYNCED crosshair from another panel ── */}
      {syncedY != null && syncedCrosshairPrice != null && (
        <div style={{
          position: "absolute", right: 0, top: syncedY,
          transform: "translateY(-50%)",
          background: "#3d84ff", color: "#ffffff",
          fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          padding: "2px 6px", borderRadius: "2px 0 0 2px",
          pointerEvents: "none", whiteSpace: "nowrap", zIndex: 30, lineHeight: "18px",
        }}>
          {syncedCrosshairPrice.toFixed(2)}
        </div>
      )}

      {/* Inline text input — theme-aware colors */}
      {pendingText && !hidden && (
        <div
          style={{
            position: "absolute",
            left: pendingInputX,
            top: pendingInputY - 18,
            pointerEvents: "all",
            zIndex: 30,
          }}
        >
          <input
            ref={textInputRef}
            type="text"
            placeholder="Type text…"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTextInput(e.target.value); }
              if (e.key === "Escape") {
                e.preventDefault();
                pendingTextRef.current = null;
                setPendingText(null);
              }
              e.stopPropagation();
            }}
            onBlur={(e) => { commitTextInput(e.target.value); }}
            style={{
              background: "var(--bg3)",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', sans-serif",
              padding: "2px 6px",
              outline: "none",
              minWidth: 120,
              boxShadow: "0 2px 8px var(--shadow)",
            }}
          />
          <div
            style={{
              fontSize: 10, color: "var(--text3)", marginTop: 2,
              fontFamily: "sans-serif", pointerEvents: "none",
            }}
          >
            Enter to confirm · Esc to cancel
          </div>
        </div>
      )}
    </div>
  );
});

export default DrawingOverlay;