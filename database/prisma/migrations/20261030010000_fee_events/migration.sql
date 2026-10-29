-- M-P2b-05 费用事件：9 类费用分类、子类型、交易状态、对账状态与备注、乐观锁版本。
-- 依据：freeze/models.md M-P2b-05（FbaFeeEvent 新增 feeCategory、reconciliationStatus）；07 章 7.5；14 章 P2b-05；importers.md I-02。
--
-- 内容：
--   一、FbaFeeEvent 加 8 列（FbaFeeEvent 是按月分区表，在分区父表上加列会自动覆盖全部分区）：
--       feeCategory（FULFILLMENT、COMMISSION、STORAGE、AGED_SURCHARGE、INBOUND_PLACEMENT、REMOVAL_DISPOSAL、REFUND、REIMBURSEMENT、OTHER，
--         外加 NON_FEE：销售收入、税、运费收入、促销折扣这类不是费用的明细，仍留在表里供财务汇总使用，但不属于 9 个页签；默认 OTHER，漏分类的写入点
--         会落在“其他调整”页签里被看见，而不是消失）、feeSubtype（路径最后一段）、transactionStatus（来源交易状态）、
--       reconciliationStatus（UNRECONCILED、DISCREPANCY、RECONCILED）、reconciliationNote、reconciledBy、reconciledAt、version（乐观锁）。
--   二、历史数据回填：按名称关键字分类（与 packages/api-contracts/src/fee-events.ts 的 FEE_RULES 同一串关键字，真实库测试核对两边一致）；
--       交易状态从来源交易（FbaFinancialTransaction，店铺 + 交易编号 + 入账时间）带过来。关键字分类是启发式，不是亚马逊的官方分类。
--   三、1 个索引 FbaFeeEvent(tenantId, feeCategory, postedAt)（页签列表与汇总按类别 + 日期取数）；2 个检查约束（类别与对账状态取值）。
--   行级安全与授权沿用 FbaFeeEvent 既有的（加列不改变），不需要改 regrant.sql。
--
-- 回滚方法：见同目录 rollback.sql（去掉新增的列、索引与约束；对账状态、备注与版本是人工录入，回滚会丢失，回滚前请先导出）。

-- AlterTable
ALTER TABLE "FbaFeeEvent"
ADD COLUMN "feeCategory" TEXT NOT NULL DEFAULT 'OTHER',
ADD COLUMN "feeSubtype" TEXT,
ADD COLUMN "transactionStatus" TEXT,
ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'UNRECONCILED',
ADD COLUMN "reconciliationNote" TEXT,
ADD COLUMN "reconciledBy" TEXT,
ADD COLUMN "reconciledAt" TIMESTAMP(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- 回填一：交易状态（只有财务接口来的行有来源交易）
UPDATE "FbaFeeEvent" e
SET "transactionStatus" = t."transactionStatus"
FROM "FbaFinancialTransaction" t
WHERE e."sourceRecordId" IS NOT NULL
  AND t."sellerAccountId" = e."sellerAccountId"
  AND t."externalTransactionId" = e."sourceRecordId"
  AND t."postedAt" = e."postedAt"
  AND t."transactionStatus" IS NOT NULL;

-- 回填二：分类与子类型。判断用的文字 = 来源交易类型 + 描述（财务接口来的行描述就是明细路径）+ 费用类型，只留英文字母并转小写。
UPDATE "FbaFeeEvent" e
SET "feeCategory" = CASE
      WHEN e."eventType" = 'STORAGE_FEE' THEN 'STORAGE'
      WHEN e."eventType" = 'INBOUND_NONCOMPLIANCE' THEN 'INBOUND_PLACEMENT'
      WHEN s.hay ~ 'reimburs|safet|warehousedamage|warehouselost|carrierdamage|damagedinbound|lostinbound' THEN 'REIMBURSEMENT'
      WHEN s.hay ~ 'refund|chargeback|atoz|guarantee' THEN 'REFUND'
      WHEN s.hay ~ 'removal|disposal|dispose' THEN 'REMOVAL_DISPOSAL'
      WHEN s.hay ~ 'agedinventory|agedsurcharge|longterm|ltsf|inventorysurcharge' THEN 'AGED_SURCHARGE'
      WHEN s.hay ~ 'inbound|placement|noncompliance|prepservice|labeling' THEN 'INBOUND_PLACEMENT'
      WHEN s.hay ~ 'storage|lowinventory|overage' THEN 'STORAGE'
      WHEN s.hay ~ 'commission|referral|variableclosing|closingfee' THEN 'COMMISSION'
      WHEN s.hay ~ 'fulfil|fbaper|fbaweight|pickandpack|weighthandling|fbafee|shippinghb' THEN 'FULFILLMENT'
      WHEN s.hay ~ 'principal|principle|productcharge|giftwrap|promotion|discount|proceeds|itemprice|ordercharge|shipping|tax|coupon' THEN 'NON_FEE'
      ELSE 'OTHER'
    END,
    "feeSubtype" = CASE
      WHEN e."eventType" = 'STORAGE_FEE' THEN 'STORAGE_FEE'
      ELSE NULLIF(left(btrim(regexp_replace(coalesce(e."description", e."eventType", ''), '^.*/', '')), 120), '')
    END
FROM (
  SELECT f."id", f."postedAt",
         lower(regexp_replace(coalesce(t."transactionType", '') || coalesce(f."description", '') || coalesce(f."eventType", ''), '[^a-zA-Z]', '', 'g')) AS hay
  FROM "FbaFeeEvent" f
  LEFT JOIN "FbaFinancialTransaction" t
    ON f."sourceRecordId" IS NOT NULL
   AND t."sellerAccountId" = f."sellerAccountId"
   AND t."externalTransactionId" = f."sourceRecordId"
   AND t."postedAt" = f."postedAt"
) s
WHERE e."id" = s."id" AND e."postedAt" = s."postedAt";

-- CreateIndex
CREATE INDEX "FbaFeeEvent_tenantId_feeCategory_postedAt_idx" ON "FbaFeeEvent"("tenantId", "feeCategory", "postedAt");

-- 检查约束（回填之后再加）
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_feeCategory_check"
  CHECK ("feeCategory" IN ('FULFILLMENT', 'COMMISSION', 'STORAGE', 'AGED_SURCHARGE', 'INBOUND_PLACEMENT', 'REMOVAL_DISPOSAL', 'REFUND', 'REIMBURSEMENT', 'OTHER', 'NON_FEE'));
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_reconciliationStatus_check"
  CHECK ("reconciliationStatus" IN ('UNRECONCILED', 'DISCREPANCY', 'RECONCILED'));
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_version_check" CHECK ("version" >= 1);
