import {
  AD_TERM_HISTORY_LIMIT,
  AD_TERM_HISTORY_TARGETS,
  ADS_BID_EFFECT_DAYS,
  ADS_CONSOLE_CURRENCY,
  ADS_TARGET_BID_EVENT_KIND,
  ADS_TARGET_ENTITY_TYPE,
  ADS_TARGET_WRITE_NOTE,
  bidChangeOf,
  bidEffectWindows,
  type AdTermDetailResponse,
  type AdTermHistoryRow,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { addDays, localDate } from '../overview'
import { entityDaily } from './ads-campaigns-load'
import { changeRows, loadEntityEvents, type RawChange } from './ads-entity-changes'
import { TARGET_METRIC_TYPES } from './ads-groups-common'
import type { AdsLoadContext } from './ads-overview-load'
import type { TermEntity } from './ad-terms-entities'

// 词级分析页的“历史动作与效果”（P3-10）：这个词对应的投放对象（关键词、投放表达式）在本系统内的调价记录，每次带调价前后各 7 天的指标对照。
// 调价是写亚马逊的动作，随“广告写入接入”（P3-17）；在那之前没有写入方，这里多半为空。亚马逊侧的调价没有同步器，不会出现在这里。

const NOTE_NO_TARGET = '这个词在可见范围内没有对应的关键词或投放对象，所以没有调价记录'
const NOTE_EMPTY = `本系统内还没有对这个词的投放对象调过价（${ADS_TARGET_WRITE_NOTE}；上线后每次调价都会记在这里，并给出调价前后各 ${ADS_BID_EFFECT_DAYS} 天的指标对照；亚马逊侧的调价没有同步器，不在其内）`

export async function termHistory(prisma: PrismaService, ctx: AdsLoadContext, zone: string, entities: readonly TermEntity[]): Promise<AdTermDetailResponse['history']> {
  const targets = entities.filter(entity => entity.kind !== 'NEGATIVE').slice(0, AD_TERM_HISTORY_TARGETS)
  if (targets.length === 0) return { state: 'NO_DATA', note: NOTE_NO_TARGET, items: [], truncated: false }
  const loaded = await Promise.all(
    targets.map(async entity => ({ entity, ...(await loadEntityEvents(prisma, ctx.tenantId, ADS_TARGET_ENTITY_TYPE, entity.id, ADS_TARGET_BID_EVENT_KIND, AD_TERM_HISTORY_LIMIT)) })),
  )
  const events = loaded.flatMap(item => item.events.map(event => ({ event, entity: item.entity })))
  events.sort((a, b) => b.event.occurredAt.getTime() - a.event.occurredAt.getTime() || (a.event.id < b.event.id ? -1 : 1))
  const kept = events.slice(0, AD_TERM_HISTORY_LIMIT)
  const truncated = events.length > AD_TERM_HISTORY_LIMIT || loaded.some(item => item.truncated)
  if (kept.length === 0) return { state: 'NO_DATA', note: NOTE_EMPTY, items: [], truncated: false }

  const described = await changeRows(
    prisma,
    ctx.tenantId,
    kept.map(item => item.event as RawChange),
    { [ADS_TARGET_BID_EVENT_KIND]: '调价' },
  )
  // 每个投放对象各取一次逐日指标，覆盖它所有调价日前后各 7 天
  const dailyOf = new Map<string, Awaited<ReturnType<typeof entityDaily>>>()
  for (const entity of targets) {
    const dates = kept
      .filter(item => item.entity.id === entity.id)
      .map(item => localDate(item.event.occurredAt, zone))
      .sort()
    if (dates.length === 0 || !entity.targetId) continue
    dailyOf.set(
      entity.id,
      await entityDaily(prisma, ctx, {
        ref: { adsProfileId: entity.adsProfileId, currency: ADS_CONSOLE_CURRENCY, adProduct: null },
        entityTypes: TARGET_METRIC_TYPES,
        entityId: entity.targetId,
        from: addDays(dates[0]!, -ADS_BID_EFFECT_DAYS),
        to: addDays(dates[dates.length - 1]!, ADS_BID_EFFECT_DAYS),
      }),
    )
  }
  const items = kept.map((item, index): AdTermHistoryRow => {
    const change = bidChangeOf(item.event.detailJson)
    const windows = bidEffectWindows(dailyOf.get(item.entity.id) ?? new Map(), localDate(item.event.occurredAt, zone), ADS_BID_EFFECT_DAYS)
    const row = described[index]!
    return {
      id: item.event.id,
      at: row.occurredAt,
      actor: row.actor,
      source: row.source,
      beforeBid: change?.before.bid ?? null,
      afterBid: change?.after.bid ?? null,
      title: row.title,
      expression: item.entity.expression,
      ...windows,
    }
  })
  return { state: 'OK', note: null, items, truncated }
}
