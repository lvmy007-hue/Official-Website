import { Injectable } from '@nestjs/common'
import {
  ENTITY_READ,
  ENTITY_WRITE,
  LEGAL_ENTITY_ACTIONS,
  LegalEntityCreateSchema,
  LegalEntityListQuerySchema,
  LegalEntityUpdateBodySchema,
  entityDeactivateBlockReason,
  type LegalEntityListResponse,
  type LegalEntityRow,
  type LegalEntityUpdateResult,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, assertUnrestricted, storeWhere } from '../auth'
import { entityRowOf, entityScopeWhere, entitySnapshot, entityWriteBlock } from './entities-common'

const COUNT_LIMIT = 20000
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const duplicateName = (name: string) => appError('CONFLICT', `主体名称“${name}”已存在`, { fieldErrors: { name: ['名称已被其他主体使用'] } })

// 法律主体（P5-07，09 章 9.9）：列表、新增、修改（含停用与恢复）。详情在 EntitiesDetailService。
// 店铺数与广告账户数只统计当前账号数据范围内的；广告账户数 = 绑定在名下店铺上的广告档案数（没有绑定店铺的广告账户不属于任何主体）。
@Injectable()
export class EntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<LegalEntityListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ENTITY_READ, {})
    const query = LegalEntityListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const visible: Prisma.LegalEntityWhereInput = { tenantId, ...entityScopeWhere(scope) }
    const where: Prisma.LegalEntityWhereInput = {
      ...visible,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { registrationNo: { contains: query.q, mode: 'insensitive' } },
              { registeredCountry: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [rows, total, statusCounts] = await Promise.all([
      this.prisma.legalEntity.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.legalEntity.count({ where }),
      this.prisma.legalEntity.groupBy({ by: ['status'], where: visible, _count: { _all: true }, orderBy: { status: 'asc' } }),
    ])
    const entityIds = rows.map(row => row.id)
    const stores = entityIds.length
      ? await this.prisma.sellerAccount.findMany({ where: { tenantId, legalEntityId: { in: entityIds }, ...storeWhere(scope, 'id') }, select: { id: true, legalEntityId: true }, take: COUNT_LIMIT })
      : []
    const profiles = stores.length
      ? await this.prisma.adsProfile.groupBy({
          by: ['sellerAccountId'],
          where: { tenantId, sellerAccountId: { in: stores.map(store => store.id) } },
          _count: { _all: true },
          orderBy: { sellerAccountId: 'asc' },
          take: COUNT_LIMIT,
        })
      : []
    const profileCount = new Map(profiles.flatMap(group => (group.sellerAccountId ? [[group.sellerAccountId, group._count._all] as const] : [])))
    const storeCounts = new Map<string, number>()
    const adsCounts = new Map<string, number>()
    for (const store of stores) {
      storeCounts.set(store.legalEntityId, (storeCounts.get(store.legalEntityId) ?? 0) + 1)
      adsCounts.set(store.legalEntityId, (adsCounts.get(store.legalEntityId) ?? 0) + (profileCount.get(store.id) ?? 0))
    }
    const countOf = (status: string) => statusCounts.find(group => group.status === status)?._count._all ?? 0
    const blocked = entityWriteBlock(context.permissions, scope)
    return {
      items: rows.map(row => entityRowOf(row, storeCounts.get(row.id) ?? 0, adsCounts.get(row.id) ?? 0)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      summary: { total: statusCounts.reduce((sum, group) => sum + group._count._all, 0), active: countOf('ACTIVE'), inactive: countOf('INACTIVE') },
      canWrite: blocked === null,
      writeBlockedReason: blocked,
    }
  }

  async create(req: RequestWithContext, rawInput: unknown): Promise<LegalEntityRow> {
    // 新增只要求权限，不要求已被授予店铺范围：新企业第一步就是登记主体，那时还没有任何店铺
    const context = await this.context.authorize(req, ENTITY_WRITE)
    const input = LegalEntityCreateSchema.parse(rawInput)
    try {
      // 业务数据与审计在同一个事务里提交：审计写失败则主体也不创建
      return await this.prisma.$transaction(async tx => {
        const entity = await tx.legalEntity.create({ data: { tenantId: context.tenantId, name: input.name, registeredCountry: input.registeredCountry, registrationNo: input.registrationNo || null } })
        await this.audit.record(req, { action: LEGAL_ENTITY_ACTIONS.created, resourceType: 'LegalEntity', resourceId: entity.id, after: entitySnapshot(entity) }, { client: tx })
        return entityRowOf(entity, 0, 0)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(input.name)
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<LegalEntityUpdateResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ENTITY_WRITE, {})
    assertUnrestricted(scope)
    const { version, reason, ...changes } = LegalEntityUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const before = await this.prisma.legalEntity.findFirst({ where: { id, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '法律主体不存在')
    // 清空注册号传 null；空字符串也当作清空。只保留真正变化的字段
    const next = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.registeredCountry !== undefined ? { registeredCountry: changes.registeredCountry } : {}),
      ...(changes.registrationNo !== undefined ? { registrationNo: changes.registrationNo || null } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
    }
    const data = Object.fromEntries(Object.entries(next).filter(([key, value]) => before[key as keyof typeof before] !== value))
    const [storeCount, adsCount] = await this.counts(tenantId, id)
    if (Object.keys(data).length === 0) return { entity: entityRowOf(before, storeCount, adsCount), changed: false }
    if (data.status === 'INACTIVE') {
      const block = entityDeactivateBlockReason(storeCount)
      if (block) throw appError('DATA_CONDITION_FAILED', block, { details: { storeCount } })
      if (!reason) throw appError('VALIDATION_FAILED', '停用法律主体请写明原因', { fieldErrors: { reason: ['请填写停用原因'] } })
    }
    try {
      const after = await this.prisma.$transaction(async tx => {
        const updated = await updateWithVersion(tx.legalEntity, { id, tenantId }, version, data, { label: '法律主体' })
        await this.audit.record(
          req,
          { action: LEGAL_ENTITY_ACTIONS.updated, resourceType: 'LegalEntity', resourceId: id, before: entitySnapshot(before), after: entitySnapshot(updated), reason },
          { client: tx },
        )
        return updated
      })
      return { entity: entityRowOf(after, storeCount, adsCount), changed: true }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(String(data.name ?? before.name))
      throw error
    }
  }

  /** 名下店铺数与广告账户数（修改在“全部店铺”范围下进行，所以这里不按范围收窄）。 */
  private async counts(tenantId: string, entityId: string): Promise<[number, number]> {
    const [storeCount, adsCount] = await Promise.all([
      this.prisma.sellerAccount.count({ where: { tenantId, legalEntityId: entityId } }),
      this.prisma.adsProfile.count({ where: { tenantId, sellerAccount: { legalEntityId: entityId } } }),
    ])
    return [storeCount, adsCount]
  }
}
