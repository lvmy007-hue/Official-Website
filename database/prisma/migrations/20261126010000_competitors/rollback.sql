-- 回滚 M-P4-12：删除两张新表。
-- 竞品快照是亚马逊数据的只读副本，下一次同步会重新留存（历史趋势会丢失）；关注清单会丢失。
DROP TABLE IF EXISTS "CompetitorSnapshot";
DROP TABLE IF EXISTS "WatchedAsin";
