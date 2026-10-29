import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  DAYPARTING_CREATED_ACTION,
  DAYPARTING_UPDATED_ACTION,
  DAYPARTING_WRITE,
  DaypartingBodySchema,
  DaypartingUpdateBodySchema,
  describeGrid,
  gridIssue,
  isValidTimeZone,
  type DaypartingWriteResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { adsProfileWhere, adsRelationWhere, ContextService } from '../auth'
import { validZone } from '../overview'
import { gridOfRecord, kindOf, levelOf, resolveTargets, STRATEGY_ID_PATTERN, STRATEGY_SELECT, strategyRowFor, targetIdsOf, type StrategyRecord } from './ads-dayparting-common'

const LABEL = '分时策略'
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const json = (value: unknown) => value as Prisma.InputJsonValue
const dupName = () => appError('CONFLICT', '这个广告账户下已经有同名的分时策略，请换一个名称', { fieldErrors: { name: ['策略名称已存在'] } })

// 分时策略的创建与修改（P3-12，08 章 8.9）：只改本系统里的策略，不写亚马逊（调度执行随 P3-17）。
// 顺序：权限 → 参数（422）→ 广告账户或策略存在且在范围（404）→ 作用对象都在同一账户与范围内（404，整批）→ 取值合法（422）→ 事务内写入与审计（重名 409、版本冲突 409）。
@Injectable()
export class AdsDaypartingWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown, now: Date = new Date()): Promise<DaypartingWriteResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, DAYPARTING_WRITE, {})
    const body = DaypartingBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const profile = await this.prisma.adsProfile.findFirst({ where: { id: body.adsProfileId, tenantId, ...adsProfileWhere(scope) }, select: { id: true, timezone: true } })
    if (!profile) throw appError('RESOURCE_NOT_FOUND', '广告账户不存在或不在你的数据范围内')
    await resolveTargets(this.prisma, tenantId, scope, profile.id, body.level, body.targetIds)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    // 时区：请求里给的 > 广告账户自己的 > 企业时区
    const timezone = body.timezone ?? (profile.timezone && isValidTimeZone(profile.timezone) ? profile.timezone : validZone(tenant?.timezone))
    try {
      const created = await this.prisma.$transaction(async tx => {
        const row = await tx.daypartingStrategy.create({
          data: {
            tenantId,
            adsProfileId: profile.id,
            name: body.name,
            kind: body.kind,
            targetLevel: body.level,
            scopeJson: json({ ids: body.targetIds }),
            hourlyMultipliersJson: json(body.grid),
            baseBid: body.baseBid ?? null,
            timezone,
            status: body.status,
            createdBy: context.userId,
            updatedBy: context.userId,
          },
          select: STRATEGY_SELECT,
        })
        await this.audit.record(req, { action: DAYPARTING_CREATED_ACTION, resourceType: 'DaypartingStrategy', resourceId: row.id, after: this.snapshot(row) }, { client: tx })
        return row
      })
      return { strategy: await strategyRowFor(this.prisma, tenantId, created, now) }
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown, now: Date = new Date()): Promise<DaypartingWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, DAYPARTING_WRITE, {})
    const body = DaypartingUpdateBodySchema.parse(rawBody)
    if (!STRATEGY_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    const tenantId = context.tenantId
    const current = await this.prisma.daypartingStrategy.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: STRATEGY_SELECT })
    if (!current) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    const kind = kindOf(current.kind)

    const data: Prisma.DaypartingStrategyUncheckedUpdateManyInput = { updatedBy: context.userId }
    if (body.name !== undefined) data.name = body.name
    if (body.status !== undefined) data.status = body.status
    if (body.timezone !== undefined) data.timezone = body.timezone
    if (body.targetIds !== undefined) {
      await resolveTargets(this.prisma, tenantId, scope, current.adsProfileId, levelOf(current.targetLevel), body.targetIds)
      data.scopeJson = json({ ids: body.targetIds })
    }
    if (body.grid !== undefined) {
      const issue = gridIssue(kind, body.grid)
      if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { grid: [issue] } })
      data.hourlyMultipliersJson = json(body.grid)
    }
    if (body.baseBid !== undefined) {
      if (kind === 'ON_OFF' && body.baseBid !== null) throw appError('VALIDATION_FAILED', '启停策略不需要基准竞价', { fieldErrors: { baseBid: ['启停策略不需要基准竞价'] } })
      data.baseBid = body.baseBid
    }

    try {
      const next = await this.prisma.$transaction(async tx => {
        await updateWithVersion(tx.daypartingStrategy, { id, tenantId }, body.version, data as Record<string, unknown>, { label: LABEL })
        // 更新返回的是整行，这里再按页面要用的字段读一次（同事务，读到的就是刚写的）
        const row = await tx.daypartingStrategy.findFirstOrThrow({ where: { id, tenantId }, select: STRATEGY_SELECT })
        await this.audit.record(
          req,
          { action: DAYPARTING_UPDATED_ACTION, resourceType: 'DaypartingStrategy', resourceId: id, before: this.snapshot(current), after: this.snapshot(row) },
          { client: tx },
        )
        return row
      })
      return { strategy: await strategyRowFor(this.prisma, tenantId, next, now) }
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }

  /** 审计里记录的策略快照：不存 168 个数，只存摘要与对象个数（取值本身在策略表里随版本变化）。 */
  private snapshot(row: StrategyRecord) {
    return {
      name: row.name,
      status: row.status,
      kind: row.kind,
      level: row.targetLevel,
      timezone: row.timezone,
      baseBid: row.baseBid === null ? null : row.baseBid.toString(),
      targetCount: targetIdsOf(row.scopeJson).length,
      gridSummary: describeGrid(kindOf(row.kind), gridOfRecord(row.hourlyMultipliersJson)),
      version: row.version,
    }
  }
}
