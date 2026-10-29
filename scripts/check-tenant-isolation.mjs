#!/usr/bin/env node
// 租户隔离静态检查（P1-16，12.8 第 4 条）：在持续集成里把关，防止有人绕过租户隔离。
// 规则：
//   R1  只有白名单文件可以 new PrismaClient（带租户隔离的客户端只能在平台层与后台任务的数据库入口里创建）；
//   R2  SystemPrismaService（绕过行级安全的系统连接）只能出现在白名单文件里：登录会话、跨租户成员查询、授权回调、官网表单、商务订单；
//   R3  原始 SQL（$queryRaw / $executeRaw / Prisma.raw / Prisma.sql）只能出现在白名单文件里；
//   R4  后台任务里的 systemPrisma 只能出现在 main.ts 与 tenant-db.ts（业务导入代码不得使用系统连接）；
//   R5  DATABASE_SYSTEM_URL 只能在白名单文件里被读取。
// 测试文件与测试工具目录不受限制。新增合理用法时，必须在本文件登记并写明理由——登记本身就是评审点。
//
// 用法：node scripts/check-tenant-isolation.mjs            检查整个仓库
//       node scripts/check-tenant-isolation.mjs --self-test  用内置的违规样例验证规则确实会报错

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

const normalize = path => path.split(sep).join('/')

