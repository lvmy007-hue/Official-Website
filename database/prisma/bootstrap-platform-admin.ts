import { PrismaClient } from '@prisma/client'
import { hash } from 'bcryptjs'

// 首个平台运营账号初始化脚本（P1-19）：一次性、人工执行，需要系统（或所有者）数据库连接。
// 用法（生产）：APP_MODE=production BOOTSTRAP_CONFIRM=CREATE_PLATFORM_ADMIN BOOTSTRAP_PLATFORM_EMAIL=... BOOTSTRAP_PLATFORM_PASSWORD=... [BOOTSTRAP_PLATFORM_NAME=...] [BOOTSTRAP_PLATFORM_ROLE=PLATFORM_OWNER] node dist/bootstrap-platform-admin.js
// 账号创建后必须在首次登录时绑定动态验证码（强制）；已经存在平台账号时不重复创建。
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL })
const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
const ROLES = ['PLATFORM_OWNER', 'PLATFORM_OPS', 'PLATFORM_SUPPORT']

async function main() {
  if (process.env.APP_MODE !== 'production') throw new Error('Platform admin bootstrap only runs in production')
  if (process.env.BOOTSTRAP_CONFIRM !== 'CREATE_PLATFORM_ADMIN') throw new Error('Set BOOTSTRAP_CONFIRM=CREATE_PLATFORM_ADMIN')
  const email = required('BOOTSTRAP_PLATFORM_EMAIL').toLowerCase()
  const password = required('BOOTSTRAP_PLATFORM_PASSWORD')
  const role = process.env.BOOTSTRAP_PLATFORM_ROLE?.trim() || 'PLATFORM_OWNER'
  if (!ROLES.includes(role)) throw new Error(`BOOTSTRAP_PLATFORM_ROLE must be one of ${ROLES.join(', ')}`)
  if (password.length < 12) throw new Error('BOOTSTRAP_PLATFORM_PASSWORD must be at least 12 characters')
  if (await prisma.platformAdmin.findUnique({ where: { email } })) {
    console.log(JSON.stringify({ bootstrap: 'skipped', reason: 'exists' }))
    return
  }
  const admin = await prisma.platformAdmin.create({ data: { email, name: process.env.BOOTSTRAP_PLATFORM_NAME?.trim() || '平台管理员', role, passwordHash: await hash(password, 12), mfaRequired: true } })
  console.log(JSON.stringify({ bootstrap: 'created', id: admin.id, email: admin.email, role: admin.role, next: 'Sign in at /platform and bind the authenticator' }))
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())