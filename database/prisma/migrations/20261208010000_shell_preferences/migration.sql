-- M-P6-01 外壳偏好：侧边导航收藏与界面密度。
-- 依据：15 章第 10、11 节，14 章 P6-01，freeze/models.md 第二十一节（UserPreference 补列）。
--
-- 内容：UserPreference 新增两列（已有行直接取默认值，不需要回填）：
--   favoriteRoutes TEXT[]：收藏的路由模板（如 /app/overview），按添加顺序；数量上限 30（CHECK 兜底，接口层先拦）；
--   density TEXT：界面密度 COMPACT（表格行高 36）或 STANDARD（40），默认 STANDARD（CHECK 约束）。
-- 没有新表，行级安全与授权沿用 P5-11 建表时的设置，所以不动 regrant.sql 与 tenant-seed 的 SEED_OVERRIDES。
--
-- 回滚方法：见同目录 rollback.sql（删除两列，个人的收藏与密度选择会丢失，通知偏好不受影响）。

ALTER TABLE "UserPreference" ADD COLUMN "favoriteRoutes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserPreference" ADD COLUMN "density" TEXT NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_density_check" CHECK ("density" IN ('COMPACT', 'STANDARD'));
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_favorites_check" CHECK (cardinality("favoriteRoutes") <= 30);
