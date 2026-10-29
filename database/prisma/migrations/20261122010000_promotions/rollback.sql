-- M-P4-05 回滚：移除促销与优惠券的四张表。
-- 说明：数据都是从亚马逊重新取回的只读副本（促销接口、促销绩效报告、优惠券绩效报告）；回滚后下一次定时任务会重新同步促销，
-- 绩效报告只重新申请最近一个窗口，更早的日期要在亚马逊保留期内手工重新申请。促销与优惠券两个页面在回滚后读不到表，请同时回退应用版本。
DROP TABLE IF EXISTS "CouponMetric";
DROP TABLE IF EXISTS "PromotionMetric";
DROP TABLE IF EXISTS "PromotionItem";
DROP TABLE IF EXISTS "Promotion";
