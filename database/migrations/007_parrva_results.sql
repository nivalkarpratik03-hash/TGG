-- ============================================================
-- PaRRVA call results (2026-11-13)
-- ============================================================
-- One row per PaRRVA call: the final result the dashboard worked out from
-- our own recorded prices (target / SL / trailed SL / exited / avoided ...).
-- Written by the backend after the close (15:31 IST, rewritten until 16:00).
-- Daily / Monthly read old days from here, so the raw recordings can be
-- deleted once the day's Parquet files are on Drive.
--
-- The backend also creates this table itself on start (same SQL), so the
-- dashboard works even if this migration has not been run yet.
-- Safe to re-run (IF NOT EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS parrva_results (
  call_id               BIGINT PRIMARY KEY,           -- PaRRVA recommendation id
  trade_date            DATE NOT NULL,                -- IST date the call was published
  advice_name           TEXT,                         -- e.g. TG1119
  label                 TEXT,                         -- e.g. NIFTY 25950 CE
  symbol                TEXT,                         -- Fyers option symbol
  side                  TEXT,                         -- BUY / SELL
  lot                   NUMERIC,
  published_at          TIMESTAMPTZ,
  entry_lo              NUMERIC,                      -- entry zone (last version)
  entry_hi              NUMERIC,
  target                NUMERIC,
  stop_loss             NUMERIC,                      -- last (possibly trailed) SL
  parrva_exit           NUMERIC,                      -- PaRRVA's exit price, if any
  result                TEXT NOT NULL,                -- TARGET, SL, TRAIL_SL, EXITED, CLOSED, AVOIDED, NOT_TRIGGERED, ...
  entry_at              TIMESTAMPTZ,
  entry_price           NUMERIC,                      -- real fill price inside the entry zone
  fill_type             TEXT,                         -- how the fill was found (open / edge / tick / band)
  exit_at               TIMESTAMPTZ,
  exit_price            NUMERIC,
  points                NUMERIC,                      -- official points per unit, from the zone edge
  real_points           NUMERIC,                      -- points from the real fill
  counted               BOOLEAN NOT NULL DEFAULT TRUE,-- false = published before the recorder started
  source                TEXT,                         -- recorded / parrva
  rules_version         INTEGER,
  recording_started_at  TIMESTAMPTZ,
  call                  JSONB,                        -- the call as we had it
  status                JSONB,                        -- the full worked-out status
  written_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS parrva_results_trade_date_idx ON parrva_results (trade_date);
