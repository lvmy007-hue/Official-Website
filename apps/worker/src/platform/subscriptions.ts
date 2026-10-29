import { notificationTypeOf, type SubscriptionFilter } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { UpstreamHttpError, type RequestGuard } from '../connectors/http-error'
import type { TokenOpener } from '../crypto/secrets'

// 亚马逊通知订阅的创建与取消（P1-28-11，后台任务侧）。接口只登记意图；令牌只在这里使用。
// - 接收端编号来自环境变量 AMAZON_NOTIFICATION_DESTINATION_ID（部署专项创建）；未配置时订阅保持“未创建”，任务不重试；
// - 亚马逊不支持修改订阅：更新过滤条件 = 先取消旧订阅再按新条件创建；取消时对方说“已不存在”（404）视为已取消；
// - 亚马逊以 4xx 拒绝（参数不对、无权限）→ 订阅标记为“已失效”并不再重试；限流与服务端错误交给队列重试；
// - 无需卖家授权的类型（货件追踪节点）用应用自身的访问令牌，其余类型用该店铺的授权令牌。

export interface NotificationsApi {
  create(notificationType: string, body: Record<string, unknown>): Promise<{ subscriptionId: string }>
  remove(notificationType: string, subscriptionId: string): Promise<void>
}
export type NotificationsApiFactory = (target: {
  grantless: boolean
  connection: { encryptedRefreshToken: string | null; sellerAccountId: string | null; id: string } | null
  tenantId: string
}) => NotificationsApi

/** 创建订阅的请求体：过滤条件只对支持过滤的类型生效（站点 + 聚合周期）。 */
export function subscriptionBody(notificationType: string, destinationId: string, filter: SubscriptionFilter | null) {
  const spec = notificationTypeOf(notificationType)
  const body: Record<string, unknown> = { payloadVersion: spec?.payloadVersion ?? '1.0', destinationId }
  if (spec?.filterable && filter && (filter.marketplaceIds?.length || filter.aggregationTimePeriod)) {
    body.processingDirective = {
      eventFilter: {
        eventFilterType: notificationType,
        ...(filter.marketplaceIds?.length ? { marketplaceIds: filter.marketplaceIds } : {}),
        ...(filter.aggregationTimePeriod ? { aggregationSettings: { aggregationTimePeriod: filter.aggregationTimePeriod } } : {}),
      },
    }
  }
  return body
}

export interface SubscriptionDeps {
  db: PrismaClient
  api: NotificationsApiFactory
  env?: Record<string, string | undefined>
}

const destinationOf = (env: Record<string, string | undefined>) => env.AMAZON_NOTIFICATION_DESTINATION_ID?.trim() || null
const isClientRejection = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status >= 400 && error.status < 500 && error.status !== 429

async function targetOf(deps: SubscriptionDeps, tenantId: string, row: { sellerAccountId: string; notificationType: string }) {
  const grantless = notificationTypeOf(row.notificationType)?.grantless === true
  if (grantless) return { grantless, connection: null, tenantId }
  const connection = await deps.db.platformConnection.findFirst({
    where: { tenantId, sellerAccountId: row.sellerAccountId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } },
    select: { id: true, sellerAccountId: true, encryptedRefreshToken: true },
  })
  if (!connection) throw new NonRetryableError('CONNECTION_NOT_AUTHORIZED', '该店铺没有有效的亚马逊授权，无法创建订阅')
  return { grantless, connection, tenantId }
}

