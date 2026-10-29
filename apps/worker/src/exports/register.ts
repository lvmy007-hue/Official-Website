import { runWithTenant } from '@nova/tenancy'
import type { ObjectStorage } from '@nova/storage'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { AuxHandlerRegistry } from '../runtime/consumers'
import { runExport } from './run-export'

/**
 * 注册导出队列的处理器（P1-28-6）：载荷只有租户编号与导出任务编号（队列不存业务数据）；
 * 处理过程在该租户的上下文里执行，数据库访问自动带租户条件。
 */
export function registerExportHandlers(aux: AuxHandlerRegistry, deps: { db: PrismaClient; storage: ObjectStorage; labelFontPath?: string }) {
  aux.register('exports', 'exports', async (job, { tenantId }) => {
    const exportJobId = (job.data as { exportJobId?: unknown } | undefined)?.exportJobId
    if (typeof exportJobId !== 'string' || !exportJobId) throw new NonRetryableError('EXPORT_JOB_ID_MISSING', '导出任务缺少编号')
    return runWithTenant(tenantId, () => runExport({ db: deps.db, storage: deps.storage, labelFontPath: deps.labelFontPath ?? process.env.LABEL_FONT_PATH }, tenantId, exportJobId))
  })
}
