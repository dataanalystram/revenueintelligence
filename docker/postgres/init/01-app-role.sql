-- DEVELOPMENT ONLY. Creates the application's group role and a login role with
-- a well-known password. In real environments ops create the login role with
-- a secret password (see docs/operations/database-roles.md). The migration
-- also creates lip_app if it does not exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_app') THEN
    CREATE ROLE lip_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_api') THEN
    CREATE ROLE lip_api LOGIN PASSWORD 'lip_api' NOSUPERUSER NOBYPASSRLS IN ROLE lip_app;
  END IF;
END
$$;
