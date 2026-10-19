import { PrismaClient } from '@prisma/client'
import { hash } from 'bcryptjs'

const prisma = new PrismaClient()
const tenantId = process.env.LOCAL_DEV_TENANT_ID ?? 'local-dev-tenant'
const userId = process.env.LOCAL_DEV_USER_ID ?? 'local-dev-user'
const roleId = 'local-dev-admin-role'
const email = (process.env.LOCAL_DEV_USER_EMAIL ?? 'local.admin@nova-erp.local').toLowerCase()

async function main() {
  if (process.env.APP_MODE !== 'development' || process.env.LOCAL_NO_AUTH !== 'true') throw new Error('Local bootstrap is only allowed with APP_MODE=development and LOCAL_NO_AUTH=true')
  const tenant = await prisma.tenant.upsert({ where: { id: tenantId }, update: { name: '本地企业工作区', slug: 'nova-local', mode: 'LIVE' }, create: { id: tenantId, name: '本地企业工作区', slug: 'nova-local', mode: 'LIVE' } })
  const role = await prisma.role.upsert({ where: { id: roleId }, update: { name: '本地管理员', permissions: ['*'], resourceScope: { all: true }, system: true }, create: { id: roleId, tenantId: tenant.id, name: '本地管理员', permissions: ['*'], resourceScope: { all: true }, system: true } })
  const user = await prisma.user.upsert({ where: { id: userId }, update: { email, displayName: '本地管理员', status: 'ACTIVE' }, create: { id: userId, email, displayName: '本地管理员', passwordHash: await hash('local-access-disabled', 10), status: 'ACTIVE' } })
  await prisma.membership.upsert({ where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } }, update: { roleId: role.id, status: 'ACTIVE' }, create: { userId: user.id, tenantId: tenant.id, roleId: role.id, status: 'ACTIVE' } })
  console.log(JSON.stringify({ localWorkspace: 'ready', tenantId: tenant.id, userId: user.id }))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
