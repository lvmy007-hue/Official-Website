-- M-P1-13：权限升级。字段级权限 FieldPermission、成员邀请 MemberInvitation、7 个预设角色、
-- 旧 16 个权限点按冻结映射展开（旧点位保留，仍可识别 12 个月）、预设角色保护触发器。
-- 回滚方法见同目录 rollback.sql。Role 表沿用已有的 system（预设角色标记）与 version（权限版本号）两列。

CREATE TABLE "FieldPermission" (
  "id" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "fieldKey" TEXT NOT NULL,
  "allowed" BOOLEAN NOT NULL,
  CONSTRAINT "FieldPermission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldPermission_fieldKey_check" CHECK ("fieldKey" IN ('cost', 'profit', 'buyer'))
);
CREATE UNIQUE INDEX "FieldPermission_roleId_fieldKey_key" ON "FieldPermission"("roleId", "fieldKey");
ALTER TABLE "FieldPermission" ADD CONSTRAINT "FieldPermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MemberInvitation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "scopeSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "invitedBy" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemberInvitation_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'))
);
CREATE UNIQUE INDEX "MemberInvitation_tokenHash_key" ON "MemberInvitation"("tokenHash");
CREATE INDEX "MemberInvitation_tenantId_email_status_idx" ON "MemberInvitation"("tenantId", "email", "status");
CREATE INDEX "MemberInvitation_roleId_idx" ON "MemberInvitation"("roleId");
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 同一企业同一邮箱同时只能有一个待接受的邀请（部分唯一索引）。
CREATE UNIQUE INDEX "MemberInvitation_pending_email_key" ON "MemberInvitation"("tenantId", "email") WHERE "status" = 'PENDING';

-- 1. 旧权限展开：持有旧权限的角色自动获得对应的新权限（保留旧点位本身）；通配角色不动。
--    字段权限不放进权限数组，单独写入 FieldPermission（见第 2 步）。
UPDATE "Role" r
SET "permissions" = expanded.permissions, "version" = r."version" + 1
FROM (
  SELECT r2."id" AS role_id,
         (SELECT COALESCE(jsonb_agg(DISTINCT p ORDER BY p), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(r2."permissions") AS p
            UNION
            SELECT m.new_key
            FROM (VALUES
    ('entity.read', 'entity.read'),
    ('entity.write', 'entity.write'),
    ('seller.read', 'products.read'),
    ('seller.read', 'inventory.read'),
    ('seller.read', 'inbound.read'),
    ('seller.read', 'purchase.read'),
    ('seller.read', 'supplier.read'),
    ('seller.read', 'warehouse.read'),
    ('seller.read', 'reports.read'),
    ('seller.read', 'connection.read'),
    ('seller.read', 'sync.read'),
    ('seller.write', 'inbound.plan.write'),
    ('seller.write', 'purchase.order.write'),
    ('seller.write', 'reports.create'),
    ('connection.manage', 'connection.manage'),
    ('connection.manage', 'notifications.manage'),
    ('orders.read', 'orders.read'),
    ('orders.read', 'returns.read'),
    ('refunds.read', 'returns.read'),
    ('refunds.read', 'reimbursements.read'),
    ('finance.read', 'finance.read'),
    ('finance.read', 'profit.read'),
    ('ads.read', 'ads.read'),
    ('ads.report', 'ads.report'),
    ('sync.manage', 'sync.manage'),
    ('sync.manage', 'sync.read'),
    ('export.create', 'export.create'),
    ('member.read', 'member.read'),
    ('member.invite', 'member.invite'),
    ('role.manage', 'role.manage'),
    ('role.manage', 'member.manage'),
    ('audit.read', 'audit.read')
            ) AS m(old_key, new_key)
            WHERE m.old_key IN (SELECT jsonb_array_elements_text(r2."permissions"))
          ) x) AS permissions
  FROM "Role" r2
  WHERE jsonb_typeof(r2."permissions") = 'array' AND NOT (r2."permissions" @> '["*"]'::jsonb)
) expanded
WHERE r."id" = expanded.role_id;

-- 1b. 权限版本 2 起，角色保存的就是新体系点位（不再按旧映射展开）；此后新建的角色默认即为版本 2。
ALTER TABLE "Role" ALTER COLUMN "version" SET DEFAULT 2;

-- 2. 仅 finance.read 因历史上可见利润类数据，映射为利润字段权限；成本与买家信息不放开。
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed")
SELECT 'fp_' || r."id" || '_profit', r."id", 'profit', true
FROM "Role" r
WHERE jsonb_typeof(r."permissions") = 'array' AND r."permissions" @> '["finance.read"]'::jsonb AND NOT (r."permissions" @> '["*"]'::jsonb);

