-- M-P4-01 回滚：移除销售与流量的三张表。
-- 说明：数据都是从亚马逊重新拉取的（数据中心只保留 730 天，回滚后第一次定时任务会回补最近 90 天，更早的历史需要在保留期内另行回补）；
-- 经营日汇总与 ASIN 日汇总里来自数据中心的会话、浏览量、购物车获得率与订购口径销售额，会在下一次汇总刷新时退回订单表估算（salesSource 改回 ORDERS）。
DROP TABLE IF EXISTS "SalesTrafficDiff";
DROP TABLE IF EXISTS "SalesTrafficAsinDaily";
DROP TABLE IF EXISTS "SalesTrafficDaily";
