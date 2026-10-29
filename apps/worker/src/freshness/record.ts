import {
  ADS_ENTITY_SYNC_JOB,
  ADS_REPORT_V1_JOB,
  ADS_WRITE_JOB,
  APLUS_WRITE_JOB,
  INBOUND_OP_JOB,
  LISTING_WRITE_JOB,
  freshnessSourceOfDataset,
  freshnessSourceOfDomain,
  freshnessSourceOfJobType,
  freshnessSourceOfReport,
  freshnessStatusForFailure,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 数据新鲜度记录（P1-28-12，freeze/importers.md 0.4）：同步器每次尝试都在 DataFreshness 里留下“这个来源在这个店铺最近发生了什么”。
// 成功：更新最近成功时间与数据覆盖时间、行数，清除失败码；失败：只记录尝试时间、状态与失败码，保留上一次成功的时间（页面据此显示“已落后多久”）。
// 必须在租户上下文（runWithTenant）里调用。

export interface FreshnessInput {
  tenantId: string
  sellerAccountId: string | null
  sourceKey: string
  ok: boolean
  rowCount?: number
  /** 数据覆盖到的时间点；缺省时成功按“现在”记（增量同步完成即覆盖到此刻） */
  dataThrough?: Date | null
  errorCode?: string | null
  now?: Date
}

export async function recordFreshness(db: Pick<PrismaClient, 'dataFreshness'>, input: FreshnessInput): Promise<void> {
  const now = input.now ?? new Date()
  const where = { tenantId: input.tenantId, sellerAccountId: input.sellerAccountId, sourceKey: input.sourceKey }
  const data = input.ok
    ? { lastAttemptAt: now, lastSuccessAt: now, dataThrough: input.dataThrough ?? now, lastRowCount: input.rowCount ?? 0, status: 'NORMAL', lastErrorCode: null }
    : { lastAttemptAt: now, status: freshnessStatusForFailure(input.errorCode ?? ''), lastErrorCode: (input.errorCode ?? 'SYNC_FAILED').slice(0, 120) }
  const existing = await db.dataFreshness.findFirst({ where, select: { id: true } })
  if (existing) {
    await db.dataFreshness.update({ where: { id: existing.id }, data })
    return
  }
  await db.dataFreshness.create({ data: { ...where, ...data } }).catch(async error => {
    // 并发的另一次同步刚刚创建了这一行：改为更新
    if ((error as { code?: string }).code !== 'P2002') throw error
    await db.dataFreshness.updateMany({ where, data })
  })
}

/**
 * 同步任务的结果落到新鲜度：按任务的数据域找到来源键，按连接所属店铺记录。
 * 没有登记新鲜度来源的数据域（广告、报表等，随各自工作包登记）与没有店铺的连接不记录；记录失败不影响同步本身。
 */
export async function recordSyncOutcome(
  db: Pick<PrismaClient, 'syncJob' | 'dataFreshness'> & Partial<Pick<PrismaClient, 'adsProfile'>>,
  syncJobId: string,
  outcome: { ok: true; rowCount?: number } | { ok: false; errorCode: string },
): Promise<boolean> {
  try {
    const job = await db.syncJob.findUnique({
      where: { id: syncJobId },
      select: { tenantId: true, type: true, domain: true, context: true, requestId: true, connection: { select: { sellerAccountId: true } } },
    })
    // 广告实体与定时广告报表（P5-12A）：广告连接没有店铺，记在广告档案绑定的店铺名下（档案没绑定店铺就不记）；
    // 人工申请的报表不记（窗口是用户选的，成败不代表“每天的广告报表同步”）
    if (job && (job.type === ADS_ENTITY_SYNC_JOB || job.type === ADS_REPORT_V1_JOB)) {
      const source = freshnessSourceOfJobType(job.type)
      const profileId = (job.context as { adsProfileId?: unknown } | null | undefined)?.adsProfileId
      if (!source || (job.type === ADS_REPORT_V1_JOB && job.requestId !== 'schedule') || typeof profileId !== 'string' || !db.adsProfile) return false
      const profile = await db.adsProfile.findFirst({ where: { id: profileId, tenantId: job.tenantId }, select: { sellerAccountId: true } })
      if (!profile?.sellerAccountId) return false
      await recordFreshness(db, { tenantId: job.tenantId, sellerAccountId: profile.sellerAccountId, sourceKey: source.key, ...outcome })
      return true
    }
    // 任务类型单独登记的优先（P2a-07 订阅省）；接口类按数据域找来源；报告类（P2a-05）按任务上下文里的报告类型找来源
    const jobContext = job?.context as { reportType?: unknown; dataset?: unknown } | null | undefined
    const reportType = jobContext?.reportType
    // 数据中心查询（P2b-11）：任务类型都是 DATA_KIOSK_QUERY，按上下文里的数据集找来源（没登记的数据集，如情景模拟，不记录）
    if (job?.type === 'DATA_KIOSK_QUERY') {
      const dataset = freshnessSourceOfDataset(typeof jobContext?.dataset === 'string' ? jobContext.dataset : null)
      if (!dataset || !job.connection.sellerAccountId) return false
      await recordFreshness(db, { tenantId: job.tenantId, sellerAccountId: job.connection.sellerAccountId, sourceKey: dataset.key, ...outcome })
      return true
    }
    const source = freshnessSourceOfJobType(job?.type) ?? freshnessSourceOfDomain(job?.domain) ?? freshnessSourceOfReport(typeof reportType === 'string' ? reportType : null)
    // 入仓计划的写操作（P2a-12）与入仓同步同属 inbound 域，但写操作的成败不代表“入仓同步”的新鲜度
    if (job?.type === INBOUND_OP_JOB) return false
    // 广告写入（P3-17）同属 ads 域，但写入的成败不代表广告同步的新鲜度
    if (job?.type === ADS_WRITE_JOB) return false
    // 刊登写入与查询（P4-10）与刊登同步是两件事：写入的成败不代表“刊登同步”的新鲜度
    if (job?.type === LISTING_WRITE_JOB) return false
    // A+ 写入（P4-14）同属 general 域：写入的成败不代表“A+ 内容同步”的新鲜度（A+ 同步的 APLUS_SYNC 单独登记在 aplus.api）
    if (job?.type === APLUS_WRITE_JOB) return false
    if (!job || !source || !job.connection.sellerAccountId) return false
    await recordFreshness(db, { tenantId: job.tenantId, sellerAccountId: job.connection.sellerAccountId, sourceKey: source.key, ...outcome })
    return true
  } catch {
    return false
  }
}
