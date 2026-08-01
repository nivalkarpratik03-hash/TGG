[1mdiff --git a/architechture.md b/architechture.md[m
[1mnew file mode 100644[m
[1mindex 0000000..ed5f733[m
[1m--- /dev/null[m
[1m+++ b/architechture.md[m
[36m@@ -0,0 +1,1208 @@[m
[32m+[m[32m# TGG — Architecture & Wiring Map[m
[32m+[m[32m**Date:** 2026-06-03[m[41m  [m
[32m+[m[32m**Purpose:** Complete connection map of every file, function, route, socket event, and data flow in the codebase.[m
[32m+[m
[32m+[m[32m---[m
[32m+[m
[32m+[m[32m## Project-Level Architecture Diagram[m
[32m+[m
[32m+[m[32m```mermaid[m
[32m+[m[32mgraph TD[m
[32m+[m[32m  subgraph FYERS["☁️ Fyers Broker"][m
[32m+[m[32m    F_REST["REST API\nhistorical 1m candles\n90-day window"][m
[32m+[m[32m    F_WS["WebSocket\nlive tick stream\nmarket hours only"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph BACKEND["🖥️ Backend — Node.js / Express :9003"][m
[32m+[m[32m    direction TB[m
[32m+[m
[32m+[m[32m    subgraph CORE["Core Modules"][m
[32m+[m[32m      SERVER["server.js\norchestrator"][m
[32m+[m[32m      FYERS_JS["fyers.js\nloadToken · validateToken\nfetchCandles → always 1m\ngetAuthURL · generateToken"][m
[32m+[m[32m      CB["candleBuilder.js\nCandleBuilder class\nseedHistory · addTick\nderiveTimeframe"][m
[32m+[m[32m      TS["tickStream.js\nTickStream EventEmitter\nstart · setSymbols\nisMarketOpen · isLiveMarket"][m
[32m+[m[32m      SE["signalEngine.js\nrunSignalEngine\ncalcEMA"][m
[32m+[m[32m    end[m
[32m+[m
[32m+[m[32m    subgraph ROUTES["Express Routes"][m
[32m+[m[32m      R1["GET  /api/chart"][m
[32m+[m[32m      R2["POST /api/chart/refresh"][m
[32m+[m[32m      R3["GET  /api/auth/status|url\nPOST /api/auth/callback"][m
[32m+[m[32m      R4["POST /api/db/validate\nPOST /api/db/refetch\nGET  /api/db/stats\nGET  /api/db/repair-history"][m
[32m+[m[32m      R5["GET  /health"][m
[32m+[m[32m      R6["/api/symbols → symbolsRouter.js"][m
[32m+[m[32m      R7["/api/scanner → scannerRouter.js\n→ scannerRunner.js\n→ strategies/"][m
[32m+[m[32m    end[m
[32m+[m
[32m+[m[32m    subgraph CACHE["In-Memory Cache"][m
[32m+[m[32m      CM["symbolCacheMap\nMap< SYM:res → {candles, result, lastFetch} >"][m
[32m+[m[32m      BUILDERS["candleBuilders\nMap< symbol → CandleBuilder >"][m
[32m+[m[32m    end[m
[32m+[m
[32m+[m[32m    SIO["Socket.IO Server\nRooms: res:1 res:3 res:5 res:15 res:60 res:1440\nsocketSymbols  socketResolutions\nEmits: chart_update · tick_update · candle_update\n       new_candle · market_status · repair_status"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph DB["🗄️ Database — PostgreSQL + TimescaleDB :5432/tgg"][m
[32m+[m[32m    direction TB[m
[32m+[m
[32m+[m[32m    subgraph DB_SRC["database/src/"][m
[32m+[m[32m      POOL["pool.js\nshared pg Pool"][m
[32m+[m[32m      CS["candleStore.js\nupsertCandles · loadCandles\npruneOldCandles · deleteDayCandles"][m
[32m+[m[32m      VE["validationEngine.js\nvalidateCandleArray\nvalidateHistorical\ncheckPeriodicSync"][m
[32m+[m[32m      RE["recoveryEngine.js\nrepairDay · fullRefetch\nperiodicSync\ninjectStatusEmitter"][m
[32m+[m[32m      RL["repairLog.js\nlogRepairStart · logRepairFinish"][m
[32m+[m[32m    end[m
[32m+[m
[32m+[m[32m    subgraph TABLES["Tables"][m
[32m+[m[32m      T1["candles\nsymbol · resolution=1 · time\nOHLC · volume · validated\nCHECK resolution=1\nHypertable partitioned by time+symbol"][m
[32m+[m[32m      T2["repair_log\nid · symbol · resolution · trigger\nstatus · started_at · finished_at"][m
[32m+[m[32m      T3["validation_state\nsymbol · resolution · last_ok · status"][m
[32m+[m[32m    end[m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph FRONTEND["🌐 Frontend — React SPA :3000"][m
[32m+[m[32m    direction TB[m
[32m+[m
[32m+[m[32m    subgraph PAGES["Pages — App.js Router"][m
[32m+[m[32m      P1["/ → HomePage"][m
[32m+[m[32m      P2["/charts → ChartsPage ⭐"][m
[32m+[m[32m      P3["/reports → ReportsPage"][m
[32m+[m[32m      P4["/fib-dashboard → FibDashboardPage"][m
[32m+[m[32m      P5["/scanner → ScannerPage"][m
[32m+[m[32m      P6["/strategies → StrategiesPage"][m
[32m+[m[32m    end[m
[32m+[m
[32m+[m[32m    subgraph CHARTS_PAGE["ChartsPage — 1/2/3/4 Panel Layouts"][m
[32m+[m[32m      PANEL["ChartPanel\n1–4 instances, each independent"][m
[32m+[m[32m      USE_SOCKET["useSocket.js\nsocket.io-client + axios\nchartData · refresh · connected\ntickStreamActive · repairStatus"][m
[32m+[m[32m      CC["CandleChart.js\nlightweight-charts canvas\nincremental .update() / .setData()\nRulerOverlay · timer countdown"][m
[32m+[m[32m      INDS["Indicators\nWavesIndicator\nSRZonesIndicator\nConsolidationIndicator"][m
[32m+[m[32m      DRAW["DrawingOverlay.js\nSVG drawing tools\nDrawingContext shared link"][m
[32m+[m[32m      SB["StatusBar.js\nOHLCV · EMA · market pill\nVALIDATE / REFETCH buttons"][m
[32m+[m[32m      TB["TradingToolbar.js\nglobal left toolbar\nshared across all panels"][m
[32m+[m[32m      FLOATS["StatsPanel\nWaveStatsPanel\nEmaFloatPanel"][m
[32m+[m[32m    end[m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  %% Fyers → Backend[m
[32m+[m[32m  F_REST -->|"fetchOneMinuteCandles\n90-day chunks, concurrency=3"| FYERS_JS[m
[32m+[m[32m  F_WS -->|"tick events\n{symbol, ltp, …}"| TS[m
[32m+[m
[32m+[m[32m  %% Backend internal[m
[32m+[m[32m  FYERS_JS --> SERVER[m
[32m+[m[32m  TS -->|"emit tick"| SERVER[m
[32m+[m[32m  SERVER -->|"addTick"| CB[m
[32m+[m[32m  SERVER -->|"runSignalEngine"| SE[m
[32m+[m[32m  SE --> CM[m
[32m+[m[32m  CB -->|"seedHistory\ngetCandlesForResolution\nderiveTimeframe"| CM[m
[32m+[m[32m  CB -->|"onTick → emitCandleUpdate"| SIO[m
[32m+[m[32m  CB -->|"onFinalize → emitFinalCandle\n+ upsertCandles res=1"| SIO[m
[32m+[m[32m  CB --> BUILDERS[m
[32m+[m[32m  SERVER --> ROUTES[m
[32m+[m[32m  SERVER --> SIO[m
[32m+[m
[32m+[m[32m  %% Backend → DB[m
[32m+[m[32m  SERVER -->|"loadCandles res=1\nupsertCandles res=1\npruneOldCandles"| CS[m
[32m+[m[32m  RE -->|"delete · upsert"| CS[m
[32m+[m[32m  RE --> VE[m
[32m+[m[32m  RE --> RL[m
[32m+[m[32m  VE --> CS[m
[32m+[m[32m  CS --> POOL[m
[32m+[m[32m  RL --> POOL[m
[32m+[m[32m  POOL --> T1[m
[32m+[m[32m  POOL --> T2[m
[32m+[m[32m  POOL --> T3[m
[32m+[m[32m  RE -->|"repair_status events"| SIO[m
[32m+[m
[32m+[m[32m  %% Frontend → Backend[m
[32m+[m[32m  USE_SOCKET -->|"WS: set_symbol\nset_resolution\nrequest_refresh"| SIO[m
[32m+[m[32m  USE_SOCKET -->|"HTTP GET /api/chart\nPOST /api/chart/refresh"| ROUTES[m
[32m+[m
[32m+[m[32m  %% Backend → Frontend[m
[32m+[m[32m  SIO -->|"chart_update\ntick_update / candle_update\nnew_candle · market_status\nrepair_status"| USE_SOCKET[m
[32m+[m
[32m+[m[32m  %% Frontend internal[m
[32m+[m[32m  PANEL --> USE_SOCKET[m
[32m+[m[32m  PANEL --> CC[m
[32m+[m[32m  PANEL --> SB[m
[32m+[m[32m  PANEL --> TB[m
[32m+[m[32m  PANEL --> FLOATS[m
[32m+[m[32m  CC --> INDS[m
[32m+[m[32m  CC --> DRAW[m
[32m+[m[32m```[m
[32m+[m
[32m+[m[32m---[m
[32m+[m
[32m+[m[32m## Database Architecture Diagram[m
[32m+[m
[32m+[m[32m```mermaid[m
[32m+[m[32mflowchart TD[m
[32m+[m[32m  FYERS_REST["☁️ Fyers REST API\nfetchOneMinuteCandles\n90-day window, parallel chunks"][m
[32m+[m[32m  FYERS_WS["☁️ Fyers WebSocket\nlive tick stream"][m
[32m+[m
[32m+[m[32m  subgraph RECOVERY["Recovery Engine — recoveryEngine.js"][m
[32m+[m[32m    FR["fullRefetch\n① deleteAllCandles res=1\n② fetchCandles res=1\n③ validateCandleArray\n④ upsertCandles res=1"][m
[32m+[m[32m    RD["repairDay\n① deleteDayCandles res=1\n② fetchCandles res=1\n③ validateCandleArray\n④ upsertCandles res=1\n⑤ revalidate"][m
[32m+[m[32m    PS["periodicSync\n① fetchCandles res=1\n② checkPeriodicSync\n③ upsertCandles missing"][m
[32m+[m[32m    MUTEX["Per-symbol Mutex\nenqueueRepair\nno concurrent writes"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph VALIDATION["Validation Engine — validationEngine.js"][m
[32m+[m[32m    VCA["validateCandleArray\n• CORRUPT_OHLC\n• DUPLICATE_TIME\n• GAP_DETECTED\n• EMPTY"][m
[32m+[m[32m    VH["validateHistorical\nalways res=1\n90-day window"][m
[32m+[m[32m    CPS["checkPeriodicSync\nlatestDb vs latestBroker\nreturns gapMs"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph STORE["Candle Store — candleStore.js"][m
[32m+[m[32m    UPSERT["upsertCandles\nINSERT ON CONFLICT UPDATE\n500-row batches\nidempotent"][m
[32m+[m[32m    LOAD["loadCandles\nSELECT ORDER BY time ASC\nres=1 only"][m
[32m+[m[32m    PRUNE["pruneOldCandles\nDELETE WHERE time < 90d\ndefault res=1"][m
[32m+[m[32m    DEL["deleteDayCandles\ndeleteAllCandles"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph POOL["pool.js — pg Pool"][m
[32m+[m[32m    QUERY["query · transaction\nhealthCheck"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph PG["PostgreSQL + TimescaleDB"][m
[32m+[m[32m    subgraph CANDLES_T["TABLE: candles"][m
[32m+[m[32m      C1["symbol · resolution · time  ← PRIMARY KEY\nopen · high · low · close · volume\nvalidated · inserted_at\nCHECK resolution = 1  ← DB-level enforcement\nHypertable: partitioned time + symbol\nIndex: symbol, resolution, time DESC"][m
[32m+[m[32m    end[m
[32m+[m[32m    subgraph REPAIR_T["TABLE: repair_log"][m
[32m+[m[32m      R1["id · symbol · resolution\nstarted_at · finished_at\ntrigger · status · detail\ncandles_deleted · candles_inserted"][m
[32m+[m[32m    end[m
[32m+[m[32m    subgraph VAL_T["TABLE: validation_state"][m
[32m+[m[32m      V1["symbol · resolution\nlast_checked · last_ok\nstatus · issue"][m
[32m+[m[32m    end[m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph SERVER["server.js — fetchAndProcess"][m
[32m+[m[32m    FP["① db.loadCandles res=1 from 90d ago\n② if empty → fyers.fetchCandles res=1\n③ validate + upsertCandles res=1\n④ deriveAllTFs → setCache res=1,3,5,15,60,1440,10080\n⑤ return getCache requested-res\n\n!! DB queried for res=1 only !!\n!! All other TFs from in-memory cache !!"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph LIVE["Live Write Path — CandleBuilder.onFinalize"][m
[32m+[m[32m    LW["isLiveMarket = true\n→ db.upsertCandles res=1 [closedCandle]\nfire-and-forget, .catch logs only\nno data loss on restart"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph STATUS["Status Events → Frontend"][m
[32m+[m[32m    SE["io.emit repair_status\n{symbol, status, inserted, deleted}\nShown in StatusBar repair badge"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  subgraph TRIGGERS["Periodic Maintenance Triggers"][m
[32m+[m[32m    T1["Boot\npruneOldCandles null,1,90d"][m
[32m+[m[32m    T2["Every ~2 min live market\nperiodicSync"][m
[32m+[m[32m    T3["Corruption detected\nrepairDay"][m
[32m+[m[32m    T4["VALIDATE button clicked\nvalidateHistorical → repairDay if issues"][m
[32m+[m[32m    T5["REFETCH button clicked\nfullRefetch → confirm → nuke + reload"][m
[32m+[m[32m  end[m
[32m+[m
[32m+[m[32m  FYERS_REST --> FR[m
[32m+[m[32m  FYERS_REST --> RD[m
[32m+[m[32m  FYERS_REST --> PS[m
[32m+[m[32m  FYERS_WS --> LIVE[m
[32m+[m
[32m+[m[32m  FR --> MUTEX[m
[32m+[m[32m  RD --> MUTEX[m
[32m+[m[32m  PS --> MUTEX[m
[32m+[m
[32m+[m[32m  FR --> VCA[m
[32m+[m[32m  RD --> VCA[m
[32m+[m[32m  PS --> CPS[m
[32m+[m
[32m+[m[32m  VCA --> UPSERT[m
[32m+[m[32m  VH --> LOAD[m
[32m+[m[32m  CPS --> LOAD[m
[32m+[m
[32m+[m[32m  UPSERT --> POOL[m
[32m+[m[32m  LOAD --> POOL[m
[32m+[m[32m  PRUNE --> POOL[m
[32m+[m[32m  DEL --> POOL[m
[32m+[m[32m  QUERY --> POOL[m
[32m+[m
[32m+[m[32m  POOL --> CANDLES_T[m
[32m+[m[32m  POOL --> REPAIR_T[m
[32m+[m[32m  POOL --> VAL_T[m
[32m+[m
[32m+[m[32m  RECOVERY --> STATUS[m
[32m+[m[32m  VALIDATION --> STATUS[m
[32m+[m
[32m+[m[32m  CANDLES_T --> SERVER[m
[32m+[m[32m  SERVER --> FP[m
[32m+[m
[32m+[m[32m  LIVE --> UPSERT[m
[32m+[m
[32m+[m[32m  T1 --> PRUNE[m
[32m+[m[32m  T2 --> PS[m
[32m+[m[32m  T3 --> RD[m
[32m+[m[32m  T4 --> VH[m
[32m+[m[32m  T5 --> FR[m
[32m+[m[32m```[m
[32m+[m
[32m+[m[32m---[m
[32m+[m
[32m+[m[32m## Project-Level Architecture Diagram[m
[32m+[m
[32m+[m[32m```[m
[32m+[m[32m╔══════════════════════════════════════════════════════════════════════════════════╗[m
[32m+[m[32m║                         TGG TRADING PLATFORM — FULL STACK                        ║[m
[32m+[m[32m╚══════════════════════════════════════════════════════════════════════════════════╝[m
[32m+[m
[32m+[m[32m  ┌─────────────────────────────────────────────────────────────────────────────┐[m
[32m+[m[32m  │  BROWSER  (React SPA — localhost:3000)                                       │[m
[32m+[m[32m  │                                                                              │[m
[32m+[m[32m  │  App.js — Router                                                             │[m
[32m+[m[32m  │  ├── /              HomePage.js                                              │[m
[32m+[m[32m  │  ├── /charts        ChartsPage.js  ◄── main trading view                     │[m
[32m+[m[32m  │  ├── /reports       ReportsPage.js                                           │[m
[32m+[m[32m  │  ├── /fib-dashboard FibDashboardPage.js                                      │[m
[32m+[m[32m  │  ├── /scanner       ScannerPage.js                                           │[m
[32m+[m[32m  │  └── /strategies    StrategiesPage.js                                        │[m
[32m+[m[32m  │                                                                              │[m
[32m+[m[32m  │  ChartsPage layout: 1 / 2h / 2v / 3 / 4 panels                              │[m
[32m+[m[32m  │  Each panel = independent ChartPanel component                               │[m
[32m+[m[32m  │                                                                              │[m
[32m+[m[32m  │  ChartPanel                                                                  │[m
[32m+[m[32m  │  ├── useSocket()          hooks/useSocket.js                                 │[m
[32m+[m[32m  │  │     ├── socket.io-client  ◄──────────────────────── WS :9003             │[m
[32m+[m[32m  │  │     └── axios REST        ──────────────────────────► HTTP :9003         │[m
[32m+[m[32m  │  ├── CandleChart.js       lightweight-charts canvas                         │[m
[32m+[m[32m  │  │     ├── WavesIndicator.js                                                 │[m
[32m+[m[32m  │  │     ├── SRZonesIndicator.js                                               │[m
[32m+[m[32m  │  │     ├── ConsolidationIndicator.js                                         │[m
[32m+[m[32m  │  │     └── DrawingOverlay.js   (SVG drawing tools)                           │[m
[32m+[m[32m  │  ├── StatusBar.js         (OHLCV, EMA, market pill, VALIDATE/REFETCH btns)  │[m
[32m+[m[32m  │  ├── TradingToolbar.js    (global left toolbar, shared across panels)        │[m
[32m+[m[32m  │  ├── StatsPanel.js                                                           │[m
[32m+[m[32m  │  ├── WaveStatsPanel.js                                                       │[m
[32m+[m[32m  │  └── EmaFloatPanel.js                                                        │[m
[32m+[m[32m  └────────────────────┬────────────────────────────────────────────────────────┘[m
[32m+[m[32m                       │  HTTP + WebSocket[m
[32m+[m[32m                       ▼[m
[32m+[m[32m  ┌─────────────────────────────────────────────────────────────────────────────┐[m
[32m+[m[32m  │  BACKEND  (Node.js / Express — localhost:9003)                               │[m
[32m+[m[32m  │                                                                              │[m
[32m+[m[32m  │  server.js — central orchestrator                                            │[m
[32m+[m[32m  │  ├── Express REST routes                                                     │[m
[32m+[m[32m  │  │     GET  /api/chart                                                       │[m
[32m+[m[32m  │  │     POST /api/chart/refresh                                               │[m
[32m+[m[32m  │  │     GET  /api/auth/status                                                 │[m
[32m+[m[32m  │  │     GET  /api/auth/url                                                    │[m
[32m+[m[32m  │  │     POST /api/auth/callback                                               │[m
[32m+[m[32m  │  │     POST /api/db/validate                                                 │[m
[32m+[m[32m  │  │     POST /api/db/refetch                                                  │[m
[32m+[m[32m  │  │     GET  /api/db/repair-history                                           │[m
[32m+[m[32m  │  │     GET  /api/db/stats                                                    │[m
[32m+[m[32m  │  │     GET  /health                                                          │[m
[32m+[m[32m  │  │     /api/symbols  ──► symbolsRouter.js                                   │[m
[32m+[m[32m  │  │     /api/scanner  ──► scannerRouter.js ──► scannerRunner.js               │[m
[32m+[m[32m  │  │                                            └── strategies/                │[m
[32m+[m[32m  │  │                                                scannerS1.S2.S3.js         │[m
[32m+[m[32m  │  │                                                strategyRegistry.js        │[m
[32m+[m[32m  │  ├── Socket.IO server                                                        │[m
[32m+[m[32m  │  │     Rooms: "res:1", "res:3", "res:5", "res:15", "res:60", …               │[m
[32m+[m[32m  │  │     Maps:  socketSymbols{id→sym}   socketResolutions{id→res}              │[m
[32m+[m[32m  │  │     Emits: chart_update, tick_update, candle_update, new_candle,          │[m
[32m+[m[32m  │  │            market_status, repair_status                                   │[m
[32m+[m[32m  │  │     Handles: set_symbol, set_resolution, request_refresh, disconnect      │[m
[32m+[m[32m  │  │                                                                           │[m
[32m+[m[32m  │  ├── In-Memory Cache                                                         │[m
[32m+[m[32m  │  │     symbolCacheMap: Map<"SYM:res" → {candles[], result{}, lastFetch}>     │[m
[32m+[m[32m  │  │     candleBuilders:  Map<symbol → CandleBuilder>                          │[m
[32m+[m[32m  │  