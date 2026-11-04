\set ON_ERROR_STOP on
\connect tgg

-- Re-applies read access explicitly. Safe to run anytime, including
-- repeatedly — does not touch postgres's own (admin) privileges, and
-- does not grant anything beyond SELECT.

GRANT CONNECT ON DATABASE tgg TO usera, userb, userc, userd;
GRANT USAGE ON SCHEMA public TO usera, userb, userc, userd;

-- Explicit per-table grant for candles specifically, in case it was
-- dropped/recreated after the earlier blanket grant ran.
GRANT SELECT ON TABLE public.candles TO usera, userb, userc, userd;

-- Re-apply the blanket grant too, in case OTHER tables have the same
-- issue (new/recreated tables since the last run).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO usera, userb, userc, userd;

-- Re-confirm default privileges for anything created after this point.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO usera, userb, userc, userd;
