-- 回滚 M-P6-18：删除 ProfitItem、ProfitItemMapping、MetricVersion（含索引、约束、触发器与行级安全策略），并去掉 ProfitDaily.dutyCost、ProfitDaily.itemAmounts。
-- 丢失的数据：利润项目字典与映射（回滚后利润日表重新按内置口径归类）、口径版本记录、利润日表里已算出的关税与按项目拆分的金额。
-- 利润日表的净利润列在回滚后仍保留关税已扣减的结果，直到下一次重算（每 6 小时近 45 天）按旧口径刷新；已关账期间的行不重算，需要时在关账页重开。
DROP TABLE IF EXISTS "ProfitItemMapping";
DROP TABLE IF EXISTS "ProfitItem";
DROP FUNCTION IF EXISTS nova_profit_item_protect_system();
DROP TABLE IF EXISTS "MetricVersion";
ALTER TABLE "ProfitDaily" DROP CONSTRAINT IF EXISTS "ProfitDaily_itemAmounts_check";
ALTER TABLE "ProfitDaily" DROP CONSTRAINT IF EXISTS "ProfitDaily_dutyCost_check";
ALTER TABLE "ProfitDaily" DROP COLUMN IF EXISTS "itemAmounts";
ALTER TABLE "ProfitDaily" DROP COLUMN IF EXISTS "dutyCost";
