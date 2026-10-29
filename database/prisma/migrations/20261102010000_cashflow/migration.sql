-- M-P2b-08 回款与现金流。
-- 依据：freeze/models.md M-P2b-08（Disbursement、CashflowForecast）；07 章 7.8；14 章 P2b-08。
--
-- 内容：
--   一、FbaFinancialTransaction 加 maturityAt：递延交易的预计释放日（财务接口给了才有；分区表加列会自动带到各分区）。
--   二、新表 Disbursement：到账手工登记，一张结算单一条，带版本号（乐观锁）。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：不建 CashflowForecast——预测按请求现算（采购付款与头程费用没有店铺归属，存成按店铺的快照没有意义），见 CR-046。
--
-- 回滚方法：见同目录 rollback.sql（删 Disbursement 与 maturityAt 列；登记的到账记录是人工录入的，回滚后会丢，请先导出）。

-- AlterTable
ALTER TABLE "FbaFinancialTransaction" ADD COLUMN "maturityAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Disbursement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "disbursedAt" DATE NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "bankLast4" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Disbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_settlementId_key" ON "Disbursement"("settlementId");

-- CreateIndex
CREATE INDEX "Disbursement_date_idx" ON "Disbursement"("tenantId", "disbursedAt");

-- CreateIndex
CREATE INDEX "Disbursement_store_idx" ON "Disbursement"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_amount_check" CHECK ("amount" > 0);
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_version_check" CHECK ("version" >= 1);
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_bank_check" CHECK ("bankLast4" IS NULL OR "bankLast4" ~ '^[0-9]{4}$');

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['Disbursement'] LOOP
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
