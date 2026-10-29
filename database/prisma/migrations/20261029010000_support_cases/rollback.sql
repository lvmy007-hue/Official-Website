-- M-P2b-04 回滚：删除支持案件的两张表。
-- 说明：两张表都是亚马逊卖家支持数据的只读副本，没有任何我方录入的内容；回滚后再升级，下一次同步（每 2 小时）会重新取回。
DROP TABLE IF EXISTS "SupportContact";
DROP TABLE IF EXISTS "SupportCase";
