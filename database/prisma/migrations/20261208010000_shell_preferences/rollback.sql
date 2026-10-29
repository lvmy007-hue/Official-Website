-- 回滚 M-P6-01：删除 UserPreference 的收藏与密度两列（含约束）。
-- 个人的收藏与密度选择会丢失（回到“无收藏、标准密度”）；通知偏好与免打扰设置不受影响。
ALTER TABLE "UserPreference" DROP CONSTRAINT IF EXISTS "UserPreference_favorites_check";
ALTER TABLE "UserPreference" DROP CONSTRAINT IF EXISTS "UserPreference_density_check";
ALTER TABLE "UserPreference" DROP COLUMN IF EXISTS "density";
ALTER TABLE "UserPreference" DROP COLUMN IF EXISTS "favoriteRoutes";
