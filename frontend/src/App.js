// App.js
import React, { useState, useEffect, createContext, useContext } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import HomePage from "./features/home/HomePage";
import ChartsPage from "./features/charts/ChartsPage";
import ReportsPage from "./features/reports/ReportsPage";
import FibDashboardPage from "./features/fib-dashboard/FibDashboardPage";
import ScannerPage from "./features/scanner/ScannerPage";
import BacktestPage from "./features/backtest/BacktestPage";
import AdminPage from "./features/admin/AdminPage";
import AnalyticsPage from "./features/analytics/AnalyticsPage";
import ErrorBoundary from "./shared/components/ErrorBoundary";
import { loadPref, savePref } from "./utils/prefs";
import "./styles/App.css";

// ─── Theme context shared across all pages ────────────────────────
export const ThemeContext = createContext({ theme: "dark", toggleTheme: () => { } });
export function useTheme() { return useContext(ThemeContext); }

export default function App() {
  // P4 #27 — this used to call localStorage directly instead of going
  // through prefs.js like every other saved setting in the app. Same
  // storage key ("tgg_theme"), so no migration step needed — an existing
  // raw (non-JSON) value just won't parse on the very first load after
  // this change and falls back to "dark" once, then saves normally as
  // JSON from then on.
  const [theme, setTheme] = useState(() => loadPref("theme", "dark"));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    savePref("theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme(t => t === "dark" ? "light" : "dark");
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ErrorBoundary label="Home"><HomePage /></ErrorBoundary>} />
          <Route path="/charts" element={<ErrorBoundary label="Charts"><ChartsPage /></ErrorBoundary>} />
          <Route path="/reports" element={<ErrorBoundary label="Reports"><ReportsPage /></ErrorBoundary>} />
          <Route path="/fib-dashboard" element={<ErrorBoundary label="Fib Dashboard"><FibDashboardPage /></ErrorBoundary>} />
          <Route path="/scanner" element={<ErrorBoundary label="Scanner"><ScannerPage /></ErrorBoundary>} />
          <Route path="/backtest" element={<ErrorBoundary label="Backtest"><BacktestPage /></ErrorBoundary>} />
          <Route path="/analytics" element={<ErrorBoundary label="Analytics"><AnalyticsPage /></ErrorBoundary>} />
          <Route path="/admin" element={<ErrorBoundary label="Admin"><AdminPage /></ErrorBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeContext.Provider>
  );
}