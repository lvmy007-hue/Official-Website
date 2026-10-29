-- 回滚 M-P4-13：删除五张新表。
-- 评分文件需要重新导入；亚马逊的评论主题与类目趋势下一次同步会重新取回；请求评价的记录会丢失（丢失后同一订单可能被再次请求，亚马逊自己也会拒绝重复请求）。
DROP TABLE IF EXISTS "SolicitationRequest";
DROP TABLE IF EXISTS "BrowseNodeReturnTrend";
DROP TABLE IF EXISTS "BrowseNodeReviewTrend";
DROP TABLE IF EXISTS "ReviewTopic";
DROP TABLE IF EXISTS "ReviewMetricSnapshot";
