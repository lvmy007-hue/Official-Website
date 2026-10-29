-- 回滚 M-P4-14：删除四张新表。
-- A+ 内容、关联与审核事件下一次同步会从亚马逊重新取回；本地没有成功创建到亚马逊的草稿、图片上传记录与写入记录会丢失（已经在亚马逊上的内容不受影响）。
DROP TABLE IF EXISTS "AplusWriteRun";
DROP TABLE IF EXISTS "AplusReviewEvent";
DROP TABLE IF EXISTS "AplusAsinRelation";
DROP TABLE IF EXISTS "AplusContent";
