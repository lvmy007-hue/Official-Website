-- M-P1-16 回滚：移除行级安全策略与授权，分区维护函数恢复为调用者权限。
-- 回滚后租户隔离只剩应用层一道防线，请仅在演练或紧急处置时执行。
DO $$
DECLARE
  tbl text;
  pol record;
BEGIN
  FOR pol IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
  FOR tbl IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', tbl);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nova_app;
    REVOKE USAGE ON SCHEMA public FROM nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nova_system;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nova_system;
    REVOKE EXECUTE ON FUNCTION nova_ensure_all_partitions(integer), nova_default_partition_rows() FROM nova_system;
    REVOKE USAGE ON SCHEMA public FROM nova_system;
  END IF;
END $$;

ALTER FUNCTION nova_ensure_all_partitions(integer) SECURITY INVOKER RESET search_path;
ALTER FUNCTION nova_default_partition_rows() SECURITY INVOKER RESET search_path;
GRANT EXECUTE ON FUNCTION nova_ensure_all_partitions(integer), nova_default_partition_rows() TO PUBLIC;
DROP FUNCTION IF EXISTS nova_current_tenant();
