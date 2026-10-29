// 输出 M-P1-13 迁移里“旧权限展开映射”与“预设角色”两段 SQL，供手工粘贴进迁移文件。
// 迁移一旦发布就不再改动；预设角色以后变化必须新增迁移，由 apps/api 的数据库测试校验迁移结果与 packages/authz 一致。
const authz = require('../packages/authz/dist')
const q = value => `'${String(value).replace(/'/g, "''")}'`

const mapRows = []
for (const [oldKey, targets] of Object.entries(authz.LEGACY_PERMISSION_MAP)) {
  for (const target of targets) if (!target.startsWith('field.')) mapRows.push(`    (${q(oldKey)}, ${q(target)})`)
}
console.log('-- 旧权限映射')
console.log(mapRows.join(',\n'))

console.log('\n-- 预设角色')
for (const role of authz.PRESET_ROLES) {
  console.log(`INSERT INTO "Role" ("id", "tenantId", "name", "permissions", "resourceScope", "system", "version", "updatedAt")`)
  console.log(`VALUES (${q(role.id)}, NULL, ${q(role.name)}, ${q(JSON.stringify(role.permissions))}::jsonb, '{"all":true}'::jsonb, true, 1, CURRENT_TIMESTAMP);`)
  for (const field of role.fields) {
    console.log(`INSERT INTO "FieldPermission" ("id", "roleId", "fieldKey", "allowed") VALUES (${q(`fp_${role.key}_${field}`)}, ${q(role.id)}, ${q(field)}, true);`)
  }
}
