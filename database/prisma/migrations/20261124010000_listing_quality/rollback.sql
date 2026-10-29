-- M-P4-10 回滚：移除刊登质量与合规的四张表。
-- 说明：ListingSnapshot、ListingIssue、ListingChangeEvent 是亚马逊数据的只读副本，回滚后下一次刊登同步会重新取回当前状态（问题的“首次出现时间”与已解决的历史、变更事件不可恢复）；
-- ListingWriteRun 里的校验预览、修改与批量任务、刊登限制查询记录会丢失（亚马逊侧已提交的修改不受影响）。刊登质量页面在回滚后读不到表，请同时回退应用版本。
DROP TABLE IF EXISTS "ListingWriteRun";
DROP TABLE IF EXISTS "ListingChangeEvent";
DROP TABLE IF EXISTS "ListingIssue";
DROP TABLE IF EXISTS "ListingSnapshot";
