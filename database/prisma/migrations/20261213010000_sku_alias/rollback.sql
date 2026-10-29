-- 回滚 M-P6-11：删除外部货号映射与供应商装箱单列映射。
-- 已经按映射写进入仓计划装箱草稿里的箱子不依赖这两张表，回滚后不受影响。
DROP TABLE IF EXISTS "PackingListMapping";
DROP TABLE IF EXISTS "SkuAlias";
