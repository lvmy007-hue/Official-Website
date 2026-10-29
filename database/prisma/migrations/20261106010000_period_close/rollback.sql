-- M-P2b-13 回滚：删除期间快照与会计期间两张表。
-- 说明：关账记录与快照是业务凭证，回滚后会丢失，请先导出。
-- 回滚不会改动 FxRate：已被关账锁定的汇率仍带着 lockedByPeriodId，数据库触发器仍会拒绝修改它们。
-- 回滚后若要解锁，用具有数据库所有者权限的账号执行：UPDATE "FxRate" SET "lockedByPeriodId" = NULL WHERE "lockedByPeriodId" IS NOT NULL;
-- （触发器只放行“把 lockedByPeriodId 置空”这一种修改）。
DROP TABLE IF EXISTS "PeriodSnapshot";
DROP TABLE IF EXISTS "AccountingPeriod";
