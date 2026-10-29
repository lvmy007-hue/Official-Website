-- M-P6-08 发货地址与补货批次转入仓计划草稿。
-- 依据：14 章 P6-08，16 章第 4、5.2 节，freeze/models.md 第二十一节（ShipFromAddress、FbaInboundPlan 修改）。
--
-- 内容：
--   一、新表 ShipFromAddress：每个店铺可以有多个发货地址（入仓接口要求的名称、地址行、城市、州或省、邮编、国家、电话），
--      status=ACTIVE 使用中、INACTIVE 已停用；isDefault 标记店铺默认地址；version 做乐观锁。
--   二、约束：
--      同一店铺内地址名称唯一；每个店铺至多一个默认地址（部分唯一索引，Prisma 模型表达不了）；
--      默认地址必须是使用中（停用的地址不能当默认）；取值与长度检查；国家代码两位大写字母。
--   三、FbaInboundPlan 新增 shipFromAddressId（可空，外键 ON DELETE RESTRICT）：被入仓计划用过的地址删不掉，只能停用。
--   四、FbaInboundPlan 的来源类型检查约束增加取值 REPLENISHMENT_BATCH（补货批次转来的草稿，sourceRefId 存批次编号）；
--      旧取值 REPLENISHMENT 保留（P2a-12 的示例与历史数据可能用到），不改动任何已有行。
--   五、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入 ShipFromAddress）。
--
-- 回滚方法：见同目录 rollback.sql（先把引用地址的计划置空再删表；已生成的草稿保留，只是不再关联地址）。

-- CreateTable
CREATE TABLE "ShipFromAddress" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "stateOrProvince" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipFromAddress_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "FbaInboundPlan" ADD COLUMN "shipFromAddressId" TEXT;

-- CreateIndex
CREATE INDEX "ShipFromAddress_sellerAccountId_idx" ON "ShipFromAddress"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipFromAddress_tenantId_sellerAccountId_name_key" ON "ShipFromAddress"("tenantId", "sellerAccountId", "name");

-- CreateIndex
CREATE INDEX "FbaInboundPlan_shipFromAddressId_idx" ON "FbaInboundPlan"("shipFromAddressId");

-- AddForeignKey
ALTER TABLE "ShipFromAddress" ADD CONSTRAINT "ShipFromAddress_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipFromAddress" ADD CONSTRAINT "ShipFromAddress_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_shipFromAddressId_fkey" FOREIGN KEY ("shipFromAddressId") REFERENCES "ShipFromAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 取值与长度约束（长度上限与入仓接口的地址字段一致）
ALTER TABLE "ShipFromAddress" ADD CONSTRAINT "ShipFromAddress_check" CHECK (
  "status" IN ('ACTIVE', 'INACTIVE')
  AND char_length("name") BETWEEN 1 AND 50
  AND char_length("addressLine1") BETWEEN 1 AND 180
  AND ("addressLine2" IS NULL OR char_length("addressLine2") <= 60)
  AND char_length("city") BETWEEN 1 AND 50
  AND char_length("stateOrProvince") BETWEEN 1 AND 10
  AND char_length("postalCode") BETWEEN 1 AND 20
  AND "countryCode" ~ '^[A-Z]{2}$'
  AND char_length("phone") BETWEEN 1 AND 30
  AND ("isDefault" = false OR "status" = 'ACTIVE')
  AND "version" >= 1);

-- 每个店铺至多一个默认地址（部分唯一索引：Prisma 模型表达不了，migrate diff 不比较部分索引）
CREATE UNIQUE INDEX "ShipFromAddress_default_key" ON "ShipFromAddress"("tenantId", "sellerAccountId") WHERE "isDefault";

-- 入仓计划的来源类型增加 REPLENISHMENT_BATCH：先去掉旧检查约束，再用新取值重建（其余条件与 P2a-12 完全一致）
ALTER TABLE "FbaInboundPlan" DROP CONSTRAINT "FbaInboundPlan_inbound_check";
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_inbound_check" CHECK (
  "stage" IN ('DRAFT', 'ELIGIBILITY', 'CREATED', 'PACKING_CONFIRMED', 'PACKING_INFO_SUBMITTED', 'PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_PRINTED', 'SHIPPED', 'RECEIVING', 'DISCREPANCY', 'COMPLETED', 'CANCELLED')
  AND "sourceType" IN ('MANUAL', 'REPLENISHMENT', 'REPLENISHMENT_BATCH', 'PURCHASE_ORDER')
  AND "prepOwner" = 'SELLER' AND "labelOwner" = 'SELLER'
  AND ("shippingMode" IS NULL OR "shippingMode" IN ('SPD', 'LTL', 'FTL'))
  AND ("prepCost" IS NULL OR "prepCost" >= 0) AND ("labelCost" IS NULL OR "labelCost" >= 0)
  AND "version" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "ShipFromAddress" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "ShipFromAddress" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ShipFromAddress" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ShipFromAddress" TO nova_system;
  END IF;
END $$;
