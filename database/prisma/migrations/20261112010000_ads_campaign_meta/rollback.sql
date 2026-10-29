-- M-P3-07 回滚：移除广告活动上的标签、负责人与版本号。
-- 说明：tags、ownerId 是系统内数据（不在亚马逊侧），回滚会丢失，回滚前请先导出。

ALTER TABLE "AdsCampaign"
  DROP COLUMN IF EXISTS "tags",
  DROP COLUMN IF EXISTS "ownerId",
  DROP COLUMN IF EXISTS "version";
