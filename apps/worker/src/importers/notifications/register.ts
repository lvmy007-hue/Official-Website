import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'
import type { NotificationProcessorRegistry } from '../../platform/notification-events'
import { registerAccountStatusProcessor } from '../account-health/notifications'
import { registerTransactionUpdateProcessor, type TransactionUpdateDeps } from '../finance/transaction-update'
import { registerListingProcessors } from '../listings/notifications'
import { registerPricingProcessors } from '../pricing/notifications'
import { registerFbaInventoryProcessor } from './fba-inventory'
import { registerHourlyNotificationProcessors } from './hourly-write'

// 亚马逊通知处理器的统一注册（main.ts 只调用这一个）：小时销售、流量、库存推送（P2a-03）、亚马逊物流库存变化（P2a-05）、交易更新（P2b-05）。
export function registerNotificationProcessors(registry: NotificationProcessorRegistry, deps: { db: PrismaClient; storage: Pick<ObjectStorage, 'openRead'>; queues: TransactionUpdateDeps['queues'] }) {
  registerHourlyNotificationProcessors(registry, { db: deps.db, storage: deps.storage })
  registerFbaInventoryProcessor(registry, { db: deps.db, storage: deps.storage })
  registerTransactionUpdateProcessor(registry, deps)
  registerListingProcessors(registry, { db: deps.db, storage: deps.storage }) // 刊登问题、状态、商品类型与内容变更（P4-10）
  registerPricingProcessors(registry, { db: deps.db, storage: deps.storage }) // 报价变化与价格健康（P4-11）
  registerAccountStatusProcessor(registry, { db: deps.db, storage: deps.storage }) // 账户状态变化（P5-02）
}
