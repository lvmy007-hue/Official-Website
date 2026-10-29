-- M-P2b-12 销售税。
-- 依据：freeze/models.md M-P2b-12（SalesTaxSummary）；07 章 7.11；importers.md R-33；14 章 P2b-12。
--
-- 内容：新表 SalesTaxSummary（税务文档库报告按 店铺 × 日期 × 州 × 辖区 × 税种 汇总的代收代缴税额），检查约束与行级安全授权。
-- 与冻结的出入：taxPeriod 存“日”而不是“月”（报告可以分段生成，按日存后一份报告不会覆盖前一份的半个月，页面按月汇总），见 CR-050。
--
-- 回滚方法：见同目录 rollback.sql（删除 SalesTaxSummary；它是报告导入的派生汇总，回滚后下一次检索到报告会重新导入，最多回看 90 天）。

-- CreateTable
CREATE TABLE "SalesTaxSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "taxPeriod" DATE NOT NULL,
    "state" TEXT NOT NULL,
    "jurisdictionKey" TEXT NOT NULL DEFAULT '',
    "taxKind" TEXT NOT NULL DEFAULT 'SALES_TAX',
    "source" TEXT NOT NULL,
    "taxableSales" DECIMAL(20,6),
    "taxCollected" DECIMAL(20,6) NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceReportJobId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxSummary_uq" ON "SalesTaxSummary"("sellerAccountId", "taxPeriod", "state", "jurisdictionKey", "taxKind", "source");

-- CreateIndex
CREATE INDEX "SalesTaxSummary_period_idx" ON "SalesTaxSummary"("tenantId", "taxPeriod");

-- CreateIndex
CREATE INDEX "SalesTaxSummary_store_idx" ON "SalesTaxSummary"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "SalesTaxSummary" ADD CONSTRAINT "SalesTaxSummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTaxSummary" ADD CONSTRAINT "SalesTaxSummary_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：来源只有三种（冻结的 Enum）；行数不为负；州不为空
ALTER TABLE "SalesTaxSummary" ADD CONSTRAINT "SalesTaxSummary_source_check" CHECK ("source" IN ('TAX_LIBRARY', 'ORDER_API', 'SHIPMENT_REPORT'));
ALTER TABLE "SalesTaxSummary" ADD CONSTRAINT "SalesTaxSummary_lines_check" CHECK ("lineCount" >= 0);
ALTER TABLE "SalesTaxSummary" ADD CONSTRAINT "SalesTaxSummary_state_check" CHECK (length(btrim("state")) > 0);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SalesTaxSummary'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', tbl);
    END IF;
  END LOOP;
END $$;
