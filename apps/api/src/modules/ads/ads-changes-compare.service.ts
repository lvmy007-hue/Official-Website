import { Injectable } from '@nestjs/common'
import {
  ADS_CHANGE_CREATED,
  ADS_CHANGE_LIMITS,
  ADS_READ,
  changeFieldsOf,
  changeStateFromJson,
  changeValueText,
  type AdsChangeCompareField,
  type AdsChangeCompareResponse,
  type AdsChangeEntityType,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService } from '../auth'
import { CHANGE_ID_PATTERN, CHANGE_SELECT, changeEntityTypeOf, changeRowOf } from './ads-changes-common'

const NOTE_SNAPSHOT = '对照取自该对象在变更时刻或之前的最近一份实体快照；没有被改动的字段显示快照里的值'
const NOTE_CHANGE_ONLY = '没有该对象在变更时刻的实体快照，只列出被改动的字段（没改动的字段无从对照）'

// 一条变更的前后对照（P3-14，08 章 8.11“可一键打开前后对照”）：同一对象、同一时刻、同一来源的这一批改动的“改前 → 改后”，
// 有实体快照时把没改的字段也列出来（显示快照里的值），再附同一对象前后的其他变更。范围外与不存在都是 404，不泄露存在性。
@Injectable()
export class AdsChangeCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async compare(req: RequestWithContext, id: string): Promise<AdsChangeCompareResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    if (!CHANGE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '变更记录不存在')
    const tenantId = context.tenantId
    const record = await this.prisma.adsChangeLog.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: CHANGE_SELECT })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '变更记录不存在')
    const entity = { tenantId, adsProfileId: record.adsProfileId, entityType: record.entityType, entityId: record.entityId }
    const entityType = changeEntityTypeOf(record.entityType)
    const [batch, snapshot, related] = await Promise.all([
      this.prisma.adsChangeLog.findMany({
        where: { ...entity, occurredAt: record.occurredAt, actorKind: record.actorKind },
        select: { changedField: true, beforeValue: true, afterValue: true },
        orderBy: [{ changedField: 'asc' }],
        take: ADS_CHANGE_LIMITS.compareFieldMax,
      }),
      this.prisma.adsEntitySnapshot.findFirst({
        where: { ...entity, snapshotAt: { lte: record.occurredAt } },
        select: { snapshotAt: true, stateJson: true },
        orderBy: [{ snapshotAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.adsChangeLog.findMany({
        where: { ...entity, NOT: { occurredAt: record.occurredAt, actorKind: record.actorKind } },
        select: CHANGE_SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        take: ADS_CHANGE_LIMITS.compareRelatedMax,
      }),
    ])
    const people = await memberNames(
      this.prisma,
      tenantId,
      [record, ...related].map(row => row.actorId),
    )
    const state = snapshot ? changeStateFromJson(entityType, snapshot.stateJson) : null
    const changed = new Map(batch.map(row => [row.changedField, row]))
    const created = changed.has(ADS_CHANGE_CREATED)
    const fields = created ? createdFields(entityType, state, record.afterValue) : state ? snapshotFields(entityType, state, changed) : changedFields(entityType, changed)
    return {
      change: changeRowOf(record, people),
      basis: state ? 'SNAPSHOT' : 'CHANGE_ONLY',
      basisNote: state ? NOTE_SNAPSHOT : NOTE_CHANGE_ONLY,
      fields,
      related: related.map(row => changeRowOf(row, people)),
    }
  }
}

type Changed = ReadonlyMap<string, { changedField: string; beforeValue: string | null; afterValue: string | null }>

const field = (entityType: AdsChangeEntityType, key: string, label: string, before: string | null, after: string | null, changed: boolean): AdsChangeCompareField => ({
  key,
  label,
  before: changeValueText(entityType, key, before),
  after: changeValueText(entityType, key, after),
  changed,
})

/** 有快照：每个追踪字段一行，被改的用变更记录的改前改后，没改的用快照里的值。 */
function snapshotFields(entityType: AdsChangeEntityType, state: Record<string, string | null>, changed: Changed): AdsChangeCompareField[] {
  return changeFieldsOf(entityType).map(info => {
    const row = changed.get(info.key)
    return row ? field(entityType, info.key, info.label, row.beforeValue, row.afterValue, true) : field(entityType, info.key, info.label, state[info.key] ?? null, state[info.key] ?? null, false)
  })
}

/** 没有快照：只列被改的字段。 */
function changedFields(entityType: AdsChangeEntityType, changed: Changed): AdsChangeCompareField[] {
  const known = changeFieldsOf(entityType)
  return [...changed.values()].map(row => {
    const info = known.find(item => item.key === row.changedField)
    return field(entityType, row.changedField, info?.label ?? row.changedField, row.beforeValue, row.afterValue, true)
  })
}

/** 新出现的对象：改前没有，改后是快照里的各字段值（没有快照只给名称）。 */
function createdFields(entityType: AdsChangeEntityType, state: Record<string, string | null> | null, label: string | null): AdsChangeCompareField[] {
  if (!state) return [{ key: ADS_CHANGE_CREATED, label: '名称', before: null, after: label, changed: true }]
  return changeFieldsOf(entityType).map(info => field(entityType, info.key, info.label, null, state[info.key] ?? null, state[info.key] !== null && state[info.key] !== undefined))
}
