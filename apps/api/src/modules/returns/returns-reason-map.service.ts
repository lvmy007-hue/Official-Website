import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  RETURN_REASON_BLOCKED_NO_PERMISSION,
  RETURN_REASON_CATEGORIES,
  RETURN_REASON_MAP_ACTION,
  RETURN_REASON_MAP_LIMIT,
  RETURN_REASON_MAP_PERMISSION,
  RETURN_REASON_MAP_WRITE,
  RETURN_REASON_PRESETS,
  ReturnReasonMapBodySchema,
  ReturnReasonMapQuerySchema,
  UNCLASSIFIED_CATEGORY,
  reasonKey,
  type ReasonOverride,
  type ReturnReasonMapListResponse,
  type ReturnReasonMapPutResponse,
  type ReturnReasonMapRow,
} from '@nova/api-contracts'
import type { ReturnReasonMap } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'

// 退货原因映射（P6-13，16 章第 6 节；freeze/api.md `/returns/reason-map`）：亚马逊原因代码 → 中文释义 → 大类。
// 预置映射在契约里；本表只存企业改过的预置项、自己加的项，以及导入退货报告时发现的新代码（自动加入，大类“未分类”）。
// 读取要 returns.read，保存要 settings.write（在服务里先于参数校验检查）；每个企业最多 RETURN_REASON_MAP_LIMIT 行（预置之外）。

export type ReasonMapIndex = Map<string, ReasonOverride>

type Own = Pick<ReturnReasonMap, 'code' | 'labelZh' | 'category' | 'isSystem' | 'updatedAt'>

function rowOf(code: string, own: Own | undefined): ReturnReasonMapRow {
  const preset = RETURN_REASON_PRESETS[code]
  if (own) {
    const unclassified = own.category === UNCLASSIFIED_CATEGORY
    const source = preset ? 'PRESET_EDITED' : unclassified ? 'AUTO' : 'CUSTOM'
    return {
      code,
      labelZh: own.labelZh,
      category: own.category,
      source,
      presetLabelZh: preset?.labelZh ?? null,
      presetCategory: preset?.category ?? null,
      unclassified,
      updatedAt: own.updatedAt.toISOString(),
    }
  }
  return { code, labelZh: preset!.labelZh, category: preset!.category, source: 'PRESET', presetLabelZh: preset!.labelZh, presetCategory: preset!.category, unclassified: false, updatedAt: null }
}

const SORT_VALUE: Record<string, (row: ReturnReasonMapRow) => string> = {
  code: row => row.code,
  category: row =>
    RETURN_REASON_CATEGORIES.indexOf(row.category as (typeof RETURN_REASON_CATEGORIES)[number])
      .toString()
      .padStart(2, '0') + row.category,
  updatedAt: row => row.updatedAt ?? '',
}

