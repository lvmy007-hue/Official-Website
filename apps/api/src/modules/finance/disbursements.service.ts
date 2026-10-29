import { Injectable } from '@nestjs/common'
import {
  CASHFLOW_CONFIRM,
  DISBURSEMENT_LIST_LIMIT,
  DISBURSEMENT_STATE_LABEL,
  DisbursementConfirmBodySchema,
  addDaysText,
  matchDisbursement,
  roundCash,
  unregisteredStateOf,
  type CashflowDisbursements,
  type DisbursementConfirmResult,
  type DisbursementRecord,
  type DisbursementRow,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { localDate, todayIn, validZone } from '../overview'
import { findSettlement } from './settlements-common'

const num = (value: { toString(): string }) => Number(value.toString())

// 到账手工登记与核对（07 章 7.8“打款记录与到账核对：到账为手工登记”）。
// 结算报告写明每张结算单的打款日与打款金额（预期）；财务在银行流水里看到钱以后登记到账日期、金额、币种与收款账户末四位，系统与预期比较。
// 一张结算单一条登记，改正时带版本号（乐观锁）；每次登记与改正都写审计。币种不同（银行按收款账户币种结汇）不比较金额，也不换算。
@Injectable()
export class DisbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 最近的有打款金额的结算单与各自的登记；只列最近 100 张。 */
  async rows(tenantId: string, scope: ResolvedScope, today: string, zone: string): Promise<CashflowDisbursements> {
    const settlements = await this.prisma.fbaSettlement.findMany({
      where: { tenantId, ...storeWhere(scope), disbursementAmount: { gt: 0 } },
      select: {
        id: true,
        sellerAccountId: true,
        externalSettlementId: true,
        settlementEndDate: true,
        depositDate: true,
        disbursementAmount: true,
        currency: true,
        sellerAccount: { select: { displayName: true } },
        disbursement: { select: { id: true, disbursedAt: true, amount: true, currency: true, bankLast4: true, note: true, version: true, createdBy: true, updatedBy: true, updatedAt: true } },
      },
      orderBy: [{ sortAt: 'desc' }, { id: 'asc' }],
      take: DISBURSEMENT_LIST_LIMIT + 1,
    })
    const shown = settlements.slice(0, DISBURSEMENT_LIST_LIMIT)
    const names = await memberNames(
      this.prisma,
      tenantId,
      shown.flatMap(row => (row.disbursement ? [row.disbursement.createdBy, row.disbursement.updatedBy] : [])),
    )
    const items = shown.map((row): DisbursementRow => {
      const expectedAmount = roundCash(num(row.disbursementAmount ?? 0))
      const expectedDate = row.depositDate ? localDate(row.depositDate, zone) : null
      const saved = row.disbursement
      const registered: DisbursementRecord | null = saved
        ? {
            id: saved.id,
            disbursedAt: saved.disbursedAt.toISOString().slice(0, 10),
            amount: roundCash(num(saved.amount)),
            currency: saved.currency,
            bankLast4: saved.bankLast4,
            note: saved.note,
            version: saved.version,
            createdBy: nameOrFormer(names, saved.createdBy),
            updatedBy: nameOrFormer(names, saved.updatedBy),
            updatedAt: saved.updatedAt.toISOString(),
          }
        : null
      const matched = registered ? matchDisbursement({ expectedAmount, expectedCurrency: row.currency, actualAmount: registered.amount, actualCurrency: registered.currency }) : null
      const state = matched ? matched.state : unregisteredStateOf(expectedDate, today)
      return {
        settlementId: row.id,
        externalSettlementId: row.externalSettlementId,
        sellerAccountId: row.sellerAccountId,
        storeName: row.sellerAccount.displayName,
        periodEnd: row.settlementEndDate ? localDate(row.settlementEndDate, zone) : null,
        expectedDate,
        expectedAmount,
        currency: row.currency,
        registered,
        state,
        stateLabel: DISBURSEMENT_STATE_LABEL[state],
        diff: matched?.diff ?? null,
      }
    })
    const count = (...states: string[]) => items.filter(item => states.includes(item.state)).length
    return {
      items,
      summary: { total: items.length, matched: count('MATCHED'), mismatched: count('SHORT', 'OVER'), awaiting: count('AWAITING'), unregistered: count('UNREGISTERED') },
      truncated: settlements.length > DISBURSEMENT_LIST_LIMIT,
    }
  }

  async confirm(req: RequestWithContext, rawBody: unknown): Promise<DisbursementConfirmResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, CASHFLOW_CONFIRM, {})
    const body = DisbursementConfirmBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const settlement = await findSettlement(this.prisma, tenantId, scope, body.settlementId)
    const expected = settlement.disbursementAmount === null ? null : roundCash(num(settlement.disbursementAmount))
    if (expected === null || expected <= 0) {
      throw appError('DATA_CONDITION_FAILED', '这张结算单在结算报告里没有打款金额（报告未到或本期不打款），没有可登记的到账', { details: { settlementId: settlement.id } })
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone))
    // 到账日期最多比企业时区的今天晚一天（跨时区的日期差），不能登记未来的到账
    if (body.disbursedAt > addDaysText(today, 1)) throw appError('VALIDATION_FAILED', '到账日期不能晚于今天', { fieldErrors: { disbursedAt: ['到账日期不能晚于今天'] } })

    const amount = roundCash(body.amount)
    const data = { disbursedAt: new Date(`${body.disbursedAt}T00:00:00Z`), amount, currency: body.currency, bankLast4: body.bankLast4 ?? null, note: body.note || null }
    const existing = await this.prisma.disbursement.findUnique({
      where: { settlementId: settlement.id },
      select: { id: true, version: true, disbursedAt: true, amount: true, currency: true, bankLast4: true, note: true },
    })
    if (existing && body.version === undefined) {
      throw appError('CONFLICT', `这张结算单已经登记过到账（版本 ${existing.version}）。要改正请刷新后在原登记上修改`, { details: { currentVersion: existing.version } })
    }
    const after = { settlementId: settlement.id, externalSettlementId: settlement.externalSettlementId, ...data, disbursedAt: body.disbursedAt, expectedAmount: expected }
    const saved = await this.prisma
      .$transaction(async tx => {
        if (existing && body.version !== undefined) {
          const next = await updateWithVersion(
            tx.disbursement,
            { id: existing.id, tenantId },
            body.version,
            { ...data, updatedBy: context.userId },
            { label: '到账登记', select: { id: true, version: true } },
          )
          const before = {
            disbursedAt: existing.disbursedAt.toISOString().slice(0, 10),
            amount: num(existing.amount),
            currency: existing.currency,
            bankLast4: existing.bankLast4,
            note: existing.note,
            version: existing.version,
          }
          await this.audit.record(
            req,
            { action: 'DISBURSEMENT_CONFIRMED', resourceType: 'Disbursement', resourceId: existing.id, before, after: { ...after, version: next.version }, reason: data.note ?? undefined },
            { client: tx },
          )
          return { id: existing.id, version: next.version, created: false }
        }
        const row = await tx.disbursement.create({
          data: { tenantId, sellerAccountId: settlement.sellerAccountId, settlementId: settlement.id, ...data, createdBy: context.userId, updatedBy: context.userId },
          select: { id: true, version: true },
        })
        await this.audit.record(
          req,
          { action: 'DISBURSEMENT_CONFIRMED', resourceType: 'Disbursement', resourceId: row.id, after: { ...after, version: row.version }, reason: data.note ?? undefined },
          { client: tx },
        )
        return { id: row.id, version: row.version, created: true }
      })
      .catch((error: unknown) => {
        // 两个人同时第一次登记同一张结算单：后到的撞上唯一键，按“已登记”处理
        if ((error as { code?: string }).code === 'P2002') throw appError('CONFLICT', '这张结算单刚刚已被他人登记到账，请刷新后查看，需要改正再在原登记上修改')
        throw error
      })
    const matched = matchDisbursement({ expectedAmount: expected, expectedCurrency: settlement.currency, actualAmount: amount, actualCurrency: body.currency })
    return { ...saved, state: matched.state, diff: matched.diff }
  }
}
