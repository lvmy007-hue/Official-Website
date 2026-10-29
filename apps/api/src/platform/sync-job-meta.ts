import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'

/** 创建 SyncJob 时统一带上的调度元数据：数据域、去重来源键、优先级（接口发起的任务都是用户触发，最高优先级）。 */
export function syncJobMeta(connectionId: string, type: string, keyParts: Array<string | null | undefined> = [], priority: number = PRIORITY.USER_TRIGGERED) {
  return { domain: syncDomainOf(type), sourceKey: syncSourceKey(connectionId, type, ...keyParts), priority }
}
