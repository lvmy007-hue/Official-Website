import { Injectable } from '@nestjs/common'
import { DASHBOARD_FOLDER_MAX, DASHBOARD_WRITE, FolderBodySchema } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { assertUniqueName, isUniqueViolation } from './dashboard-access'

// 仪表盘文件夹（P6-33）：只属于创建人。树最多 8 层，不能把文件夹放进自己的子孙里。

const viewOf = (row: { id: string; parentId: string | null; name: string; version: number }) => ({
  id: row.id,
  parentId: row.parentId,
  name: row.name,
  version: row.version,
})

@Injectable()
export class DashboardFolderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async create(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const body = FolderBodySchema.parse(raw)
    await this.assertParent(context.tenantId, context.userId, body.parentId ?? null)
    const count = await this.prisma.dashboardFolder.count({ where: { tenantId: context.tenantId, ownerId: context.userId } })
    if (count >= DASHBOARD_FOLDER_MAX) throw appError('QUOTA_EXCEEDED', `每个成员最多 ${DASHBOARD_FOLDER_MAX} 个文件夹`)
    await assertUniqueName(this.prisma, 'dashboardFolder', { tenantId: context.tenantId, ownerId: context.userId, name: body.name, parentId: body.parentId ?? null }, '文件夹')
    try {
      const row = await this.prisma.dashboardFolder.create({
        data: { tenantId: context.tenantId, ownerId: context.userId, name: body.name, parentId: body.parentId ?? null, version: 1 },
      })
      if (req.params) req.params.id = row.id
      return viewOf(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '同一位置已经有同名文件夹')
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const body = FolderBodySchema.parse(raw)
    if (!body.version) throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
    const current = await this.prisma.dashboardFolder.findFirst({ where: { id, tenantId: context.tenantId, ownerId: context.userId } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '文件夹不存在')
    await this.assertParent(context.tenantId, context.userId, body.parentId ?? null, id)
    await assertUniqueName(this.prisma, 'dashboardFolder', { tenantId: context.tenantId, ownerId: context.userId, name: body.name, parentId: body.parentId ?? null, selfId: id }, '文件夹')
    try {
      const row = await updateWithVersion(this.prisma.dashboardFolder, { id, tenantId: context.tenantId }, body.version, { name: body.name, parentId: body.parentId ?? null }, { label: '文件夹' })
      return viewOf(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '同一位置已经有同名文件夹')
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const result = await this.prisma.dashboardFolder.deleteMany({ where: { id, tenantId: context.tenantId, ownerId: context.userId } })
    if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '文件夹不存在')
    return { id }
  }

  private async assertParent(tenantId: string, ownerId: string, parentId: string | null, selfId?: string) {
    if (!parentId) return
    if (parentId === selfId) throw appError('VALIDATION_FAILED', '文件夹不能放到自己下面', { fieldErrors: { parentId: ['不能选择自己'] } })
    let current: string | null = parentId
    const seen = new Set<string>()
    for (let depth = 0; depth < 8 && current; depth += 1) {
      if (current === selfId || seen.has(current)) throw appError('VALIDATION_FAILED', '文件夹不能放到自己的下级里', { fieldErrors: { parentId: ['不能选择自己的下级'] } })
      seen.add(current)
      const row: { parentId: string | null } | null = await this.prisma.dashboardFolder.findFirst({
        where: { id: current, tenantId, ownerId },
        select: { parentId: true },
      })
      if (!row) throw appError('VALIDATION_FAILED', '上级文件夹不存在', { fieldErrors: { parentId: ['上级文件夹不存在'] } })
      current = row.parentId
    }
    if (current) throw appError('VALIDATION_FAILED', '文件夹最多 8 层', { fieldErrors: { parentId: ['最多 8 层'] } })
  }
}