const rules = [
  {
    id: 'R1',
    title: '只有白名单文件可以创建数据库客户端（new PrismaClient / extends PrismaClient）',
    pattern: /new\s+PrismaClient\s*\(|extends\s+PrismaClient\b/,
    allow: [
      'apps/api/src/platform/prisma.service.ts', // 接口服务的租户连接与系统连接
      'apps/worker/src/tenant-db.ts', // 后台任务的租户连接与系统连接
      'database/prisma/bootstrap-local.ts', // 本地初始化脚本（一次性、人工执行）
      'database/prisma/bootstrap-admin.ts', // 管理员初始化脚本（一次性、人工执行）
      'database/prisma/bootstrap-platform-admin.ts', // 平台运营账号初始化脚本（一次性、人工执行，P1-19）
    ],
  },
  {
    id: 'R2',
    title: 'SystemPrismaService（系统连接）只能用在无租户上下文的平台级流程',
    pattern: /\bSystemPrismaService\b/,
    allow: [
      'apps/api/src/platform/prisma.service.ts',
      'apps/api/src/platform/platform.module.ts',
      'apps/api/src/modules/auth/auth.service.ts', // 登录、会话、刷新：登录时还没有租户
      'apps/api/src/modules/auth/internal-access.service.ts', // 内部访问模式：按配置的租户与角色创建并读取内部访问主体
      'apps/api/src/modules/auth/mfa.service.ts', // 多因素因子属于用户、不属于任何企业，租户账号对该表没有权限
      'apps/api/src/platform/security/secret-box.service.ts', // 数据密钥表属于平台级数据，租户账号对该表没有权限
      'apps/api/src/modules/auth/context.service.ts', // 跨租户查询当前用户的成员关系后立即绑定租户
      'apps/api/src/modules/members/member-system.service.ts', // 成员与角色（P5-08）：预设角色没有企业编号、登录会话属于用户，租户连接都读不到；每个查询显式带企业条件
      'apps/api/src/modules/connections/sp-oauth.service.ts', // 授权回调：凭 state 反查租户
      'apps/api/src/modules/connections/ads-oauth.service.ts', // 同上
      'apps/api/src/modules/commerce/commerce.service.ts', // 官网商务订单与支付：下单时没有租户
      'apps/api/src/modules/contact/contact.service.ts', // 官网联系表单：访客提交
      'apps/api/src/modules/lifecycle/invitation.service.ts', // 接受邀请（P1-19）：公开接口，凭一次性令牌创建账号与成员关系，此时没有租户上下文
      'apps/api/src/modules/platform-admin/platform-audit.service.ts', // 平台操作写入企业审计（P1-19）：平台人员不是企业成员，没有租户上下文
      'apps/api/src/modules/platform-admin/platform.guard.ts', // 平台账号守卫（P1-19）：平台账号属于平台级数据，租户账号对该表没有权限
      'apps/api/src/modules/platform-admin/platform-auth.service.ts', // 平台账号登录与动态验证码（P1-19）
      'apps/api/src/modules/platform-admin/platform-tenants.service.ts', // 平台开通、查看、配额管理企业（P1-19）：跨租户
      'apps/api/src/modules/platform-admin/platform-lifecycle.service.ts', // 平台暂停、停用、注销企业（P1-19）：跨租户
      'apps/api/src/modules/platform-admin/platform-support.service.ts', // 平台领取支持访问（P1-19）：跨租户读取授权记录
      'apps/api/src/modules/custom-reports/custom-report-schedule.service.ts', // 我的报表定时（P6-32）：进程启动时没有请求租户，跨租户扫描到期报表后按创建人装入租户上下文再取数
    ],
  },
  {
    id: 'R3',
    title: '原始 SQL 只能出现在白名单文件里（原始 SQL 不会自动带租户条件）',
    pattern: /\$queryRaw(Unsafe)?\b|\$executeRaw(Unsafe)?\b|Prisma\.raw\b|Prisma\.sql\b/,
    allow: [
      'packages/tenancy/src/scoped-client.ts', // 设置行级安全变量的实现本身
      'apps/worker/src/listeners/maintenance.ts', // 分区维护：系统连接上调用数据库函数
      'apps/api/src/platform/prisma.service.ts', // 启动检查：确认连接账号权限最小
      'apps/api/src/modules/health/health.service.ts', // 健康检查：SELECT 1
      'apps/worker/src/derivers/summary-sql.ts', // 日汇总刷新（P2a-01）：在租户上下文里按日期聚合订单与财务，SQL 里显式带租户条件，行级安全同时生效
      'apps/worker/src/derivers/ads-summary-sql.ts', // 广告日汇总刷新（P3-04）：在租户上下文里按日期聚合广告活动指标，SQL 里显式带租户条件，行级安全同时生效
      'apps/worker/src/profit/estimated-fees-load.ts', // 预估费用冲销（P6-20）：只读实际费用出账的日期集合，SQL 显式 WHERE tenantId = $1，行级安全同时生效
      'apps/worker/src/profit/sql.ts', // 利润日表（P2b-09）：在租户上下文里按日期聚合订单与费用明细，SQL 里显式带租户条件，行级安全同时生效
      'apps/api/src/modules/allocation-rules/allocation-rules-preview.service.ts', // 分摊预览（P6-19）：只读订单销售聚合，SQL 显式 WHERE tenantId = $1，行级安全同时生效
      'apps/worker/src/lifecycle/close-sql.ts', // 租户注销（P1-19）：按目录枚举全部带租户编号的表，分页导出与分批删除；只用系统连接，且调用前已确认企业处于注销中
    ],
  },
  {
    id: 'R4',
    title: '后台任务里的 systemPrisma 只能出现在白名单文件（入口装配、监听器、定时任务、崩溃恢复）',
    pattern: /\bsystemPrisma\b/,
    scope: /^apps\/worker\/src\//,
    allow: [
      'apps/worker/src/main.ts', // 入口装配：创建并注入系统连接
      'apps/worker/src/tenant-db.ts',
      'apps/worker/src/listeners/sync-listener.ts', // 同步任务入口：先用系统连接按任务编号反查归属租户，之后全部在租户上下文里执行
      'apps/worker/src/listeners/schedule-jobs.ts', // 定时同步跨租户扫描连接；买家信息到期清理对全部租户一视同仁
      'apps/worker/src/datakiosk/schedule.ts', // 官方经济数据的定时查询（P2b-11）：跨租户扫描已授权的连接（与 schedule-jobs 相同），建任务、清理预览与入队都在各自租户上下文里
      'apps/worker/src/datakiosk/sales-traffic-schedule.ts', // 销售与流量的定时查询（P4-01）：与官方经济数据的定时查询同样，跨租户扫描已授权的连接，查有无数据、建任务与入队都在各自租户上下文里
      'apps/worker/src/ads-entities/schedule.ts', // 广告实体同步的定时排任务（P5-12A）：与广告核对定时同一写法，跨租户只扫描活跃企业，查档案、建任务与入队都在各自租户上下文里
      'apps/worker/src/ads-reports/auto-schedule.ts', // 广告报表的定时排任务（P5-12A）：同上
      'apps/worker/src/ads-reports/schedule.ts', // 广告新旧接口核对的定时排任务（P3-15）：跨租户扫描活跃企业（与 schedule-jobs 相同），查广告档案、建核对任务与入队都在各自租户上下文里
      'apps/worker/src/listeners/report-schedule.ts', // 库存与费用类报告的定时申请：跨租户扫描已授权的连接（与 schedule-jobs 相同），建报告任务与入队都在各自租户上下文里
      'apps/worker/src/maintenance/reencrypt.ts', // 密钥运维：数据密钥轮换后跨租户迁移旧密文，只在运维命令里运行，不属于日常任务
      'apps/worker/src/maintenance/return-comments.ts', // 退货买家备注存量加密（P6-14）：跨租户把升级前的明文备注加密并清空，随到期清理定时跑，也可手工运行；日志只有数量与行编号
      'apps/worker/src/maintenance/keys-cli.ts', // 密钥运维命令入口：独立进程，使用系统连接
      'apps/worker/src/crypto/secrets.ts', // 数据密钥表属于平台级数据，只能用系统连接读写
      'apps/worker/src/listeners/raw-file-retention.ts', // 原始文件到期清理：跨租户扫描已过期的留存记录，按记录里的租户逐个删除文件
      'apps/worker/src/exports/expire.ts', // 导出文件到期清理（P1-28）：跨租户扫描已过期或卡住的导出任务，按记录里的租户逐个删除文件；只改导出任务的状态与文件键
      'apps/worker/src/listeners/schedules.ts', // 把系统连接交给分区维护与上面几项定时任务（含注销产物到期清理）
      'apps/worker/src/runtime/recovery.ts', // 崩溃恢复：跨租户扫描卡住的流程与同步任务，之后逐个在各自租户上下文里处理
      'apps/worker/src/runtime/reliability.ts', // 装配流程存储：系统连接只交给“扫描卡住的流程”这一个方法，其余读写都走租户连接
    ],
  },
  {
    id: 'R5',
    title: 'DATABASE_SYSTEM_URL 只能在白名单文件里读取',
    pattern: /\bDATABASE_SYSTEM_URL\b/,
    // packages/tenancy/src/connection-config.ts：生产启动检查只读取连接串做配置校验（不建立连接），接口与后台任务共用
    // packages/crypto/src/secret-config.ts（P5-13）：生产启动体检只解析连接串里的密码、判断是否是示例值，不建立连接，也不回显值
    allow: [
      'apps/api/src/platform/prisma.service.ts',
      'apps/worker/src/tenant-db.ts',
      'packages/tenancy/src/connection-config.ts',
      'packages/crypto/src/secret-config.ts',
      'database/prisma/bootstrap-platform-admin.ts',
    ],
  },
]

const SOURCE = /\.(ts|tsx|mjs|cjs|js)$/
const EXEMPT = path => /\.test\.(ts|tsx)$/.test(path) || /^apps\/api\/src\/testing\//.test(path) || /^scripts\//.test(path) || /^packages\/tenancy\/src\/.*\.test\.ts$/.test(path)
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'generated', '.vite', 'coverage'])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) yield* walk(full)
    else if (SOURCE.test(name)) yield full
  }
}

/** 检查一组 { path, text }，返回违规列表。注释行不算（只看代码）。 */
export function scan(files) {
  const violations = []
  for (const { path, text } of files) {
    if (EXEMPT(path)) continue
    const lines = text.split(/\r?\n/)
    for (const rule of rules) {
      if (rule.scope && !rule.scope.test(path)) continue
      if (rule.allow.includes(path)) continue
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').trim()
        if (!code || code.startsWith('*') || code.startsWith('/*')) return
        if (rule.pattern.test(code)) violations.push({ rule: rule.id, title: rule.title, path, line: index + 1, text: line.trim().slice(0, 160) })
      })
    }
  }
  return violations
}

function selfTest() {
  const bad = [
    { path: 'apps/api/src/modules/orders/orders.service.ts', text: 'const db = new PrismaClient()' },
    { path: 'apps/api/src/modules/orders/orders.service.ts', text: 'constructor(private readonly system: SystemPrismaService) {}' },
    { path: 'apps/api/src/modules/finance/finance.service.ts', text: 'await this.prisma.$queryRawUnsafe(\'SELECT * FROM "Order"\')' },
    { path: 'apps/worker/src/importers/orders.ts', text: 'await systemPrisma.order.findMany()' },
    { path: 'apps/api/src/modules/ads/ads.service.ts', text: 'const url = process.env.DATABASE_SYSTEM_URL' },
  ]
  const good = [
    { path: 'apps/api/src/modules/auth/auth.service.ts', text: 'constructor(private readonly system: SystemPrismaService) {}' },
    { path: 'apps/api/src/modules/orders/orders.service.ts', text: '// 不要使用 new PrismaClient()（注释里提到不算）' },
    { path: 'apps/api/src/modules/orders/orders.http.test.ts', text: 'new PrismaClient()' },
  ]
  const expected = ['R1', 'R2', 'R3', 'R4', 'R5']
  const caught = bad.map(file => scan([file]).map(violation => violation.rule))
  const failures = []
  bad.forEach((file, index) => {
    if (!caught[index].includes(expected[index])) failures.push(`违规样例没有被发现：${file.path}（应触发 ${expected[index]}）`)
  })
  good.forEach(file => {
    const hit = scan([file])
    if (hit.length > 0) failures.push(`合规样例被误报：${file.path}（${hit[0].rule}）`)
  })
  if (failures.length > 0) {
    console.error('租户隔离静态检查的自检失败：\n' + failures.map(item => `  - ${item}`).join('\n'))
    process.exit(1)
  }
  console.log(`租户隔离静态检查自检通过（${bad.length} 个违规样例全部发现，${good.length} 个合规样例没有误报）`)
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const files = []
  for (const top of ['apps', 'packages', 'database', 'src']) {
    const dir = join(root, top)
    try {
      statSync(dir)
    } catch {
      continue
    }
    for (const full of walk(dir)) files.push({ path: normalize(relative(root, full)), text: readFileSync(full, 'utf8') })
  }
  const violations = scan(files)
  if (violations.length > 0) {
    console.error('租户隔离静态检查未通过：\n')
    for (const item of violations) console.error(`  [${item.rule}] ${item.path}:${item.line}\n      ${item.text}\n      ${item.title}`)
    console.error('\n如确有正当用法，请在 scripts/check-tenant-isolation.mjs 的白名单里登记并写明理由。')
    process.exit(1)
  }
  console.log(`租户隔离静态检查通过（已扫描 ${files.length} 个源文件，${rules.length} 条规则）`)
}

if (process.argv[1] && normalize(process.argv[1]).endsWith('scripts/check-tenant-isolation.mjs')) main()
