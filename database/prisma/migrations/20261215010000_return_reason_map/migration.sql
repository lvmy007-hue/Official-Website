-- M-P6-13 退货原因映射、下单时间冗余列：退货原因映射表，退货记录增加下单时间与发货时间。
-- 依据：14 章 P6-13，16 章第 6 节，freeze/models.md 第二十一节（ReturnReasonMap、FbaReturnCase 修改）。
--
-- 内容：
--   一、新表 ReturnReasonMap：亚马逊退货原因代码 → 中文释义 → 大类（约 12 个，含“未分类”）。主键 id（与其他租户表一致，通用的导出、清理、隔离测试都按 id 取行），(tenantId, code) 唯一。
--      预置的代码在代码里（契约 RETURN_REASON_PRESETS），本表只存企业改过的预置项（isSystem = true）、自己加的项，
--      以及导入退货报告时发现的、预置里没有的新代码（isSystem = false，大类为“未分类”）。
--   二、FbaReturnCase 增加 orderPurchasedAt（下单时间）、orderShippedAt（发货时间）两个可空列：同步退货报告后按订单回填；
--      订单还没有同步下来的保持为空（不是 0，也不用退货时间代替），页面单独计数“无法计算周期 N 条”。
--      本迁移同时对存量退货做一次回填（同一订单有多个下单时间的取最早的一个）；之后由退货报告导入与每日回填任务补齐。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表、新索引与两个新列；列里的数据可由订单重新回填）。

-- CreateTable
CREATE TABLE "ReturnReasonMap" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "labelZh" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnReasonMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnReasonMap_tenantId_code_key" ON "ReturnReasonMap"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "ReturnReasonMap" ADD CONSTRAINT "ReturnReasonMap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 长度约束（代码、中文释义与大类都不能为空，也不能过长）
ALTER TABLE "ReturnReasonMap" ADD CONSTRAINT "ReturnReasonMap_check" CHECK (
  char_length("code") BETWEEN 1 AND 80
  AND char_length("labelZh") BETWEEN 1 AND 60
  AND char_length("category") BETWEEN 1 AND 30);

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "ReturnReasonMap" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "ReturnReasonMap" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "ReturnReasonMap" TO nova_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "ReturnReasonMap" TO nova_system';
  END IF;
END $$;

-- 退货记录：下单时间与发货时间（冗余列）
ALTER TABLE "FbaReturnCase" ADD COLUMN "orderPurchasedAt" TIMESTAMP(3);
ALTER TABLE "FbaReturnCase" ADD COLUMN "orderShippedAt" TIMESTAMP(3);

-- 存量回填：按（店铺、订单号）找订单；同一订单有多个下单时间时取最早的一个；找不到订单的保持为空
UPDATE "FbaReturnCase" r SET
  "orderPurchasedAt" = (
    SELECT o."purchaseDate" FROM "Order" o
    WHERE o."sellerAccountId" = r."sellerAccountId" AND o."amazonOrderId" = r."amazonOrderId"
    ORDER BY o."purchaseDate" ASC LIMIT 1),
  "orderShippedAt" = (
    SELECT o."shippedAt" FROM "Order" o
    WHERE o."sellerAccountId" = r."sellerAccountId" AND o."amazonOrderId" = r."amazonOrderId"
    ORDER BY o."purchaseDate" ASC LIMIT 1);

-- CreateIndex
CREATE INDEX "FbaReturnCase_orderdate_idx" ON "FbaReturnCase"("tenantId", "orderPurchasedAt");
