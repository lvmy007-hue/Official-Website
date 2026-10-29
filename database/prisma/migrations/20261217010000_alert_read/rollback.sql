-- 回滚 M-P6-15：删除 AlertRead（含索引、约束与行级安全策略）。
-- 所有人的预警已读记录会丢失，预警回到“全部未读”；预警本身与处理状态不受影响。
DROP TABLE IF EXISTS "AlertRead";