@Injectable()
export class ReturnsReasonMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 企业的映射（只读叠加用）：最多读 LIMIT 行；调用方在自己的权限检查之后使用。 */
  async index(tenantId: string): Promise<ReasonMapIndex> {
    const rows = await this.prisma.returnReasonMap.findMany({
      where: { tenantId },
      select: { code: true, labelZh: true, category: true, isSystem: true },
      orderBy: { code: 'asc' },
      take: RETURN_REASON_MAP_LIMIT,
    })
    return new Map(rows.map(row => [row.code, { labelZh: row.labelZh, category: row.category, isSystem: row.isSystem }]))
  }

  private async load(tenantId: string): Promise<Own[]> {
    return this.prisma.returnReasonMap.findMany({
      where: { tenantId },
      select: { code: true, labelZh: true, category: true, isSystem: true, updatedAt: true },
      orderBy: { code: 'asc' },
      take: RETURN_REASON_MAP_LIMIT,
    })
  }

  private merged(own: readonly Own[]): ReturnReasonMapRow[] {
    const byCode = new Map(own.map(row => [row.code, row]))
    const codes = new Set([...Object.keys(RETURN_REASON_PRESETS), ...byCode.keys()])
    return [...codes].map(code => rowOf(code, byCode.get(code)))
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnReasonMapListResponse> {
    const { context } = await this.context.authorizeScoped(req, RETURN_REASON_MAP_PERMISSION, {})
    const query = ReturnReasonMapQuerySchema.parse(rawQuery)
    const all = this.merged(await this.load(context.tenantId))
    const needle = query.q?.toLowerCase()
    const filtered = all.filter(row => (!query.category || row.category === query.category) && (!needle || row.code.toLowerCase().includes(needle) || row.labelZh.toLowerCase().includes(needle)))
    const value = SORT_VALUE[query.sort.field] ?? SORT_VALUE.code!
    const sign = query.sort.dir === 'desc' ? -1 : 1
    filtered.sort((a, b) => sign * value(a).localeCompare(value(b)) || a.code.localeCompare(b.code))
    const canManage = hasPermission(context.permissions, RETURN_REASON_MAP_WRITE)
    return {
      items: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      summary: {
        total: all.length,
        unclassified: all.filter(row => row.unclassified).length,
        edited: all.filter(row => row.source === 'PRESET_EDITED').length,
        custom: all.filter(row => row.source === 'CUSTOM' || row.source === 'AUTO').length,
      },
      categories: RETURN_REASON_CATEGORIES,
      canManage,
      manageBlockedReason: canManage ? null : RETURN_REASON_BLOCKED_NO_PERMISSION,
    }
  }

  async put(req: RequestWithContext, rawBody: unknown): Promise<ReturnReasonMapPutResponse> {
    const { context } = await this.context.authorizeScoped(req, RETURN_REASON_MAP_WRITE, {})
    const body = ReturnReasonMapBodySchema.parse(rawBody)
    const items = body.items.map(item => ({ code: reasonKey(item.code), labelZh: item.labelZh, category: item.category }))
    const { tenantId } = context
    const result = await this.prisma.$transaction(async tx => {
      const existing = await tx.returnReasonMap.findMany({ where: { tenantId, code: { in: items.map(item => item.code) } }, select: { code: true, labelZh: true, category: true } })
      const before = new Map(existing.map(row => [row.code, row]))
      const total = await tx.returnReasonMap.count({ where: { tenantId } })
      const added = items.filter(item => !before.has(item.code)).length
      if (total + added > RETURN_REASON_MAP_LIMIT) throw appError('CONFLICT', `每个企业最多保存 ${RETURN_REASON_MAP_LIMIT} 条退货原因映射，请先整理不用的`)
      for (const item of items) {
        const isSystem = item.code in RETURN_REASON_PRESETS
        await tx.returnReasonMap.upsert({
          where: { tenantId_code: { tenantId, code: item.code } },
          create: { tenantId, code: item.code, labelZh: item.labelZh, category: item.category, isSystem },
          update: { labelZh: item.labelZh, category: item.category, isSystem },
        })
      }
      const changes = items.map(item => {
        const prior = before.get(item.code) ?? RETURN_REASON_PRESETS[item.code]
        return { code: item.code, before: prior ? { labelZh: prior.labelZh, category: prior.category } : null, after: { labelZh: item.labelZh, category: item.category } }
      })
      await this.audit.record(req, { action: RETURN_REASON_MAP_ACTION, resourceType: 'ReturnReasonMap', resourceId: null, detail: { count: items.length, changes } }, { client: tx })
      return tx.returnReasonMap.findMany({ where: { tenantId, code: { in: items.map(item => item.code) } }, select: { code: true, labelZh: true, category: true, isSystem: true, updatedAt: true } })
    })
    const byCode = new Map(result.map(row => [row.code, row]))
    return { saved: items.length, items: items.map(item => rowOf(item.code, byCode.get(item.code))) }
  }
}
