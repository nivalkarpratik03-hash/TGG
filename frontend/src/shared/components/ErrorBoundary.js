/**
 * ErrorBoundary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * React class-based error boundary. Catches render/lifecycle errors in any
 * child and shows a recovery UI instead of a white screen.
 *
 * Usage:
 *   <ErrorBoundary label="Chart panel">
 *     <CandleChart ... />
 *   </ErrorBoundary>
 *
 * Used in:
 *   App.js      → wraps each Route so a page crash doesn't kill the whole app
 *   ChartsPage  → wraps each ChartPanel individually
 */
import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Log to console so it's visible in browser devtools
    console.error(`[ErrorBoundary${this.props.label ? ` – ${this.props.label}` : ""}]`, error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, info: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { label = "Component", minimal = false } = this.props;
    const message = this.state.error?.message || "Unknown error";

    if (minimal) {
      // Compact inline fallback — used inside chart panels where space is tight
      return (
        <div style={styles.minimalWrap}>
          <span style={styles.minimalIcon}>⚠</span>
          <span style={styles.minimalMsg}>{label} failed to render</span>
          <button style={styles.minimalBtn} onClick={this.handleReset}>Retry</button>
        </div>
      );
    }

    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.icon}>⚠</div>
          <div style={styles.title}>{label} crashed</div>
          <div style={styles.message}>{message}</div>
          <div style={styles.hint}>
            This panel encountered a rendering error. Your other panels are unaffected.
          </div>
          <div style={styles.actions}>
            <button style={styles.retryBtn} onClick={this.handleReset}>
              Retry
            </button>
            <button style={styles.reloadBtn} onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
          {process.env.NODE_ENV === "development" && this.state.info && (
            <pre style={styles.stack}>
              {this.state.info.componentStack}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

const styles = {
  // Full-panel fallback
  wrap: {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: "100%", height: "100%", minHeight: 200,
    background: "var(--bg, #0a0b0f)", padding: 24, boxSizing: "border-box",
  },
  card: {
    background: "var(--bg2, #12141a)", border: "1px solid var(--border, #23263a)",
    borderRadius: 12, padding: "28px 32px", maxWidth: 440, textAlign: "center",
  },
  icon: { fontSize: 32, marginBottom: 12 },
  title: {
    color: "var(--text, #e0e3eb)", fontSize: 16, fontWeight: 700, marginBottom: 8,
  },
  message: {
    color: "var(--red, #ff4560)", fontSize: 12, fontFamily: "monospace",
    background: "rgba(255,69,96,0.08)", borderRadius: 6, padding: "6px 10px",
    marginBottom: 12, wordBreak: "break-all",
  },
  hint: {
    color: "var(--text3, #5a6070)", fontSize: 12, marginBottom: 20, lineHeight: 1.5,
  },
  actions: { display: "flex", gap: 10, justifyContent: "center" },
  retryBtn: {
    background: "var(--accent, #3d84ff)", color: "#fff",
    border: "none", borderRadius: 6, padding: "8px 20px",
    cursor: "pointer", fontSize: 13, fontWeight: 600,
  },
  reloadBtn: {
    background: "transparent", color: "var(--text2, #8892a4)",
    border: "1px solid var(--border2, #2e3248)", borderRadius: 6,
    padding: "8px 20px", cursor: "pointer", fontSize: 13,
  },
  stack: {
    marginTop: 16, textAlign: "left", fontSize: 10, color: "var(--text3, #5a6070)",
    background: "var(--bg, #0a0b0f)", borderRadius: 6, padding: 10,
    maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
  },
  // Minimal compact fallback (minimal=true)
  minimalWrap: {
    display: "flex", alignItems: "center", gap: 8, justifyContent: "center",
    width: "100%", height: "100%", minHeight: 60,
    background: "var(--bg, #0a0b0f)", color: "var(--text2, #8892a4)", fontSize: 12,
  },
  minimalIcon: { color: "var(--yellow, #ffc135)", fontSize: 14 },
  minimalMsg: { color: "var(--text2, #8892a4)" },
  minimalBtn: {
    background: "transparent", color: "var(--accent, #3d84ff)",
    border: "1px solid var(--accent, #3d84ff)", borderRadius: 4,
    padding: "3px 10px", cursor: "pointer", fontSize: 11,
  },
};