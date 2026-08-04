/**
 * DrawingShapes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SVG render components for the drawing overlay system.
 * Extracted from DrawingOverlay.js (was 1521 lines).
 *
 * Exports:
 *   FreehandPreview  — live SVG path while freehand drawing
 *   LivePreview      — ghost line/fib while dragging before mouse-up
 *   DrawingShape     — renders a completed saved drawing (trendline/horizontal/fib/text/freehand)
 *
 * All are pure render components — no state, no side effects.
 * Imported by DrawingOverlay.js.
 */
import React from "react";
import {
  DRAW_COLOR, HOVER_COLOR, FIB_COLOR, HANDLE_R,
  FIB_LEVELS, numFmt,
} from "./drawingUtils";

export function FreehandPreview({ points, color, width }) {
  if (!points || points.length < 2) return null;
  const d = "M" + points.map((p) => `${p.x},${p.y}`).join(" L");
  return (
    <path
      d={d}
      stroke={color}
      strokeWidth={width}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={0.85}
      style={{ pointerEvents: "none" }}
    />
  );
}

// ─── Live preview while dragging (trendline / fib) ───────────────────────────
export function LivePreview({ drag, svgW, svgH, dataToCoord, tfColor = null }) {
  const { tool, start, current } = drag;
  const color = DRAW_COLOR;

  if (tool === "trendline") {
    // Reproject start and current via time+price if available (survives pan during drag)
    // Pass barOffset so points dragged past last candle stay correctly positioned
    const c1 = dataToCoord(start.time, start.price, start.barOffset ?? null);
    const c2 = dataToCoord(current.time, current.price, current.barOffset ?? null);
    const x1 = c1.x ?? start.x;
    const y1 = c1.y ?? start.y;
    const x2 = c2.x ?? current.x;
    const y2 = c2.y ?? current.y;
    return (
      <g style={{ pointerEvents: "none" }}>
        <line
          x1={x1} y1={y1}
          x2={x2} y2={y2}
          stroke={color} strokeWidth={1.8}
        />
        <circle cx={x1} cy={y1} r={HANDLE_R} fill={color} />
        <circle cx={x2} cy={y2} r={HANDLE_R} fill={color} />
      </g>
    );
  }

  if (tool === "horizontal") {
    return (
      <line
        x1={0} y1={start.y} x2={svgW} y2={start.y}
        stroke={color} strokeWidth={1.8} strokeDasharray="7 4"
        style={{ pointerEvents: "none" }}
      />
    );
  }

  if (tool === "fibRetracement") {
    if (start.price == null || current.price == null) return null;
    // p1 = current (drag end = tip = ratio 0), p2 = start (origin = ratio 1)
    // Bull drag up:   current=High(0=top), start=Low(1=bottom)  — priceRange = Low-High < 0
    // Bear drag down: current=Low(0=bot),  start=High(1=top)    — priceRange = High-Low > 0
    const tipPrice = current.price;   // ratio 0
    const originPrice = start.price;     // ratio 1
    const priceRange = originPrice - tipPrice; // p2 - p1 (same as DrawingShape uses)

    const PRICE_SCALE_W = 70;
    const maxX = svgW - PRICE_SCALE_W;
    const rawX1 = Math.min(start.x, current.x);
    const rawX2 = maxX; // extend preview to right edge while dragging
    const boxX1 = Math.max(rawX1, 0);
    const boxX2 = Math.min(rawX2, maxX);
    if (boxX2 <= boxX1) return null;

    const previewClipId = "fib-preview-clip";
    const LABEL_PAD = 6;

    return (
      <g style={{ pointerEvents: "none" }}>
        <defs>
          <clipPath id={previewClipId}>
            <rect x={boxX1} y={0} width={boxX2 - boxX1} height={svgH} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${previewClipId})`}>
          {FIB_LEVELS.map((lvl) => {
            const price = tipPrice + priceRange * lvl.ratio;
            const coord = dataToCoord(null, price);
            if (coord.y == null) return null;
            const isEdge = lvl.ratio === 0 || lvl.ratio === 1;
            const lineColor = tfColor ?? lvl.color;
            return (
              <line
                key={lvl.ratio}
                x1={boxX1} y1={coord.y} x2={boxX2} y2={coord.y}
                stroke={lineColor}
                strokeWidth={isEdge ? 1.8 : lvl.width}
                strokeDasharray={isEdge ? "0" : lvl.dash}
                opacity={0.85}
              />
            );
          })}
        </g>

        {FIB_LEVELS.map((lvl) => {
          const price = tipPrice + priceRange * lvl.ratio;
          const coord = dataToCoord(null, price);
          if (coord.y == null) return null;
          const isEdge = lvl.ratio === 0 || lvl.ratio === 1;
          const lineColor = tfColor ?? lvl.color;
          return (
            <text
              key={`lbl-${lvl.ratio}`}
              x={boxX1 + LABEL_PAD} y={coord.y - 3}
              fill={lineColor} fontSize={11}
              fontFamily="'JetBrains Mono', monospace"
              fontWeight={isEdge ? 700 : 600}
              textAnchor="start"
            >
              {lvl.label} ({numFmt.format(price)})
            </text>
          );
        })}

        <circle cx={start.x} cy={start.y} r={HANDLE_R} fill={FIB_COLOR} />
        <circle cx={current.x} cy={current.y} r={HANDLE_R} fill={FIB_COLOR} />
      </g>
    );
  }

  return null;
}

// ─── Completed drawing shapes ─────────────────────────────────────────────────
export function DrawingShape({ drawing, dataToCoord, svgW, svgH, hovered, selected, interactive, lastBarTime }) {
  const color = hovered ? HOVER_COLOR : DRAW_COLOR;
  const strokeW = hovered ? 2.5 : 1.8;
  const pe = interactive ? "all" : "none";

  // ── Freehand ────────────────────────────────────────────────────────────
  if (drawing.type === "freehand" && drawing.points?.length > 1) {
    // Reproject stored time+price coords to current pixel positions each render
    // so freehand drawings stick to the chart on pan/zoom like trendlines do
    const pts = drawing.points.map((p) => {
      if (p.time != null && p.price != null) {
        const c = dataToCoord(p.time, p.price);
        return { x: c.x ?? p.x, y: c.y ?? p.y };
      }
      return { x: p.x, y: p.y };
    });
    const d = "M" + pts.map((p) => `${p.x},${p.y}`).join(" L");
    const strokeColor = hovered ? HOVER_COLOR : (drawing.color || "#e0e3eb");
    const strokeWidth = hovered
      ? (drawing.width || 1.5) * 1.3
      : (drawing.width || 1.5);
    return (
      <g style={{ pointerEvents: pe }}>
        <path
          d={d}
          stroke="transparent"
          strokeWidth={Math.max(strokeWidth + 10, 16)}
          fill="none"
          style={{ pointerEvents: pe }}
        />
        <path
          d={d}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: "none" }}
        />
      </g>
    );
  }

  // ── Trend Line — rendered from time/price coords every frame ────────────
  if (drawing.type === "trendline") {
    const PRICE_SCALE_W = 70;
    const maxX = svgW - PRICE_SCALE_W;

    const c1 = dataToCoord(drawing.p1.time, drawing.p1.price, drawing.p1.barOffset ?? null);
    const c2 = dataToCoord(drawing.p2.time, drawing.p2.price, drawing.p2.barOffset ?? null);

    // Use stored .px as fallback when timeToCoordinate returns null
    // (point drawn past last candle — same approach as fib)
    const x1 = c1.x ?? drawing.p1.px ?? null;
    const x2 = c2.x ?? drawing.p2.px ?? null;
    const y1 = c1.y;
    const y2 = c2.y;

    if (x1 == null || x2 == null) return null;
    if (y1 == null || y2 == null) return null;
    return (
      <g style={{ pointerEvents: pe }}>
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="transparent" strokeWidth={18}
          style={{ pointerEvents: pe }}
        />
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={color} strokeWidth={strokeW}
          style={{ pointerEvents: "none" }}
        />
        <circle cx={x1} cy={y1} r={HANDLE_R} fill={color} opacity={hovered ? 1 : 0.6} style={{ pointerEvents: "none" }} />
        <circle cx={x2} cy={y2} r={HANDLE_R} fill={color} opacity={hovered ? 1 : 0.6} style={{ pointerEvents: "none" }} />
      </g>
    );
  }

  // ── Horizontal Line — price-anchored, moves with zoom/pan ───────────────
  if (drawing.type === "horizontal") {
    // Convert stored price to current pixel y every render
    const c = dataToCoord(null, drawing.price);
    if (c.y == null) return null;
    const label = numFmt.format(drawing.price);
    const isActive = selected || hovered;
    const lineColor = selected ? "#f0c040"
      : hovered ? HOVER_COLOR
        : DRAW_COLOR;
    const badgeW = 80, badgeH = 20;
    const badgeX = svgW - badgeW - 2;
    return (
      <g style={{ pointerEvents: pe }}>
        <line
          x1={0} y1={c.y} x2={svgW} y2={c.y}
          stroke="transparent" strokeWidth={18}
          style={{ pointerEvents: pe }}
        />
        <line
          x1={0} y1={c.y} x2={svgW} y2={c.y}
          stroke={lineColor}
          strokeWidth={selected ? 2.2 : strokeW}
          strokeDasharray={isActive ? "0" : "7 4"}
          style={{ pointerEvents: "none" }}
        />
        <rect
          x={badgeX} y={c.y - badgeH / 2}
          width={badgeW} height={badgeH} rx={3}
          fill={lineColor} opacity={0.92}
          style={{ pointerEvents: "none" }}
        />
        <text
          x={badgeX + badgeW / 2} y={c.y + 4}
          textAnchor="middle" fill="#fff" fontSize={10}
          fontFamily="'JetBrains Mono', monospace" fontWeight={700}
          style={{ userSelect: "none", pointerEvents: "none" }}
        >
          {label}
        </text>
        {selected && (
          <g style={{ pointerEvents: "none" }}>
            <rect
              x={badgeX - 46} y={c.y - badgeH / 2}
              width={40} height={badgeH} rx={3}
              fill="#f0c040" opacity={0.18}
            />
            <text
              x={badgeX - 26} y={c.y + 4}
              textAnchor="middle" fill="#f0c040" fontSize={11}
              fontFamily="sans-serif" fontWeight={700}
              style={{ userSelect: "none" }}
            >
              ↑↓
            </text>
          </g>
        )}
      </g>
    );
  }

  // ── Fibonacci Retracement — time+price anchored ─────────────────────────
  if (drawing.type === "fibRetracement") {
    const c1 = dataToCoord(drawing.p1.time, drawing.p1.price, drawing.p1.barOffset ?? null);
    const c2 = dataToCoord(drawing.p2.time, drawing.p2.price, drawing.p2.barOffset ?? null);

    // Use stored .px as fallback when timeToCoordinate returns null
    // (point drawn past last candle, or TF mismatch — .px is the correct pixel saved at draw-time)
    const PRICE_SCALE_W = 70;
    const maxX = svgW - PRICE_SCALE_W;

    const ax1 = c1.x ?? drawing.p1.px ?? null;
    const ax2 = c2.x ?? drawing.p2.px ?? null;
    const hasAnchors = ax1 != null && ax2 != null;

    const rawX1 = hasAnchors ? Math.min(ax1, ax2) : 0;
    const rawX2 = hasAnchors ? Math.max(ax1, ax2) : maxX;
    const boxX1 = Math.max(rawX1, 0);
    const boxX2 = Math.min(rawX2, maxX);

    if (boxX2 <= boxX1 + 1) return null;

    const clipId = `fib-clip-${drawing.id}`;
    const priceRange = drawing.p2.price - drawing.p1.price;

    const levelLines = FIB_LEVELS.map((lvl) => {
      const price = drawing.p1.price + priceRange * lvl.ratio;
      const coord = dataToCoord(null, price);
      return { ...lvl, price, y: coord.y };
    }).filter((l) => l.y != null);

    if (levelLines.length < 2) return null;

    const priceToY = (ratio) => {
      const p = drawing.p1.price + priceRange * ratio;
      const c = dataToCoord(null, p);
      return c.y;
    };

    const topY = priceToY(Math.min(...FIB_LEVELS.map((l) => l.ratio)));
    const botY = priceToY(Math.max(...FIB_LEVELS.map((l) => l.ratio)));
    const rectTop = topY != null && botY != null ? Math.min(topY, botY) : 0;
    const rectBot = topY != null && botY != null ? Math.max(topY, botY) : svgH;

    const LABEL_PAD = 6;
    const labelX = boxX1 + LABEL_PAD;

    return (
      <g style={{ pointerEvents: "none" }}>
        <defs>
          <clipPath id={clipId}>
            <rect x={boxX1} y={rectTop} width={boxX2 - boxX1} height={Math.max(rectBot - rectTop, 1)} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          {/* Trap zone fill: -0.236 → +0.236 only */}
          {(() => {
            const yA = priceToY(-0.236);
            const yB = priceToY(0.236);
            if (yA == null || yB == null) return null;
            const zy = Math.min(yA, yB);
            const zh = Math.abs(yB - yA);
            return (
              <rect
                x={boxX1} y={zy}
                width={boxX2 - boxX1} height={Math.max(zh, 1)}
                fill="#ff9800" opacity={0.18}
                style={{ pointerEvents: "none" }}
              />
            );
          })()}
          {levelLines.map(({ ratio, label, color: lvlColor, dash, width, price, y }) => {
            const isEdge = ratio === 0 || ratio === 1;
            // If this fib was drawn from FibDashboard with a known timeframe,
            // use that TF color for ALL level lines so fibs from different
            // timeframes are instantly distinguishable.
            // Manual fibs (tfColor = null) keep their original per-level colors.
            const lineColor = drawing.tfColor ?? lvlColor;
            return (
              <g key={ratio}>
                <line
                  x1={boxX1} y1={y} x2={boxX2} y2={y}
                  stroke="transparent" strokeWidth={14}
                  style={{ pointerEvents: interactive ? "stroke" : "none" }}
                />
                <line
                  x1={boxX1} y1={y} x2={boxX2} y2={y}
                  stroke={lineColor}
                  strokeWidth={isEdge ? 1.8 : width}
                  strokeDasharray={isEdge ? "0" : dash}
                  opacity={hovered ? 1 : 0.90}
                  style={{ pointerEvents: "none" }}
                />
              </g>
            );
          })}
        </g>

        {levelLines.map(({ ratio, label, color: lvlColor, price, y }) => {
          const isEdge = ratio === 0 || ratio === 1;
          const labelText = `${label} (${numFmt.format(price)})`;
          const lineColor = drawing.tfColor ?? lvlColor;
          if (y == null) return null;
          return (
            <text
              key={`lbl-${ratio}`}
              x={labelX} y={y - 3}
              fill={lineColor} fontSize={11}
              fontFamily="'JetBrains Mono', monospace"
              fontWeight={isEdge ? 700 : 600}
              textAnchor="start"
              style={{ pointerEvents: "none", clipPath: `url(#${clipId})` }}
            >
              {labelText}
            </text>
          );
        })}

        {hasAnchors && (
          <>
            <circle cx={ax1} cy={c1.y ?? priceToY(0) ?? 0} r={3} fill={FIB_COLOR}
              opacity={hovered ? 0 : 0.35} style={{ pointerEvents: "none" }} />
            <circle cx={ax2} cy={c2.y ?? priceToY(1) ?? 0} r={3} fill={FIB_COLOR}
              opacity={hovered ? 0 : 0.35} style={{ pointerEvents: "none" }} />
            {hovered && (
              <>
                <circle cx={ax1} cy={c1.y ?? priceToY(0) ?? 0} r={8} fill={FIB_COLOR} opacity={0.18} style={{ pointerEvents: "none" }} />
                <circle cx={ax1} cy={c1.y ?? priceToY(0) ?? 0} r={5} fill={FIB_COLOR} opacity={0.9} stroke="#fff" strokeWidth={1.2} style={{ pointerEvents: "none" }} />
                <circle cx={ax2} cy={c2.y ?? priceToY(1) ?? 0} r={8} fill={FIB_COLOR} opacity={0.18} style={{ pointerEvents: "none" }} />
                <circle cx={ax2} cy={c2.y ?? priceToY(1) ?? 0} r={5} fill={FIB_COLOR} opacity={0.9} stroke="#fff" strokeWidth={1.2} style={{ pointerEvents: "none" }} />
              </>
            )}
          </>
        )}
      </g>
    );
  }

  // ── Text Label — time+price anchored ────────────────────────────────────
  if (drawing.type === "text") {
    const c = dataToCoord(drawing.time, drawing.price);
    const cx = c.x ?? drawing.x ?? 100;
    const cy = c.y ?? drawing.y ?? 100;
    if (cx == null || cy == null) return null;
    const textContent = drawing.content || "";
    const fontSize = drawing.fontSize || 13;
    const textCol = hovered ? HOVER_COLOR : (drawing.color || "#e0e3eb");
    const approxW = textContent.length * (fontSize * 0.62) + 16;
    const approxH = fontSize + 8;
    return (
      <g style={{ pointerEvents: pe }}>
        <rect
          x={cx - 4} y={cy - approxH}
          width={approxW} height={approxH + 4}
          fill="transparent"
          style={{ pointerEvents: pe }}
        />
        <rect
          x={cx - 4} y={cy - approxH + 2}
          width={approxW} height={approxH - 2} rx={3}
          fill={hovered ? "rgba(91,143,255,0.15)" : "rgba(0,0,0,0.45)"}
          style={{ pointerEvents: "none" }}
        />
        <text
          x={cx + 4} y={cy - 4}
          fill={textCol} fontSize={fontSize}
          fontFamily="-apple-system, BlinkMacSystemFont, 'Trebuchet MS', sans-serif"
          fontWeight={500}
          style={{ userSelect: "none", pointerEvents: "none" }}
        >
          {textContent}
        </text>
        <circle cx={cx} cy={cy} r={3} fill={textCol}
          opacity={hovered ? 1 : 0.5}
          style={{ pointerEvents: "none" }} />
      </g>
    );
  }

  return null;

}