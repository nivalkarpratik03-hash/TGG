// frontend/src/features/charts/tv/TradingViewPage.js
// Full-screen TradingView Advanced Charts page.
//   /tv                                  -> NIFTY 50, 15 minute
//   /tv?symbol=NSE:NIFTYBANK-INDEX&interval=3

import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import TradingViewChart from "./TradingViewChart";

export default function TradingViewPage() {
  const [params] = useSearchParams();
  const symbol = params.get("symbol") || "NSE:NIFTY50-INDEX";
  const interval = params.get("interval") || "15";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: "6px 12px", fontSize: 13 }}>
        <Link to="/">Home</Link>
        <span style={{ margin: "0 8px", opacity: 0.5 }}>|</span>
        <Link to="/charts">Charts</Link>
        <span style={{ marginLeft: 16, opacity: 0.6 }}>TradingView Advanced Charts</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TradingViewChart symbol={symbol} interval={interval} />
      </div>
    </div>
  );
}