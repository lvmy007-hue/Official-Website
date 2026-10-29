-- 回滚 M-P5-02：删除两张新表。
-- 快照与问题是亚马逊数据的只读副本，下一次同步会重新留存；历史趋势与人工处理记录（负责人、处理状态、备注、关联案件）会丢失。
DROP TABLE IF EXISTS "PolicyIssue";
DROP TABLE IF EXISTS "AccountHealthSnapshot";
