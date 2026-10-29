-- 回滚 M-P6-09：删除 ForecastOverride 与策略上的“计入必断货量”开关。
-- 已冻结的补货批次把当时用到的规则与必断货量写在建议的计算链 JSON 里，不依赖这两处，回滚后仍可回看。
DROP TABLE IF EXISTS "ForecastOverride";
ALTER TABLE "ReplenishmentPolicy" DROP COLUMN IF EXISTS "includeUnavoidableShortage";
