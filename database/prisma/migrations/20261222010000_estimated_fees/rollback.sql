-- 回滚 M-P6-20：删除 EstimatedFee（含索引、约束与行级安全策略），去掉 ProfitDaily.estimatedFee。
-- 丢失的数据：预估与自定义费用的录入。利润日表里已经含估算的金额保留到下一次重算（每 6 小时近 45 天）；之后利润里不再含估算。
-- 已关账期间的快照不受影响（快照里的数字已经固定）。
DROP TABLE IF EXISTS "EstimatedFee";
ALTER TABLE "ProfitDaily" DROP CONSTRAINT IF EXISTS "ProfitDaily_estimatedFee_check";
ALTER TABLE "ProfitDaily" DROP COLUMN IF EXISTS "estimatedFee";
