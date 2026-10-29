import { Injectable } from '@nestjs/common'
import { AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'

export type ConnectionProvider = 'AMAZON_SP_API' | 'AMAZON_ADS_API'

// 连接域的公开服务：其他领域（同步、报表、入仓、广告）只通过它取得“已授权连接”。连接中心的总览与动作在 connection-center / connection-actions。
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  // 已授权且已保存刷新令牌的卖家接口连接（最近成功同步的优先）。
  async authorizedSpConnection(tenantId: string) {
    const connection = await this.prisma.platformConnection.findFirst({
      where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } },
      orderBy: { lastSuccessfulSyncAt: 'desc' },
    })
    if (!connection) {
      throw new AppError(409, 'FBA_CONNECTION_REQUIRED', '需要已完成授权并且已保存刷新令牌的 Amazon SP-API 连接')
    }
    return connection
  }

  // 连接对应的卖家账户（店铺）。找不到时返回 null，由调用方给出业务提示。
  async sellerAccountOf(tenantId: string, connection: { sellerAccountId: string | null }) {
    return this.prisma.sellerAccount.findFirst({ where: { id: connection.sellerAccountId ?? '', tenantId } })
  }

  // 指定了连接就必须是本租户、该提供方下已授权的那一条：找不到（含属于其他租户）返回 404，不再悄悄换成别的连接；
  // 没有指定时才取该提供方下任一已授权连接。
  async findAuthorized(tenantId: string, provider: ConnectionProvider, connectionId?: string) {
    if (connectionId) {
      const specified = await this.prisma.platformConnection.findFirst({ where: { id: connectionId, tenantId, provider, state: 'AUTHORIZED' } })
      if (!specified) throw new AppError(404, 'RESOURCE_NOT_FOUND', '找不到指定的已授权连接')
      return specified
    }
    return this.prisma.platformConnection.findFirst({ where: { tenantId, provider, state: 'AUTHORIZED' } })
  }

  async authorizedAdsConnection(tenantId: string) {
    return this.prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' } })
  }
}
