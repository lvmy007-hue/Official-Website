-- 回滚 M-P6-19：删除 AllocationRule（含索引、约束与行级安全策略），去掉 PeriodSnapshot.metricVersionSnapshotJson。
-- 丢失的数据：费用分摊规则、关账快照里记录的规则版本。利润日表里已经分摊到 SKU 的金额保留到下一次重算（每 6 小时近 45 天）；
-- 之后店铺级费用回到“留在店铺级行、不分摊”。已关账期间的行不重算，需要时在关账页重开。
DROP TABLE IF EXISTS "AllocationRule";
ALTER TABLE "PeriodSnapshot" DROP CONSTRAINT IF EXISTS "PeriodSnapshot_metricVersion_check";
ALTER TABLE "PeriodSnapshot" DROP COLUMN IF EXISTS "metricVersionSnapshotJson";
