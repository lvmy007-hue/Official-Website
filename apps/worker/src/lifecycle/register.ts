import { NonRetryableError } from '@nova/workflow'
import type { AuxHandlerRegistry } from '../runtime/consumers'
import type { CloseDeps } from './close-steps'
import { runTenantClose } from './tenant-close'

/**
 * 注册生命周期队列的处理器（P1-19）。任务名与队列名相同（队列服务按队列名入队），用载荷里的 kind 区分种类。
 * 载荷必须带 tenantId（辅助队列的统一要求），处理过程里的数据库访问使用系统连接 deps.db。
 */
export function registerLifecycleHandlers(aux: AuxHandlerRegistry, deps: CloseDeps) {
  aux.register('lifecycle', 'lifecycle', async (job, { tenantId }) => {
    const kind = (job.data as { kind?: string } | undefined)?.kind
    if (kind === 'tenant-close') return runTenantClose(deps, tenantId)
    throw new NonRetryableError('LIFECYCLE_KIND_UNKNOWN', `未知的生命周期任务：${String(kind)}`)
  })
}
