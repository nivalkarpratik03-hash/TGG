-- \set ON_ERROR_STOP on
-- \connect tgg

-- ALTER ROLE "userA" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
--     NOINHERIT NOREPLICATION;

-- GRANT CONNECT ON DATABASE tgg TO "userA";
-- GRANT USAGE ON SCHEMA public TO "userA";
-- REVOKE CREATE ON SCHEMA public FROM "userA";
-- REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "userA";
-- REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "userA";
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO "userA";
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     REVOKE ALL PRIVILEGES ON TABLES FROM "userA";
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT ON TABLES TO "userA";

\set ON_ERROR_STOP on
\connect tgg

-- NOTE: role names below are lowercase on purpose — Postgres folds
-- unquoted identifiers to lowercase, so "CREATE ROLE userA LOGIN;"
-- earlier actually created a role named `usera`, not `userA`. Using
-- double-quoted "userA" (as the original file did) looks for an
-- exact-case match that doesn't exist, hence the earlier error.
-- Keeping these UNQUOTED here (not double-quoted) so Postgres folds
-- them to lowercase automatically and they always match the real role,
-- regardless of how you type the name.

ALTER ROLE usera WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION;
ALTER ROLE userb WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION;
ALTER ROLE userc WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION;
ALTER ROLE userd WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION;

GRANT CONNECT ON DATABASE tgg TO usera, userb, userc, userd;
GRANT USAGE ON SCHEMA public TO usera, userb, userc, userd;
REVOKE CREATE ON SCHEMA public FROM usera, userb, userc, userd;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM usera, userb, userc, userd;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM usera, userb, userc, userd;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO usera, userb, userc, userd;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM usera, userb, userc, userd;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO usera, userb, userc, userd;