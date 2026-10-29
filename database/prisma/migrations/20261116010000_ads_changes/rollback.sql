-- M-P3-14 回滚：删除广告变更记录与实体快照两张表。
-- 说明：外部变更记录与快照是 worker 对比出来的，回滚后重新迁移会从下一次快照重新开始，丢失的历史变更无法找回；
-- 手动、自动规则、分时策略三类变更要等 P3-17 的广告写入才会有，目前没有程序写入。

DROP TABLE IF EXISTS "AdsChangeLog";
DROP TABLE IF EXISTS "AdsEntitySnapshot";
