import { Injectable } from '@nestjs/common'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { movementsWhere } from './inventory.queries'

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async movements(req: RequestWithContext, query: Record<string, string>) {
    const { context, scope } = await this.context.authorizeScoped(req, 'inventory.read', query)
    return this.prisma.inventoryMovement.findMany({
      where: movementsWhere(context.tenantId, scope, query),
      orderBy: { occurredAt: 'desc' },
      take: 200,
    })
  }

  async warehouses(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'warehouse.read')
    return this.prisma.warehouse.findMany({
      where: { tenantId: context.tenantId },
      orderBy: { code: 'asc' },
      include: { _count: { select: { movements: true } } },
    })
  }
}
