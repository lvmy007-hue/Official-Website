-- 回滚 M-P6-33：从预设角色去掉 dashboard.write 与 dashboard.share。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = (
  SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
  FROM jsonb_array_elements("permissions") AS item
  WHERE item #>> '{}' NOT IN ('dashboard.write', 'dashboard.share')
)
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-ads', 'preset-finance', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system"
  AND jsonb_typeof("permissions") = 'array';

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
