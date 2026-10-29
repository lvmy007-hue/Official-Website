import { Injectable } from '@nestjs/common'
import { GuardrailListQuerySchema, GuardrailUpsertBodySchema, PRICING_GUARDRAIL_ACTION, PRICING_READ, PRICING_RULE_WRITE, type GuardrailListResponse, type GuardrailView } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { storesOf } from './pricing-common'
import { loadGuardrails } from './pricing-load'
import { guardrailViewOf } from './pricing-rule-view'

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const LIST_MAX = 2000

/** 价格护栏（05 章 5.5）：店铺、类目、ASIN、SKU 四层，每层可设最低价、最高价、最低利润率与单次调幅上限；PUT 是按（店铺、层级、对象）整体保存，已存在时必须带版本号。 */
@Injectable()
export class PricingGuardrailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<GuardrailListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_READ, {})
    const query = GuardrailListQuerySchema.parse(rawQuery.storeId ? { storeId: rawQuery.storeId } : {})
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const stores = (await storesOf(this.prisma, context.tenantId, scope)).filter(store => !query.storeId || store.id === query.storeId)
    const rows = await loadGuardrails(
      this.prisma,
      context.tenantId,
      stores.map(store => store.id),
    )
    const names = new Map(stores.map(store => [store.id, store.name]))
    return { items: rows.map(row => guardrailViewOf(row, names.get(row.sellerAccountId) ?? '')), truncated: rows.length >= LIST_MAX }
  }

  async upsert(req: RequestWithContext, rawBody: unknown): Promise<GuardrailView> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_RULE_WRITE, {})
    const body = GuardrailUpsertBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    const tenantId = context.tenantId
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.storeId, tenantId }, select: { displayName: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const key = { tenantId, sellerAccountId: body.storeId, scope: body.scope, scopeRef: body.scopeRef }
    const data = {
      minPrice: body.minPrice ?? null,
      maxPrice: body.maxPrice ?? null,
      minMarginPct: body.minMarginPct ?? null,
      maxChangePct: body.maxChangePct ?? null,
      enabled: body.enabled,
      updatedBy: context.userId,
    }
    try {
      const row = await this.prisma.$transaction(async tx => {
        const existing = await tx.priceGuardrail.findFirst({ where: key })
        let saved
        if (existing) {
          if (body.expectedVersion === undefined) throw appError('CONFLICT', '这一层护栏已经存在，请刷新后在原有设置上修改', { details: { code: 'VERSION_REQUIRED' } })
          await updateWithVersion(tx.priceGuardrail, { id: existing.id, tenantId }, body.expectedVersion, data, { label: '价格护栏' })
          saved = await tx.priceGuardrail.findFirstOrThrow({ where: { id: existing.id, tenantId } })
        } else {
          saved = await tx.priceGuardrail.create({ data: { ...key, ...data } })
        }
        await this.audit.record(
          req,
          {
            action: PRICING_GUARDRAIL_ACTION,
            resourceType: 'PriceGuardrail',
            resourceId: saved.id,
            before: existing ? { version: existing.version, enabled: existing.enabled } : null,
            after: { scope: body.scope, scopeRef: body.scopeRef, enabled: body.enabled, version: saved.version },
          },
          { client: tx },
        )
        return saved
      })
      return guardrailViewOf(
        {
          id: row.id,
          sellerAccountId: row.sellerAccountId,
          scope: row.scope,
          scopeRef: row.scopeRef,
          minPrice: row.minPrice === null ? null : Number(row.minPrice.toString()),
          maxPrice: row.maxPrice === null ? null : Number(row.maxPrice.toString()),
          minMarginPct: row.minMarginPct === null ? null : Number(row.minMarginPct.toString()),
          maxChangePct: row.maxChangePct === null ? null : Number(row.maxChangePct.toString()),
          enabled: row.enabled,
          version: row.version,
          updatedAt: row.updatedAt,
        },
        store.displayName,
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '这一层护栏刚被别人保存，请刷新后再试', { details: { code: 'VERSION_CONFLICT' } })
      throw error
    }
  }
}
