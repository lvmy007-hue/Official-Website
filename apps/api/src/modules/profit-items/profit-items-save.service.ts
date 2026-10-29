import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { NEW_ID_PREFIX, PROFIT_DICTIONARY_KIND, PROFIT_ITEM_ACTIONS, PROFIT_ITEM_MANAGE, ProfitItemTreeBodySchema, planProfitItemTree, type ProfitItemsSaveResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { ensureProfitDictionary, snapshotOf } from './profit-items-seed'

const RECOMPUTE_NOTE = '新口径在利润日表下一次重算（每 6 小时近 45 天）后生效；已关账的期间不重算，不受影响。'
const SELECT_ITEM = { id: true, parentId: true, level: true, name: true, group: true, sign: true, isSystem: true, systemKey: true, sort: true } as const

/** 整树保存利润项目字典（P6-18）：版本号乐观锁；一次事务内改项目、改映射、退役旧版本、生成新版本快照并写审计。 */
@Injectable()
export class ProfitItemsSaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async save(req: RequestWithContext, rawBody: unknown): Promise<ProfitItemsSaveResponse> {
    const context = await this.context.authorize(req, PROFIT_ITEM_MANAGE)
    const body = ProfitItemTreeBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    await ensureProfitDictionary(this.prisma, tenantId, context.userId)
    return this.prisma.$transaction(
      async tx => {
        const active = await tx.metricVersion.findFirst({ where: { tenantId, kind: PROFIT_DICTIONARY_KIND, status: 'ACTIVE' }, select: { id: true, versionNo: true, version: true } })
        if (!active) throw appError('DATA_CONDITION_FAILED', '利润项目字典还没有生效版本，请刷新页面')
        if (active.versionNo !== body.version) throw appError('CONFLICT', '字典已被别人修改，请刷新页面后重新编辑', { details: { currentVersion: active.versionNo } })
        const stored = await tx.profitItem.findMany({ where: { tenantId }, select: SELECT_ITEM, take: 1000 })
        const plan = planProfitItemTree(stored, body)
        if (!plan.ok) {
          const first = plan.issues[0]
          throw appError('VALIDATION_FAILED', first?.message ?? '字典内容不合法', { fieldErrors: Object.fromEntries(plan.issues.map(issue => [issue.path, [issue.message]])) })
        }
        const before = { items: stored.length, mappings: await tx.profitItemMapping.count({ where: { tenantId } }) }
        const storedById = new Map(stored.map(item => [item.id, item]))

        // 1. 删除：子项目与映射随外键级联删除
        if (plan.deletedIds.length > 0) await tx.profitItem.deleteMany({ where: { tenantId, id: { in: plan.deletedIds } } })

        // 2. 已有项目：先改成临时名避免同级重名互换时撞唯一键，再写最终内容
        const changed = plan.items.filter(item => {
          const old = storedById.get(item.id)
          return !item.isNew && old !== undefined && (old.name !== item.name || old.parentId !== item.parentId)
        })
        for (const item of changed) await tx.profitItem.updateMany({ where: { tenantId, id: item.id }, data: { name: `~${item.id}` } })
        // 3. 新项目：按层级从上到下创建，临时编号换成正式编号
        const idMap: Record<string, string> = {}
        const realId = (id: string | null): string | null => (id === null ? null : id.startsWith(NEW_ID_PREFIX) ? (idMap[id] ?? null) : id)
        for (const level of [1, 2, 3]) {
          for (const item of plan.items.filter(candidate => candidate.isNew && candidate.level === level)) {
            const id = randomUUID()
            idMap[item.id] = id
            await tx.profitItem.create({
              data: { id, tenantId, parentId: realId(item.parentId), level: item.level, name: item.name, group: item.group, sign: item.sign, isSystem: false, systemKey: null, sort: item.sort },
            })
          }
        }

        // 已有项目的最终内容（父项目可能是刚创建的新项目）
        for (const item of plan.items) {
          const old = storedById.get(item.id)
          if (item.isNew || !old) continue
          if (old.name === item.name && old.parentId === item.parentId && old.sort === item.sort && old.level === item.level) continue
          await tx.profitItem.updateMany({ where: { tenantId, id: item.id }, data: { name: item.name, parentId: realId(item.parentId), level: item.level, sort: item.sort } })
        }

        // 4. 映射：只写差异
        const existing = new Map(
          (await tx.profitItemMapping.findMany({ where: { tenantId }, select: { transactionType: true, itemId: true }, take: 10_000 })).map(row => [row.transactionType, row.itemId]),
        )
        const wanted = new Map(plan.mappings.map(mapping => [mapping.transactionType, realId(mapping.itemId) ?? mapping.itemId]))
        const remove = [...existing].filter(([type, itemId]) => wanted.get(type) !== itemId).map(([type]) => type)
        if (remove.length > 0) await tx.profitItemMapping.deleteMany({ where: { tenantId, transactionType: { in: remove } } })
        const add = [...wanted].filter(([type, itemId]) => existing.get(type) !== itemId).map(([transactionType, itemId]) => ({ tenantId, transactionType, itemId }))
        if (add.length > 0) await tx.profitItemMapping.createMany({ data: add })

        // 5. 版本：退役旧版本（乐观锁），生成新版本快照
        const retired = await tx.metricVersion.updateMany({ where: { id: active.id, tenantId, status: 'ACTIVE', version: active.version }, data: { status: 'RETIRED', version: { increment: 1 } } })
        if (retired.count !== 1) throw appError('CONFLICT', '字典已被别人修改，请刷新页面后重新编辑', { details: { currentVersion: active.versionNo } })
        const finalItems = await tx.profitItem.findMany({ where: { tenantId }, select: SELECT_ITEM, take: 1000 })
        const versionNo = active.versionNo + 1
        await tx.metricVersion.create({
          data: {
            tenantId,
            kind: PROFIT_DICTIONARY_KIND,
            versionNo,
            status: 'ACTIVE',
            effectiveFrom: new Date(),
            approvedBy: context.userId,
            createdBy: context.userId,
            config: snapshotOf({ items: finalItems, mappings: [...wanted].map(([transactionType, itemId]) => ({ transactionType, itemId })) }),
          },
        })
        await this.audit.record(
          req,
          {
            action: PROFIT_ITEM_ACTIONS.saved,
            resourceType: 'ProfitItemDictionary',
            resourceId: String(versionNo),
            before: { version: active.versionNo, ...before },
            after: { version: versionNo, items: finalItems.length, mappings: wanted.size, deleted: plan.deletedIds.length, created: Object.keys(idMap).length },
          },
          { client: tx },
        )
        return { version: versionNo, idMap, items: finalItems.length, mappings: wanted.size, recomputeNote: RECOMPUTE_NOTE }
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
  }
}
