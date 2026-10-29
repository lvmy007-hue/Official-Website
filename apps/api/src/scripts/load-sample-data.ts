import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { logger, StructuredNestLogger } from '../platform/observability'
import { SampleDataService } from '../platform/sample-data'

// 命令行：向测试租户加载官方格式的样例文件，用法：pnpm --filter @nova/api sample:load -- <租户编号>
// 生产环境与非测试租户会被拒绝（判断在 SampleDataService 内，代码层强制）。
async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) throw new Error('用法：sample:load -- <租户编号>')
  const app = await NestFactory.createApplicationContext(AppModule, { logger: new StructuredNestLogger() })
  try {
    const result = await app.get(SampleDataService).load(tenantId)
    logger.info({ event: 'sample_data_loaded', tenantId, files: result }, 'sample files loaded through real importers')
  } finally {
    await app.close()
  }
}

main().catch(error => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'sample data load refused or failed')
  process.exit(1)
})
