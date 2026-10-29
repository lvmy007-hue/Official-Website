import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  REVIEWS_ACTIONS,
  REVIEWS_IMPORT_PERMISSION,
  REVIEWS_LIMITS,
  RatingsImportBodySchema,
  parseRatingsFile,
  type RatingsFileRow,
  type RatingsImportError,
  type RatingsImportResult,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { todayIn } from '../overview'
import { assertStoreInScope, ContextService } from '../auth'
import { chunk, zoneOf } from './reviews-common'

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`)
const lineOf = (error: RatingsImportError) => `第 ${error.line} 行${error.column ? `（${error.column}）` : ''}：${error.message}`

/** 文件里的逐行错误转成表单字段错误：前 50 条逐行列出，其余只给条数。 */
export function importErrorLines(errors: readonly RatingsImportError[]): string[] {
  const lines = errors.slice(0, REVIEWS_LIMITS.importErrorsShown).map(lineOf)
  return errors.length > lines.length ? [...lines, `还有 ${errors.length - lines.length} 条错误没有列出，请先修正以上问题后重新导入`] : lines
}

/**
 * 评分文件导入（05 章 5.7、importers.md F-01）：权限 data.import → 参数 → 店铺在范围内 → 解析 → 一行有错整份拒绝。
 * 同一店铺、ASIN、采集日期再次导入时覆盖；每行标注来源（文件导入）、批次、文件名与导入人。审计只记行数与文件名，不记文件内容。
 */
@Injectable()
export class ReviewsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async importRatings(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<RatingsImportResult> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, REVIEWS_IMPORT_PERMISSION, {})
    const body = RatingsImportBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    const tenantId = context.tenantId
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.storeId, tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const parsed = parseRatingsFile(body.content, todayIn(await zoneOf(this.prisma, tenantId), now))
    if (parsed.errors.length > 0) {
      throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: importErrorLines(parsed.errors) }, details: { errorCount: parsed.errors.length } })
    }
    const batchId = randomUUID()
    const replaced = await this.prisma.$transaction(async tx => {
      const count = await this.overwrite(tx, tenantId, store.id, parsed.rows, { batchId, fileName: body.fileName, importedBy: context.userId })
      await this.audit.record(
        req,
        {
          action: REVIEWS_ACTIONS.ratingsImported,
          resourceType: 'ReviewMetricSnapshot',
          resourceId: batchId,
          after: { storeId: store.id, fileName: body.fileName, rows: parsed.rows.length, replaced: count },
        },
        { client: tx },
      )
      return count
    })
    return { imported: parsed.rows.length, replaced, batchId, fileName: body.fileName, errors: [] }
  }

  /** 按（店铺、ASIN、采集日期）覆盖：同一天的旧记录先删再写，返回被覆盖的行数。 */
  private async overwrite(
    tx: Prisma.TransactionClient,
    tenantId: string,
    storeId: string,
    rows: readonly RatingsFileRow[],
    source: { batchId: string; fileName: string; importedBy: string },
  ): Promise<number> {
    let replaced = 0
    const byDate = new Map<string, string[]>()
    for (const row of rows) byDate.set(row.captureDate, [...(byDate.get(row.captureDate) ?? []), row.asin])
    for (const [day, asins] of byDate)
      for (const part of chunk(asins, 1000))
        replaced += (await tx.reviewMetricSnapshot.deleteMany({ where: { tenantId, sellerAccountId: storeId, captureDate: asDate(day), asin: { in: part } } })).count
    for (const part of chunk(rows, 1000)) {
      await tx.reviewMetricSnapshot.createMany({
        data: part.map(row => ({
          tenantId,
          sellerAccountId: storeId,
          asin: row.asin,
          avgRating: row.avgRating,
          ratingCount: row.ratingCount,
          distributionJson: row.distribution ?? undefined,
          captureDate: asDate(row.captureDate),
          sourceKind: 'FILE_IMPORT',
          sourceFileId: source.batchId,
          sourceFileName: source.fileName,
          importedBy: source.importedBy,
        })),
      })
    }
    return replaced
  }
}
