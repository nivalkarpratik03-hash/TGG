-- =====================================================================
-- setup_readonly_access.sql
-- Run this with: psql -d your_db_name -f setup_readonly_access.sql
--
-- IMPORTANT — per instructions: passwords are NEVER put in a file.
-- This script creates the roles with NO password. Right after running
-- it, set each login's password interactively in psql (see bottom of
-- this file) — that step is NOT in this script on purpose.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Group role — read-only, cannot log in directly
-- ---------------------------------------------------------------------
CREATE ROLE readonly_access NOLOGIN;

GRANT CONNECT ON DATABASE your_db_name TO readonly_access;
GRANT USAGE ON SCHEMA public TO readonly_access;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_access;

-- So tables created in the future also default to read-only for this group
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO readonly_access;

-- ---------------------------------------------------------------------
-- 2. Individual login roles for each colleague — created with NO
--    password here. LOGIN is granted, but nobody can connect until a
--    password is set (see the \password step below).
-- ---------------------------------------------------------------------
CREATE ROLE userW LOGIN;
CREATE ROLE userX   LOGIN;
CREATE ROLE userY LOGIN;
CREATE ROLE userZ  LOGIN;

GRANT readonly_access TO userW, userX, userY, userZ;

-- ---------------------------------------------------------------------
-- 3. Lock down PUBLIC's default access so nothing leaks outside the
--    explicit grants above.
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 4. (Reference only — do NOT run this as part of the script.)
--    Your own write/admin role already has full privileges as the table
--    owner. Nothing to grant here as long as you never GRANT INSERT /
--    UPDATE / DELETE / ALL to readonly_access or to the colleague roles
--    above.
-- ---------------------------------------------------------------------

-- =====================================================================
-- NEXT STEP — do this interactively in psql, NOT in any file:
--
--   psql -d tgg
--   \password userW
--   \password userX
--   \password userY
--   \password userZ
--
-- \password prompts for the new password at the terminal and it is
-- never echoed, logged, or written to disk by psql.
-- =====================================================================