/** 创建（或按新条件重建）订阅。 */
export async function createSubscription(deps: SubscriptionDeps, tenantId: string, subscriptionRowId: string) {
  const row = await deps.db.notificationSubscription.findFirst({ where: { id: subscriptionRowId, tenantId } })
  if (!row) return { status: 'SKIPPED' as const }
  const destination = destinationOf(deps.env ?? process.env)
  if (!destination) throw new NonRetryableError('DESTINATION_NOT_CONFIGURED', '推送接收端尚未配置，订阅保持“未创建”')
  const target = await targetOf(deps, tenantId, row)
  const api = deps.api(target)
  try {
    if (row.subscriptionId)
      await api.remove(row.notificationType, row.subscriptionId).catch(error => {
        if (!(error instanceof UpstreamHttpError && error.status === 404)) throw error
      })
    const created = await api.create(row.notificationType, subscriptionBody(row.notificationType, destination, (row.filterJson as SubscriptionFilter | null) ?? null))
    await deps.db.notificationSubscription.updateMany({
      where: { id: row.id, tenantId },
      data: { subscriptionId: created.subscriptionId, destinationId: destination, status: 'ACTIVE', version: { increment: 1 } },
    })
    return { status: 'ACTIVE' as const }
  } catch (error) {
    if (isClientRejection(error)) {
      await deps.db.notificationSubscription.updateMany({ where: { id: row.id, tenantId }, data: { status: 'INVALID', version: { increment: 1 } } })
      throw new NonRetryableError('SUBSCRIPTION_REJECTED', `亚马逊拒绝了订阅请求（${(error as UpstreamHttpError).status}）`)
    }
    throw error
  }
}

/** 取消订阅并删除记录；亚马逊说“已不存在”视为已取消；其他失败保留记录以便重试。 */
export async function deleteSubscription(deps: SubscriptionDeps, tenantId: string, subscriptionRowId: string) {
  const row = await deps.db.notificationSubscription.findFirst({ where: { id: subscriptionRowId, tenantId } })
  if (!row) return { status: 'SKIPPED' as const }
  if (row.subscriptionId) {
    const target = await targetOf(deps, tenantId, row)
    try {
      await deps.api(target).remove(row.notificationType, row.subscriptionId)
    } catch (error) {
      if (!(error instanceof UpstreamHttpError && error.status === 404)) throw error
    }
  }
  await deps.db.notificationSubscription.deleteMany({ where: { id: row.id, tenantId } })
  return { status: 'DELETED' as const }
}

/** 正式的接口工厂：授权类型用店铺令牌，免授权类型用应用自身令牌。 */
export function spApiNotificationsFactory(options: { secrets: TokenOpener; guardFor: (tenantId: string, connectionId: string) => RequestGuard; fetchImpl?: typeof fetch }): NotificationsApiFactory {
  return ({ grantless, connection, tenantId }) => {
    const client = new AmazonSpApiClient(
      { encryptedRefreshToken: connection?.encryptedRefreshToken ?? null, sellerAccountId: connection?.sellerAccountId ?? null },
      options.secrets,
      connection ? options.guardFor(tenantId, connection.id) : undefined,
    )
    const grantlessToken = async () => {
      const clientId = process.env.AMAZON_SP_LWA_CLIENT_ID
      const clientSecret = process.env.AMAZON_SP_LWA_CLIENT_SECRET
      if (!clientId || !clientSecret) throw new NonRetryableError('LWA_CONFIG_MISSING', '缺少亚马逊应用凭证配置')
      const response = await (options.fetchImpl ?? fetch)(process.env.AMAZON_SP_LWA_TOKEN_URL ?? 'https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'sellingpartnerapi::notifications', client_id: clientId, client_secret: clientSecret }).toString(),
      })
      const payload = (await response.json().catch(() => ({}))) as { access_token?: string }
      if (!response.ok || !payload.access_token) throw new UpstreamHttpError(`LWA_GRANTLESS_FAILED_${response.status}`, response.status, response.headers, 'lwa')
      return payload.access_token
    }
    const token = async () => (grantless ? { accessToken: await grantlessToken() } : {})
    return {
      async create(notificationType, body) {
        const result = await client.request({ method: 'POST', path: `/notifications/v1/subscriptions/${encodeURIComponent(notificationType)}`, body, ...(await token()) })
        const subscriptionId = (result.payload as { subscriptionId?: unknown } | undefined)?.subscriptionId
        if (typeof subscriptionId !== 'string' || !subscriptionId) throw new NonRetryableError('SUBSCRIPTION_RESPONSE_INVALID', '亚马逊返回的订阅信息不完整')
        return { subscriptionId }
      },
      async remove(notificationType, subscriptionId) {
        await client.request({ method: 'DELETE', path: `/notifications/v1/subscriptions/${encodeURIComponent(notificationType)}/${encodeURIComponent(subscriptionId)}`, ...(await token()) })
      },
    }
  }
}