-- 3. 预设角色（全局，tenantId 为空）
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-owner', NULL, '所有者', '["*"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_owner_cost', 'preset-owner', 'cost', true);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_owner_profit', 'preset-owner', 'profit', true);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_owner_buyer', 'preset-owner', 'buyer', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-admin', NULL, '管理员', '["overview.read","workitem.read","workitem.assign","workitem.handle","targets.read","targets.write","collab.write","export.create","analytics.read","analytics.brand.read","products.read","catalog.meta.write","listing.read","listing.write","pricing.read","pricing.price.write","pricing.rule.write","competitors.read","competitors.write","reviews.read","reviews.solicit","aplus.read","aplus.write","costs.read","costs.write","inventory.read","inventory.removal.receive","replenishment.read","replenishment.plan.create","replenishment.policy.write","awd.read","awd.order.write","purchase.read","purchase.order.write","purchase.order.approve","purchase.receive","purchase.pay","supplier.read","supplier.write","warehouse.read","warehouse.stockcount.write","warehouse.stockcount.approve","firstmile.read","firstmile.write","inbound.read","inbound.plan.write","orders.read","returns.read","reimbursements.read","reimbursements.write","support.read","finance.read","finance.reconcile","finance.tax.read","profit.read","finance.policy.write","finance.period.close","finance.period.reopen","settings.fx.write","ads.read","ads.report","ads.campaign.write","ads.budget.write","ads.bid.write","ads.negative.write","ads.keyword.write","ads.placement.write","ads.portfolio.write","ads.rule.write","ads.account.bind","alerts.read","alerts.handle","alerts.manage","account.health.read","reports.read","reports.create","data.import","connection.read","connection.manage","notifications.manage","sync.read","sync.manage","entity.read","entity.write","member.read","member.invite","member.manage","role.manage","audit.read","settings.read","settings.write","settings.integration.write"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_admin_cost', 'preset-admin', 'cost', true);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_admin_profit', 'preset-admin', 'profit', true);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_admin_buyer', 'preset-admin', 'buyer', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-ops', NULL, '运营', '["overview.read","workitem.read","workitem.assign","workitem.handle","targets.read","targets.write","collab.write","export.create","analytics.read","analytics.brand.read","products.read","catalog.meta.write","listing.read","listing.write","pricing.read","pricing.price.write","pricing.rule.write","competitors.read","competitors.write","reviews.read","reviews.solicit","aplus.read","aplus.write","inventory.read","replenishment.read","replenishment.plan.create","awd.read","inbound.read","orders.read","returns.read","profit.read","ads.read","alerts.read","alerts.handle","account.health.read","reports.read","reports.create","data.import","connection.read","sync.read","sync.manage","entity.read"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_ops_profit', 'preset-ops', 'profit', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-ads', NULL, '广告', '["overview.read","workitem.read","workitem.assign","workitem.handle","targets.read","collab.write","export.create","analytics.read","analytics.brand.read","products.read","catalog.meta.write","listing.read","pricing.read","competitors.read","competitors.write","reviews.read","aplus.read","inventory.read","orders.read","profit.read","ads.read","ads.report","ads.campaign.write","ads.budget.write","ads.bid.write","ads.negative.write","ads.keyword.write","ads.placement.write","ads.portfolio.write","ads.rule.write","alerts.read","alerts.handle","reports.read","reports.create","connection.read","sync.read","sync.manage","entity.read"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_ads_profit', 'preset-ads', 'profit', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-finance', NULL, '财务', '["overview.read","workitem.read","workitem.assign","workitem.handle","targets.read","targets.write","collab.write","export.create","analytics.read","products.read","pricing.read","costs.read","costs.write","inventory.read","replenishment.read","purchase.read","purchase.order.approve","purchase.pay","supplier.read","warehouse.read","warehouse.stockcount.approve","firstmile.read","inbound.read","orders.read","returns.read","reimbursements.read","reimbursements.write","support.read","finance.read","finance.reconcile","finance.tax.read","profit.read","finance.policy.write","finance.period.close","settings.fx.write","ads.read","alerts.read","alerts.handle","reports.read","reports.create","data.import","connection.read","sync.read","entity.read","settings.read"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_finance_cost', 'preset-finance', 'cost', true);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_finance_profit', 'preset-finance', 'profit', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-supply', NULL, '供应链', '["overview.read","workitem.read","workitem.assign","workitem.handle","targets.read","collab.write","export.create","analytics.read","products.read","catalog.meta.write","reviews.read","costs.read","costs.write","inventory.read","inventory.removal.receive","replenishment.read","replenishment.plan.create","replenishment.policy.write","awd.read","awd.order.write","purchase.read","purchase.order.write","purchase.receive","supplier.read","supplier.write","warehouse.read","warehouse.stockcount.write","firstmile.read","firstmile.write","inbound.read","inbound.plan.write","returns.read","reimbursements.read","reimbursements.write","support.read","alerts.read","alerts.handle","reports.read","reports.create","data.import","connection.read","sync.read","sync.manage","entity.read"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);
INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES ('fp_supply_cost', 'preset-supply', 'cost', true);
INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")
VALUES ('preset-readonly', NULL, '只读', '["overview.read","workitem.read","targets.read","analytics.read","analytics.brand.read","products.read","listing.read","pricing.read","competitors.read","reviews.read","aplus.read","inventory.read","replenishment.read","awd.read","purchase.read","supplier.read","warehouse.read","firstmile.read","inbound.read","orders.read","returns.read","reimbursements.read","support.read","finance.read","ads.read","alerts.read","account.health.read","reports.read","connection.read","sync.read","entity.read"]'::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);

-- 4. 预设角色保护：预设（全局且 system）不可修改、不可删除；其字段权限同样不可变更。
--    复制预设角色得到的是租户自己的角色（tenantId 不为空），可以自由修改。
CREATE FUNCTION nova_protect_preset_roles() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Role' THEN
    IF OLD."tenantId" IS NULL AND OLD."system" THEN
      RAISE EXCEPTION '预设角色不可修改或删除（%）', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'FieldPermission' THEN
    IF EXISTS (SELECT 1 FROM "Role" r WHERE r."id" = OLD."roleId" AND r."tenantId" IS NULL AND r."system") THEN
      RAISE EXCEPTION '预设角色的字段权限不可修改或删除（%）', OLD."roleId" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Role_protect_preset" BEFORE UPDATE OR DELETE ON "Role" FOR EACH ROW EXECUTE FUNCTION nova_protect_preset_roles();
CREATE TRIGGER "FieldPermission_protect_preset" BEFORE UPDATE OR DELETE ON "FieldPermission" FOR EACH ROW EXECUTE FUNCTION nova_protect_preset_roles();
