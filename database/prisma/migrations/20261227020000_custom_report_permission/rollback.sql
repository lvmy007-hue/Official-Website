-- 回滚 M-P6-32：从预设角色去掉 reports.custom.write 与 reports.custom.share。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = (
  SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
  FROM jsonb_array_elements("permissions") AS item
  WHERE item #>> '{}' NOT IN ('reports.custom.write', 'reports.custom.share')
)
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-ads', 'preset-finance', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system"
  AND jsonb_typeof("permissions") = 'array';

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
