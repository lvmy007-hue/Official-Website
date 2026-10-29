-- M-P2b-08 回滚：删除到账登记表，去掉财务交易的预计释放日列。
-- 说明：到账登记是人工录入的数据，回滚后会丢失，请先导出；预计释放日由下一次财务同步重新写入（递延交易会在 14 天回看窗口内补回）。
DROP TABLE IF EXISTS "Disbursement";
ALTER TABLE "FbaFinancialTransaction" DROP COLUMN IF EXISTS "maturityAt";
