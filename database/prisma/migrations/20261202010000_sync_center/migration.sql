-- M-P5-06 同步中心：SyncJob 加写入统计与过程时间线。
-- 依据：09 章 9.8，14 章 P5-06，freeze/api.md /sync/*。
--
-- 内容：
--   SyncJob 新增列：
--     resultJson    任务完成时同步器返回的数字统计（例如导入行数；只存数字，最多 20 项；没有统计的任务为空，不是 0）；
--     timelineJson  过程时间线（最多 40 条：开始第几次尝试、等待重试、等待亚马逊报告、完成、失败、取消、人工重试）；
--                   “已创建”由接口按 createdAt 补出，不存。
-- 与冻结的出入：冻结没有给 SyncJob 列这两项，是同步任务详情页“分步时间线”“写入统计”要的数据；没有新增表，不需要新的行级安全与授权。
--
-- 回滚方法：见同目录 rollback.sql（删除两列；任务行保留，统计与时间线丢失）。

ALTER TABLE "SyncJob" ADD COLUMN "resultJson" JSONB;
ALTER TABLE "SyncJob" ADD COLUMN "timelineJson" JSONB;
