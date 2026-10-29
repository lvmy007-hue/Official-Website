import { SECRET_PURPOSES, type SecretPurpose } from '@nova/crypto'
import { createWorkerKeyring, WorkerSecrets } from '../crypto/secrets'
import { createWorkerLogger } from '../logger'
import { createTenantDatabases } from '../tenant-db'
import { reencryptAll } from './reencrypt'
import { backfillReturnComments } from './return-comments'

// 密钥运维命令（P1-24）。需要系统连接（DATABASE_SYSTEM_URL，没配置时退回 DATABASE_URL，仅限开发）与主密钥配置。
//
//   node dist/maintenance/keys-cli.js status                    查看各用途的数据密钥版本（不显示任何密钥内容）
//   node dist/maintenance/keys-cli.js rotate [用途|all]         数据密钥轮换：生成新版本，新写入改用新版本
//   node dist/maintenance/keys-cli.js rewrap                    主密钥轮换后：用当前主密钥重新包裹所有数据密钥
//   node dist/maintenance/keys-cli.js reencrypt                 把旧版本/旧格式密文迁到当前版本
//   node dist/maintenance/keys-cli.js backfill-return-comments  退货买家备注存量加密（升级前的明文备注，P6-14）
//
// 完整流程见 docs/runbooks/encryption-keys.md。

const logger = createWorkerLogger()

function parsePurposes(arg: string | undefined): SecretPurpose[] {
  if (!arg || arg === 'all') return [...SECRET_PURPOSES]
  if (!(SECRET_PURPOSES as readonly string[]).includes(arg)) throw new Error(`未知用途：${arg}；可选：${SECRET_PURPOSES.join('、')}、all`)
  return [arg as SecretPurpose]
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  // 只用系统连接；租户连接对象只是创建出来不使用（连接是懒建立的）
  const { prisma: tenantPrisma, systemPrisma: prisma } = createTenantDatabases()
  try {
    const keyring = createWorkerKeyring(prisma)
    if (command === 'status') {
      await keyring.prepare(SECRET_PURPOSES)
      for (const row of await keyring.status())
        console.log(
          `${row.purpose.padEnd(13)} v${row.version}  ${row.status.padEnd(8)} 主密钥 ${row.masterKeyId}  创建于 ${row.createdAt.toISOString()}${row.retiredAt ? `  退役于 ${row.retiredAt.toISOString()}` : ''}`,
        )
    } else if (command === 'rotate') {
      await keyring.prepare(SECRET_PURPOSES)
      for (const purpose of parsePurposes(arg)) console.log(`${purpose}：已轮换到 v${await keyring.rotateDataKey(purpose)}`)
      console.log('新写入已使用新版本；请随后运行 reencrypt 迁移旧密文。')
    } else if (command === 'rewrap') {
      console.log(`已重新包裹 ${await keyring.rewrapAll()} 个数据密钥。确认无误后即可从配置里移除旧主密钥。`)
    } else if (command === 'reencrypt') {
      await keyring.prepare(SECRET_PURPOSES)
      const summaries = await reencryptAll({ systemPrisma: prisma, keyring, logger })
      for (const item of summaries)
        console.log(`${item.target}：检查 ${item.scanned}，迁移 ${item.migrated}，失败 ${item.failed}${item.failed ? `（行：${item.failedIds.slice(0, 20).join('、')}）` : ''}`)
      if (summaries.some(item => item.failed > 0)) process.exitCode = 2
    } else if (command === 'backfill-return-comments') {
      // P6-14：把升级前明文保存的退货买家备注加密并清空明文列（幂等，可重复运行）；清空后再运行 database/ops/drop-return-comment-plaintext.sql
      await keyring.prepare(SECRET_PURPOSES)
      const summary = await backfillReturnComments({ systemPrisma: prisma, secrets: new WorkerSecrets(keyring), logger })
      console.log(`退货买家备注：检查 ${summary.scanned}，加密 ${summary.encrypted}，已到期清除 ${summary.cleared}，保留较新密文 ${summary.keptNewer}，失败 ${summary.failed}`)
      if (summary.failed > 0) process.exitCode = 2
    } else {
      console.error('用法：keys-cli.js status | rotate [用途|all] | rewrap | reencrypt | backfill-return-comments')
      process.exitCode = 1
    }
  } finally {
    await prisma.$disconnect()
    await tenantPrisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
