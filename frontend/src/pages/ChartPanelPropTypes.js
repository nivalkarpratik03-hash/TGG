/**
 * ChartPanelPropTypes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PropTypes declaration for ChartPanel's props.
 * Kept in a separate file so ChartsPage.js doesn't grow further.
 */
import PropTypes from "prop-types";

export const ChartPanelPropTypes = {
  // ── Panel identity ────────────────────────────────────────────────────────
  pfx: PropTypes.string.isRequired,
  panelIdx: PropTypes.number.isRequired,
  panelCount: PropTypes.number.isRequired,

  // ── Layout ────────────────────────────────────────────────────────────────
  layoutId: PropTypes.string,
  onLayoutChange: PropTypes.func,

  // ── URL params (panel 0 only; others receive null/undefined) ─────────────
  urlSymbol: PropTypes.string,
  urlResolution: PropTypes.number,
  urlWaveTarget: PropTypes.object,
  urlFibDrawing: PropTypes.object,
  urlSrLines: PropTypes.arrayOf(PropTypes.object),

  // ── Global toolbar state ──────────────────────────────────────────────────
  selectedTool: PropTypes.string.isRequired,
  setSelectedTool: PropTypes.func.isRequired,
  drawColor: PropTypes.string.isRequired,

  // ── Panel activation ──────────────────────────────────────────────────────
  isActivePanel: PropTypes.bool.isRequired,
  onPanelActivate: PropTypes.func.isRequired,

  // ── Drawing action refs ───────────────────────────────────────────────────
  panelActionsRef: PropTypes.object,
  setActivePanelHidden: PropTypes.func,
  panelLinkRef: PropTypes.object,
  setToolbarLinked: PropTypes.func,

  // ── Synced crosshair (ref-based — no state, no re-renders on mouse move) ──
  syncedCrosshairRef: PropTypes.object,  // { price, symbol }
  syncedCrosshairListeners: PropTypes.object,  // useRef(new Set())
  onSyncCrosshair: PropTypes.func.isRequired,
};