-- M-P4-04 回滚：移除品牌分析的五张表。
-- 说明：数据都是从亚马逊重新申请的报告（品牌分析报告按周、月、季发布，保留期有限）；回滚后下一次定时任务只会重新申请最近一个周期，
-- 更早的周期要在亚马逊保留期内手工重新申请。品牌分析五个页面在回滚后读不到表，请同时回退应用版本。
DROP TABLE IF EXISTS "BrandRepeatPurchase";
DROP TABLE IF EXISTS "BrandMarketBasket";
DROP TABLE IF EXISTS "BrandSearchTerm";
DROP TABLE IF EXISTS "BrandSearchCatalogPerformance";
DROP TABLE IF EXISTS "BrandSearchQueryPerformance";
