-- M-P3-07：广告活动的系统内标签与负责人（不写亚马逊）。同步器从不改这三列。
-- 说明：只新增列，旧数据 tags 为空数组、ownerId 为空、version 从 1 开始。

ALTER TABLE "AdsCampaign"
  ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
