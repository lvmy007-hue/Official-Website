import { Injectable } from '@nestjs/common'
import {
  applyTagChange,
  PRODUCT_META_ACTION,
  PRODUCT_META_ENTITY_TYPE,
  PRODUCT_META_EVENT_KIND,
  PRODUCT_META_WRITE,
  ProductMetaBatchBodySchema,
  productTagProblem,
  US_MARKETPLACE_ID,
  type ProductMetaResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])
const tagsText = (tags: readonly string[]) => (tags.length ? tags.join('、') : '（无）')

/**
 * 批量设置商品负责人与标签（05 章 5.1 批量动作里不写亚马逊的部分）：只改本系统的 FbaProduct.tags / ownerUserId，目录同步从不改这两列。
 * 每个商品带版本号（乐观锁），整批在一个事务里：任何一个冲突或不存在，整批不生效。每个改动的商品写一条变更记录（ASIN 360 的“变更”页签读它）和一条审计。
 */
@Injectable()
export class ProductMetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async update(req: RequestWithContext, rawBody: unknown): Promise<ProductMetaResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PRODUCT_META_WRITE, {})
    const body = ProductMetaBatchBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const ids = body.items.map(item => item.id)
    if (new Set(ids).size !== ids.length) throw appError('DATA_CONDITION_FAILED', '同一个商品不能在一次请求里出现多次')
    if (body.ownerId) {
      const member = await this.prisma.membership.findFirst({ where: { tenantId, userId: body.ownerId, status: 'ACTIVE' }, select: { id: true } })
      if (!member) throw appError('DATA_CONDITION_FAILED', '负责人必须是企业的在职成员')
    }
    const found = await this.prisma.fbaProduct.findMany({
      where: { tenantId, marketplaceId: US_MARKETPLACE_ID, id: { in: ids }, ...storeWhere(scope) },
      select: { id: true, sellerAccountId: true, sellerSku: true, tagIds: true, ownerUserId: true, version: true },
      take: ids.length,
    })
    // 范围外的商品与不存在一样处理，不泄露存在性
    if (found.length !== ids.length) throw appError('RESOURCE_NOT_FOUND', `有 ${ids.length - found.length} 个商品不存在或不在你的数据范围内，整批没有修改`)
    const byId = new Map(found.map(row => [row.id, row]))
    const names = await memberNames(this.prisma, tenantId, [...found.map(row => row.ownerUserId), body.ownerId])

    const plans = body.items.map(item => {
      const current = byId.get(item.id)!
      const nextTags = body.tags ? applyTagChange(current.tagIds, body.tags.mode, body.tags.values) : current.tagIds
      const problem = productTagProblem(nextTags)
      if (problem) throw appError('DATA_CONDITION_FAILED', `商品“${current.sellerSku}”：${problem}`)
      const nextOwner = body.ownerId === undefined ? current.ownerUserId : body.ownerId
      return { item, current, nextTags, nextOwner, changed: !sameList(current.tagIds, nextTags) || current.ownerUserId !== nextOwner }
    })

    const now = new Date()
    const items: ProductMetaResult['items'] = []
    await this.prisma.$transaction(
      async tx => {
        for (const plan of plans) {
          if (!plan.changed) {
            items.push({ id: plan.item.id, version: plan.current.version, tags: plan.current.tagIds, ownerId: plan.current.ownerUserId })
            continue
          }
          const next = await updateWithVersion(
            tx.fbaProduct,
            { id: plan.item.id, tenantId },
            plan.item.version,
            { tagIds: plan.nextTags, ownerUserId: plan.nextOwner },
            { label: '商品', select: { version: true, tagIds: true, ownerUserId: true } },
          )
          const parts = [
            sameList(plan.current.tagIds, plan.nextTags) ? null : `标签：${tagsText(plan.current.tagIds)} → ${tagsText(plan.nextTags)}`,
            plan.current.ownerUserId === plan.nextOwner ? null : `负责人：${nameOrFormer(names, plan.current.ownerUserId, '（无）')} → ${nameOrFormer(names, plan.nextOwner, '（无）')}`,
          ].filter((part): part is string => part !== null)
          const before = { tags: plan.current.tagIds, ownerId: plan.current.ownerUserId }
          const after = { tags: next.tagIds, ownerId: next.ownerUserId }
          await tx.entityEvent.create({
            data: {
              tenantId,
              sellerAccountId: plan.current.sellerAccountId,
              entityType: PRODUCT_META_ENTITY_TYPE,
              entityId: plan.item.id,
              kind: PRODUCT_META_EVENT_KIND,
              occurredAt: now,
              title: parts.join('；'),
              detailJson: { before, after },
              actorKind: 'USER',
              actorId: context.userId,
              sourceRef: `meta:${plan.item.id}:${next.version}`,
            },
          })
          await this.audit.record(req, { action: PRODUCT_META_ACTION, resourceType: 'FbaProduct', resourceId: plan.item.id, before, after }, { client: tx })
          items.push({ id: plan.item.id, version: next.version, tags: next.tagIds, ownerId: next.ownerUserId })
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    const updated = plans.filter(plan => plan.changed).length
    return { updated, unchanged: plans.length - updated, items }
  }
}
