-- M-P2b-14 回滚：去掉成本版本新增的列、约束与索引。
-- 说明：关税、备注、生效与替换的留痕会丢失，请先导出；回滚后所有已生效的版本仍保持生效状态，利润计算不受影响。
-- 注意：只填了关税的版本回滚后没有任何成本；若之后要再次升级，须先处理掉这些版本，否则“至少一项成本”的约束加不上。
ALTER TABLE "CostVersion" DROP CONSTRAINT IF EXISTS "CostVersion_any_cost_check";
ALTER TABLE "CostVersion" DROP CONSTRAINT IF EXISTS "CostVersion_amount_check";
ALTER TABLE "CostVersion" DROP CONSTRAINT IF EXISTS "CostVersion_version_check";
DROP INDEX IF EXISTS "CostVersion_sku_status_idx";
ALTER TABLE "CostVersion"
  DROP COLUMN IF EXISTS "replacedAt",
  DROP COLUMN IF EXISTS "replacedById",
  DROP COLUMN IF EXISTS "activatedAt",
  DROP COLUMN IF EXISTS "activatedBy",
  DROP COLUMN IF EXISTS "createdBy",
  DROP COLUMN IF EXISTS "version",
  DROP COLUMN IF EXISTS "note",
  DROP COLUMN IF EXISTS "unitDutyCost";
