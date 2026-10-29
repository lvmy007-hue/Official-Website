import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { createMasterKeyProvider, secretConfigProblems } from '@nova/crypto'
import { createObjectStorage } from '@nova/storage'
import { databaseDeploymentProblems } from '@nova/tenancy'
import { redisProductionProblems } from '@nova/workflow'
import { AppModule } from './app.module'
import { readInternalAccessConfig } from './modules/auth/internal-access'
import { configureApp } from './platform/configure-app'
import { SecretBoxService } from './platform/security/secret-box.service'
import { logger, StructuredNestLogger } from './platform/observability'

// 内部访问模式：任何环境开启时都校验配置（配置不全或不合法拒绝启动）；生产环境开启时持续输出启动告警
function assertInternalAccessConfig() {
  const config = readInternalAccessConfig()
  if (!config.enabled) return
  if (process.env.APP_MODE === 'production') {
    logger.warn(
      { event: 'internal_access_enabled', tenantId: config.tenantId, roleId: config.roleId, allowedCidrs: config.allowedCidrs, gatewayHeader: Boolean(config.gatewayHeader) },
      '生产环境已开启内部访问模式：来自允许地址段的请求无需登录即可访问内部租户的数据。请确认地址段仅包含内网，并已正确配置 TRUST_PROXY',
    )
  }
}

// 生产环境启动前的配置校验：缺关键配置或开启演示开关时拒绝启动。
function assertProductionConfig() {
  assertInternalAccessConfig()
  if (process.env.APP_MODE !== 'production') return
  if (process.env.DEMO_MODE === 'true' || process.env.MOCK_CONNECTOR === 'true') {
    throw new Error('Production refuses DEMO_MODE or MOCK_CONNECTOR')
  }
  if (!process.env.DATABASE_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Production requires DATABASE_URL and a strong JWT_SECRET')
  }
  // 队列与缓存分两个带密码的 Redis 实例；数据库、Redis 的加密连接按配置强制，任何情况下不得关闭证书校验（P1-25）
  // 示例文件里的占位值与开发默认值是公开的，原样带进生产等于没设密码（P5-13）
  const deploymentProblems = [...redisProductionProblems(), ...databaseDeploymentProblems(), ...secretConfigProblems()]
  if (deploymentProblems.length) throw new Error(`部署配置不合格，拒绝启动：\n- ${deploymentProblems.join('\n- ')}`)
  // 主密钥（P1-24）：ENCRYPTION_MASTER_KEYS 或沿用的 TOKEN_ENCRYPTION_KEY，格式不对或缺失直接拒绝启动（错误信息带中文说明）
  createMasterKeyProvider(process.env)
  // 文件存储：本地驱动必须设置签名密钥，云存储必须配置完整；不合法直接拒绝启动（createObjectStorage 会抛出带中文说明的错误）
  const storage = createObjectStorage(process.env)
  if (storage.driver === 'local') {
    logger.warn({ event: 'config_warning', key: 'STORAGE_DRIVER' }, '生产环境使用本地磁盘存储文件：仅适用于单机部署，且需要把存储目录挂载为持久卷并纳入备份；多机或托管部署请改用 STORAGE_DRIVER=oss')
  }
  // 以下两项不阻止启动，但会在日志里持续告警：配置不当会让限流与登录锁定失真，或削弱管理员账号保护
  if (!process.env.TRUST_PROXY || process.env.TRUST_PROXY === 'false') {
    logger.warn({ event: 'config_warning', key: 'TRUST_PROXY' }, '生产环境未配置 TRUST_PROXY：服务会把网关的地址当作所有访客的地址，限流与登录锁定会合并计算。请写入网关的地址或代理层数')
  }
  if (process.env.MFA_REQUIRED_FOR_ADMINS === 'false') {
    logger.warn({ event: 'config_warning', key: 'MFA_REQUIRED_FOR_ADMINS' }, '生产环境已关闭“管理员必须绑定多因素认证”，管理员账号只靠密码保护')
  }
}

async function bootstrap() {
  assertProductionConfig()
  const app = await NestFactory.create(AppModule, { cors: false, logger: new StructuredNestLogger() })
  configureApp(app)
  // 密钥：确保数据密钥齐全、主密钥能解开已有数据密钥；配置错误在启动阶段暴露，而不是等到第一次登录或授权
  await app.get(SecretBoxService).prepare()
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0')
}

bootstrap().catch(error => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'api failed to start')
  process.exit(1)
})
