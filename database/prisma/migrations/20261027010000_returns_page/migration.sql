-- M-P2b-02 退货页：客户退货报告（R-26）补充退货明细列，幂等键改为按退货件编号区分。
-- 依据：07 章 7.2 退货列表与详情（退货件编号、运营中心、处置、买家备注、关联赔付）；importers.md R-26；models.md `FbaReturnCase` 修改行。
--
-- 内容：
--   一、FbaReturnCase 增加 7 列：fnsku、licensePlateNumber（退货件编号，默认空串，进唯一键所以不可空）、detailedDisposition（报告原处置值）、
--       fulfillmentCenterId（运营中心）、reportStatus（报告里的处理状态）、customerComments（买家备注，按非个人信息处理，页面默认隐藏）、
--       reimbursementCaseId（关联赔付案件，P2b-03 回填，本包只建列）。
--   二、既有退货行的 detailedDisposition 用原 disposition 回填（旧导入器把报告里的详细处置写在 disposition 列）；其余新列为空串或空，不编造值。
--   三、唯一键由 (卖家, 订单, ASIN, 退货时间) 改为 (卖家, 订单, ASIN, SKU, FNSKU, 退货件编号, 退货时间)：同一订单同一时间可能退回多个退货件。
--       新键是旧键的超集，既有数据不会冲突。
--   四、2 个索引：(tenantId, amazonOrderId) 供订单页与退货页按订单号取退货；(tenantId, returnDate) 供退货列表按日期范围翻页。
-- 回滚方法：见同目录 rollback.sql（同一订单同一时间有多个退货件的行会只保留一行，才能恢复旧唯一键）。

-- AlterTable
ALTER TABLE "FbaReturnCase"
  ADD COLUMN "fnsku" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "licensePlateNumber" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "detailedDisposition" TEXT,
  ADD COLUMN "fulfillmentCenterId" TEXT,
  ADD COLUMN "reportStatus" TEXT,
  ADD COLUMN "customerComments" TEXT,
  ADD COLUMN "reimbursementCaseId" TEXT;

-- 回填：旧导入器把报告里的详细处置写在 disposition 列
UPDATE "FbaReturnCase" SET "detailedDisposition" = "disposition" WHERE "disposition" IS NOT NULL;

-- 唯一键换成新键
DROP INDEX "FbaReturnCase_sellerAccountId_amazonOrderId_asin_returnDate_key";
CREATE UNIQUE INDEX "FbaReturnCase_report_uq" ON "FbaReturnCase"("sellerAccountId", "amazonOrderId", "asin", "sellerSku", "fnsku", "licensePlateNumber", "returnDate");

-- CreateIndex
CREATE INDEX "FbaReturnCase_order_idx" ON "FbaReturnCase"("tenantId", "amazonOrderId");

-- CreateIndex
CREATE INDEX "FbaReturnCase_date_idx" ON "FbaReturnCase"("tenantId", "returnDate");