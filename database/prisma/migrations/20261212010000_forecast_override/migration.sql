-- M-P6-09 补货可解释性补全：人工预测规则与“计入必断货量”开关。
-- 依据：14 章 P6-09，16 章第 4 节，freeze/models.md 第二十一节（ForecastOverride、ReplenishmentPolicy 修改）。
--
-- 内容：
--   一、新表 ForecastOverride：按时间段覆盖模型预测的人工规则。scopeType = SKU 或 CATEGORY；mode = FIXED（固定日销）
--      或 YOY_FACTOR（去年同期乘系数）；version 做乐观锁。from、to 是 SQL 保留字，列名用 fromDate、toDate（含首尾）。
--      同一对象时间段不重叠由服务保证（需要排他约束扩展，嵌入式测试库不带，没有放进数据库）。
--   二、ReplenishmentPolicy 新增 includeUnavoidableShortage（默认 false，旧版本一律不计入）。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入 ForecastOverride）。
--
-- 回滚方法：见同目录 rollback.sql（删表与删列；已冻结的批次建议里记录的规则说明留在计算链 JSON 里，不受影响）。

-- AlterTable
ALTER TABLE "ReplenishmentPolicy" ADD COLUMN "includeUnavoidableShortage" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ForecastOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForecastOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForecastOverride_scope_idx" ON "ForecastOverride"("tenantId", "scopeType", "scopeId", "fromDate");

-- AddForeignKey
ALTER TABLE "ForecastOverride" ADD CONSTRAINT "ForecastOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 取值与范围约束：固定日销 0 到 100 万件/天（0 表示这段时间不卖）；同期系数大于 0 且不超过 20；时间段含首尾且最长 366 天
ALTER TABLE "ForecastOverride" ADD CONSTRAINT "ForecastOverride_check" CHECK (
  "scopeType" IN ('SKU', 'CATEGORY')
  AND "mode" IN ('FIXED', 'YOY_FACTOR')
  AND char_length("scopeId") BETWEEN 1 AND 120
  AND "toDate" >= "fromDate"
  AND "toDate" - "fromDate" <= 365
  AND (("mode" = 'FIXED' AND "value" >= 0 AND "value" <= 1000000) OR ("mode" = 'YOY_FACTOR' AND "value" > 0 AND "value" <= 20))
  AND ("note" IS NULL OR char_length("note") <= 200)
  AND "version" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "ForecastOverride" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "ForecastOverride" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ForecastOverride" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ForecastOverride" TO nova_system;
  END IF;
END $$;
