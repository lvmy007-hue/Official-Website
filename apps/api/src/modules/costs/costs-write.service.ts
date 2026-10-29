import { Injectable } from '@nestjs/common'
import {
  COST_COMPONENT_COLUMN,
  COST_COMPONENTS,
  CostActivateBodySchema,
  CostDiscardQuerySchema,
  CostVersionCreateBodySchema,
  CostVersionUpdateBodySchema,
  type CostActivateResult,
  type CostWriteResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { activateOne } from './costs-activate'
import { CostsAccessService } from './costs-access.service'
import { asDay, COST_SELECT, futureLimit, isUniqueViolation, loadClosedPeriods, nextVersionNo, stateConflict, statusOf, tenantToday } from './costs-common'

const LABEL = '成本版本'
const fieldError = (field: string, message: string) => appError('VALIDATION_FAILED', message, { fieldErrors: { [field]: [message] } })

/** 系统生成的草稿（采购收货、头程分摊）只能改这些：采购单价与头程分摊来自单据，不在这里改。 */
const LIMITED_KEYS = ['effectiveFrom', 'unitDutyCost', 'unitOtherCost', 'note', 'version'] as const

// 商品成本的写入（05 章 5.9：新建、确认生效；另有改草稿与丢弃草稿）。每个写入先查权限与“全部店铺”范围，再校验参数；
// 改动一律带版本号（乐观锁）并在同一个事务里写审计。成本不能直接改已生效的版本：要改就新建一个版本，旧版本留作历史。
@Injectable()
export class CostsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CostsAccessService,
    private readonly audit: AuditWriter,
  ) {}

  /** SKU 必须是已知商品，或已经有成本版本；防止拼错的 SKU 变成没人看得见的成本。 */
  private async requireKnownSku(tenantId: string, sku: string): Promise<void> {
    const known =
      (await this.prisma.fbaProduct.findFirst({ where: { tenantId, sellerSku: sku }, select: { id: true } })) ??
      (await this.prisma.costVersion.findFirst({ where: { tenantId, sku }, select: { id: true } }))
    if (!known) throw fieldError('sku', `SKU “${sku}” 不存在：请先同步商品，或检查拼写`)
  }

  private requireDay(day: string, today: string, field = 'effectiveFrom') {
    if (day > futureLimit(today)) throw fieldError(field, `生效日期不能晚于今天一年（${futureLimit(today)}）`)
  }

  async create(req: RequestWithContext, rawBody: unknown, now: Date = new Date()): Promise<CostWriteResult> {
    const access = await this.access.write(req)
    const body = CostVersionCreateBodySchema.parse(rawBody)
    const { tenantId, context } = access
    const today = await tenantToday(this.prisma, tenantId, now)
    this.requireDay(body.effectiveFrom, today)
    await this.requireKnownSku(tenantId, body.sku)
    const closed = body.activate ? await loadClosedPeriods(this.prisma, tenantId) : []
    const saved = await this.prisma
      .$transaction(async tx => {
        const row = await tx.costVersion.create({
          data: {
            tenantId,
            sku: body.sku,
            versionNo: await nextVersionNo(tx, tenantId, body.sku),
            effectiveFrom: asDay(body.effectiveFrom),
            currency: body.currency,
            unitProductCost: body.unitProductCost ?? null,
            unitFirstMileCost: body.unitFirstMileCost ?? null,
            unitDutyCost: body.unitDutyCost ?? null,
            unitOtherCost: body.unitOtherCost ?? null,
            source: 'MANUAL',
            status: 'DRAFT',
            note: body.note || null,
            createdBy: context.userId,
          },
          select: { id: true, version: true, versionNo: true },
        })
        await this.audit.record(
          req,
          {
            action: 'COST_VERSION_CREATED',
            resourceType: 'CostVersion',
            resourceId: row.id,
            after: {
              sku: body.sku,
              versionNo: row.versionNo,
              effectiveFrom: body.effectiveFrom,
              currency: body.currency,
              unitProductCost: body.unitProductCost ?? null,
              unitFirstMileCost: body.unitFirstMileCost ?? null,
              unitDutyCost: body.unitDutyCost ?? null,
              unitOtherCost: body.unitOtherCost ?? null,
              source: 'MANUAL',
            },
          },
          { client: tx },
        )
        if (!body.activate) return { ...row, status: 'DRAFT' as const }
        await activateOne({ req, audit: this.audit, tx, tenantId, userId: context.userId, closed, now }, row.id, row.version)
        return { ...row, version: row.version + 1, status: 'ACTIVE' as const }
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw appError('CONFLICT', '这个 SKU 刚刚被别人新建了一个版本，请刷新后重试')
        throw error
      })
    return {
      id: saved.id,
      version: saved.version,
      versionNo: saved.versionNo,
      status: saved.status,
      message: saved.status === 'ACTIVE' ? `已新建第 ${saved.versionNo} 版并生效` : `已新建第 ${saved.versionNo} 版草稿，确认生效后才参与利润计价`,
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown, now: Date = new Date()): Promise<CostWriteResult> {
    const access = await this.access.write(req)
    const body = CostVersionUpdateBodySchema.parse(rawBody)
    const { tenantId } = access
    const row = await this.prisma.costVersion.findFirst({ where: { id, tenantId }, select: COST_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '版本不存在')
    if (row.status !== 'DRAFT') throw stateConflict('只有草稿可以修改；已生效的版本不能直接改，请新建一个版本')
    const userOwned = row.source === 'MANUAL' || row.source === 'FILE_IMPORT'
    if (!userOwned) {
      const blocked = Object.keys(body).filter(key => !(LIMITED_KEYS as readonly string[]).includes(key))
      if (blocked.length > 0) throw fieldError(blocked[0] as string, '这是由采购收货或头程分摊生成的草稿：采购单价、头程分摊与币种来自单据，请到来源单据处理；这里只能改关税、其他成本、生效日与备注')
    }
    if (body.effectiveFrom) this.requireDay(body.effectiveFrom, await tenantToday(this.prisma, tenantId, now))
    const data: Record<string, unknown> = {}
    if (body.effectiveFrom !== undefined) data.effectiveFrom = asDay(body.effectiveFrom)
    if (body.currency !== undefined) data.currency = body.currency
    if (body.note !== undefined) data.note = body.note || null
    for (const component of COST_COMPONENTS) {
      const column = COST_COMPONENT_COLUMN[component]
      if (body[column] !== undefined) data[column] = body[column]
    }
    const merged = COST_COMPONENTS.map(component => (COST_COMPONENT_COLUMN[component] in data ? data[COST_COMPONENT_COLUMN[component]] : row[COST_COMPONENT_COLUMN[component]]))
    if (merged.every(value => value === null || value === undefined)) throw fieldError('unitProductCost', '四项成本不能全部清空')
    const before = {
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      currency: row.currency,
      unitProductCost: row.unitProductCost?.toString() ?? null,
      unitFirstMileCost: row.unitFirstMileCost?.toString() ?? null,
      unitDutyCost: row.unitDutyCost?.toString() ?? null,
      unitOtherCost: row.unitOtherCost?.toString() ?? null,
      note: row.note,
    }
    const saved = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.costVersion, { id, tenantId, status: 'DRAFT' }, body.version, data, { label: LABEL, select: { id: true, version: true, versionNo: true } })
      await this.audit.record(
        req,
        {
          action: 'COST_VERSION_UPDATED',
          resourceType: 'CostVersion',
          resourceId: id,
          before,
          after: { ...before, ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'version')) },
          detail: { sku: row.sku, versionNo: row.versionNo },
        },
        { client: tx },
      )
      return next
    })
    return { id, version: saved.version, versionNo: saved.versionNo, status: 'DRAFT', message: `已保存第 ${saved.versionNo} 版草稿` }
  }

  async discard(req: RequestWithContext, id: string, rawQuery: unknown): Promise<CostWriteResult> {
    const access = await this.access.write(req)
    const query = CostDiscardQuerySchema.parse(rawQuery)
    const { tenantId } = access
    const row = await this.prisma.costVersion.findFirst({ where: { id, tenantId }, select: COST_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '版本不存在')
    if (row.status !== 'DRAFT') throw stateConflict('只有草稿可以丢弃；已生效或已替换的版本要保留作历史')
    if (row.source !== 'MANUAL' && row.source !== 'FILE_IMPORT') throw stateConflict('这是由采购收货或头程分摊生成的草稿，请到来源单据处理（头程运单可以撤销分摊）；这里不能丢弃')
    await this.prisma.$transaction(async tx => {
      const result = await tx.costVersion.deleteMany({ where: { id, tenantId, status: 'DRAFT', version: query.version } })
      if (result.count !== 1) throw appError('CONFLICT', '草稿刚刚被别人改过或处理过，请刷新后重试')
      await this.audit.record(
        req,
        {
          action: 'COST_VERSION_DISCARDED',
          resourceType: 'CostVersion',
          resourceId: id,
          before: {
            sku: row.sku,
            versionNo: row.versionNo,
            status: statusOf(row.status),
            effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
            currency: row.currency,
            unitProductCost: row.unitProductCost?.toString() ?? null,
            unitFirstMileCost: row.unitFirstMileCost?.toString() ?? null,
            unitDutyCost: row.unitDutyCost?.toString() ?? null,
            unitOtherCost: row.unitOtherCost?.toString() ?? null,
          },
        },
        { client: tx },
      )
    })
    return { id, version: query.version, versionNo: row.versionNo, status: 'DRAFT', message: `已丢弃第 ${row.versionNo} 版草稿` }
  }

  async activate(req: RequestWithContext, rawBody: unknown, now: Date = new Date()): Promise<CostActivateResult> {
    const access = await this.access.write(req)
    const body = CostActivateBodySchema.parse(rawBody)
    const { tenantId, context } = access
    const closed = await loadClosedPeriods(this.prisma, tenantId)
    const versions = await this.prisma.$transaction(async tx => {
      const done: CostActivateResult['versions'] = []
      for (const item of body.items) done.push(await activateOne({ req, audit: this.audit, tx, tenantId, userId: context.userId, closed, now }, item.id, item.version))
      return done
    })
    const replaced = versions.reduce((sum, item) => sum + item.replacedVersionNos.length, 0)
    return { activated: versions.length, replaced, versions, message: `已确认 ${versions.length} 个版本生效${replaced > 0 ? `，替换了 ${replaced} 个旧版本` : ''}；利润在下一次重算后按新成本计价` }
  }
}
