-- M-P1-16 租户隔离：行级安全策略 + 最小权限 + 分区维护函数改为定义者权限。
--
-- 连接分两类账号（由运维在数据库里提前创建，见 database/ops/roles.sql；本迁移只在账号存在时授权）：
--   nova_app     接口服务与后台任务的租户连接。普通账号：非超级用户、不绕过行级安全、不是表的所有者。
--                每次访问先设置 app.tenant_id，策略只放行该租户的行。
--   nova_system  系统连接（登录、授权回调、后台调度、平台运营）。允许绕过行级安全，只在明确的系统流程中使用。
-- 迁移与运维使用表的所有者账号，与以上两个账号都不同。

-- 1. 当前租户：读取事务级会话变量；没设置（含连接池复用后残留的空串）一律视为“没有租户”。
CREATE OR REPLACE FUNCTION nova_current_tenant() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;

-- 2. 带 tenantId 列的租户表：启用行级安全，读写都只放行当前租户的行。
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'MemberInvitation', 'Membership', 'LegalEntity', 'MembershipScope', 'SellerAccount', 'PlatformConnection', 'OAuthState',
    'Order', 'InventorySnapshot', 'SyncJob', 'AuditEvent', 'IdempotencyRecord', 'StepUpVerification',
    'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaFeeEvent', 'FbaReturnCase', 'FbaReportJob',
    'AdsProfile', 'AdsCampaign', 'AdsReportJob', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric',
    'Supplier', 'PurchaseOrder', 'Warehouse', 'InventoryMovement'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
  END LOOP;
END $$;

-- 3. 角色：平台预设角色（tenantId 为空）所有租户可读，但只有自己租户的角色可以增删改。
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "Role" FOR SELECT USING ("tenantId" = (SELECT nova_current_tenant()) OR "tenantId" IS NULL);
CREATE POLICY tenant_insert ON "Role" FOR INSERT WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
CREATE POLICY tenant_update ON "Role" FOR UPDATE USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
CREATE POLICY tenant_delete ON "Role" FOR DELETE USING ("tenantId" = (SELECT nova_current_tenant()));

-- 4. 企业本身：只能读取与修改自己这一行。
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "Tenant" FOR SELECT USING ("id" = (SELECT nova_current_tenant()));
CREATE POLICY tenant_update ON "Tenant" FOR UPDATE USING ("id" = (SELECT nova_current_tenant())) WITH CHECK ("id" = (SELECT nova_current_tenant()));

-- 5. 用户是全局身份：租户连接只能读取自己企业成员的用户，且不能改写。
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "User" FOR SELECT USING (EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = "User"."id"));

-- 6. 没有 tenantId 列的子表：通过上级对象归属租户（上级对象本身受行级安全约束）。
ALTER TABLE "FieldPermission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "FieldPermission" FOR SELECT USING (EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = "FieldPermission"."roleId"));
CREATE POLICY tenant_write ON "FieldPermission" FOR ALL
  USING (EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = "FieldPermission"."roleId" AND r."tenantId" = (SELECT nova_current_tenant())))
  WITH CHECK (EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = "FieldPermission"."roleId" AND r."tenantId" = (SELECT nova_current_tenant())));

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrderLine"
  USING (EXISTS (SELECT 1 FROM "PurchaseOrder" p WHERE p."id" = "PurchaseOrderLine"."purchaseOrderId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "PurchaseOrder" p WHERE p."id" = "PurchaseOrderLine"."purchaseOrderId"));

ALTER TABLE "FbaInboundShipment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FbaInboundShipment"
  USING (EXISTS (SELECT 1 FROM "FbaInboundPlan" p WHERE p."id" = "FbaInboundShipment"."planId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "FbaInboundPlan" p WHERE p."id" = "FbaInboundShipment"."planId"));

ALTER TABLE "ConnectionHealth" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ConnectionHealth"
  USING (EXISTS (SELECT 1 FROM "PlatformConnection" c WHERE c."id" = "ConnectionHealth"."connectionId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "PlatformConnection" c WHERE c."id" = "ConnectionHealth"."connectionId"));

-- 7. 分区维护函数：改为定义者权限（以所有者身份执行），系统连接不必成为表的所有者也能维护分区。
ALTER FUNCTION nova_ensure_all_partitions(integer) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION nova_default_partition_rows() SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION nova_ensure_all_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION nova_default_partition_rows() FROM PUBLIC;

-- 8. 授权（账号存在才授权）。租户连接只拿到业务必需的最小权限：
--    审计事件只增不改；用户只读；企业可读可改；会话、商务与表单类表不开放。
DO $$
DECLARE
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT USAGE ON SCHEMA public TO nova_app;
    FOREACH tbl IN ARRAY ARRAY[
      'MemberInvitation', 'Membership', 'LegalEntity', 'MembershipScope', 'SellerAccount', 'PlatformConnection', 'OAuthState',
      'Order', 'InventorySnapshot', 'SyncJob', 'IdempotencyRecord', 'StepUpVerification',
      'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaFeeEvent', 'FbaReturnCase', 'FbaReportJob',
      'AdsProfile', 'AdsCampaign', 'AdsReportJob', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric',
      'Supplier', 'PurchaseOrder', 'Warehouse', 'InventoryMovement', 'Role',
      'FieldPermission', 'PurchaseOrderLine', 'FbaInboundShipment', 'ConnectionHealth'
    ] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END LOOP;
    GRANT SELECT, INSERT ON "AuditEvent" TO nova_app;
    GRANT SELECT ON "User" TO nova_app;
    GRANT SELECT, UPDATE ON "Tenant" TO nova_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT USAGE ON SCHEMA public TO nova_system;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nova_system;
    GRANT EXECUTE ON FUNCTION nova_ensure_all_partitions(integer), nova_default_partition_rows(), nova_current_tenant() TO nova_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nova_system;
  END IF;
END $$;
