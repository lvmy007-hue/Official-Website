-- M-P2b-07 回滚：删除结算核对的三张新表，去掉 FbaSettlement 的补列。
-- 说明：三张新表与补列都由结算报告和后台核对重新生成；回滚后结算报告明细要重新导入（原始报告文件在对象存储里）。
-- 系统账号写在费用明细与财务交易上的“已对账”标记不在这里还原。
DROP TABLE IF EXISTS "ReconciliationException";
DROP TABLE IF EXISTS "Reconciliation";
DROP TABLE IF EXISTS "SettlementLine";
ALTER TABLE "FbaSettlement" DROP CONSTRAINT IF EXISTS "FbaSettlement_reconciliation_check";
DROP INDEX IF EXISTS "FbaSettlement_sort_idx";
ALTER TABLE "FbaSettlement"
  DROP COLUMN IF EXISTS "openingBalance",
  DROP COLUMN IF EXISTS "disbursementAmount",
  DROP COLUMN IF EXISTS "txnCount",
  DROP COLUMN IF EXISTS "reconciliationStatus",
  DROP COLUMN IF EXISTS "diffAmount",
  DROP COLUMN IF EXISTS "summaryJson",
  DROP COLUMN IF EXISTS "sortAt";
