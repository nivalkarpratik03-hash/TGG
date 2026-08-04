// frontend/src/utils/symbolsApi.js
//
// SINGLE SOURCE OF TRUTH for fetching + caching the /api/symbols list,
// previously copy-pasted byte-for-byte independently into 3 places:
// components/SymbolSearch.js, pages/FibDashboardPage.js, pages/ReportsPage.js.
//
// Diffed line-by-line before extracting (not assumed) — all 3 copies were
// identical: same module-level `_symbolsCache`/`_symbolsLoaded` pattern, same
// `${BACKEND}/api/symbols` URL, same empty-catch-swallow-error shape.
//
// REAL BEHAVIOR CHANGE, flagging per project convention (same as the
// format.js NaN note in Chunk 1) — NOT a guaranteed no-op swap:
// Before this consolidation, each of the 3 files had its OWN separate
// module-level cache. That meant if e.g. SymbolSearch.js had already fetched
// and cached the list, FibDashboardPage.js still did its own independent
// fetch once (its own cache started uncached). After this consolidation,
// all 3 files import the SAME module, so they share ONE cache — whichever
// file fetches first "warms" it for the other two, and they get the cached
// array instead of firing their own network request.
//   - Net effect: fewer redundant GET /api/symbols calls across a session
//     that uses more than one of these 3 views. This should be strictly
//     beneficial (same backend data, fewer round trips) since nothing in
//     any of the 3 original files ever called POST /api/symbols/refresh or
//     otherwise expected a fresh re-fetch per-mount (confirmed by grep —
//     the only frontend caller of the symbols API is this GET call, in
//     exactly these 3 places).
//   - Worth knowing regardless: if two of these views are both mounted at
//     once in the future (they aren't today — these are 3 separate routed
//     pages/modal, never simultaneously mounted) and one triggers the
//     fetch while the other reads a still-in-flight cache, the in-flight
//     request itself isn't de-duped (a second call before the first
//     resolves will fire a second fetch, same as before this change) —
//     that race existed identically pre-consolidation and is unchanged.

import { BACKEND } from "../config";

let _symbolsCache = [];
let _symbolsLoaded = false;

export async function loadSymbols() {
  if (_symbolsLoaded) return _symbolsCache;
  try {
    const r = await fetch(`${BACKEND}/api/symbols`);
    if (r.ok) _symbolsCache = await r.json();
  } catch { }
  _symbolsLoaded = true;
  return _symbolsCache;
}
