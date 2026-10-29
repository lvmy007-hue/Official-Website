import { ADS_CHANGE_CREATED, changeStateOf } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import type { EntityRow } from './entities'
import { hashOfState, planPage, prunable, type ScanInput, type SnapshotRow } from './scan'

// 快照对比的纯计划部分（P3-14）：基线、新出现、外部变更、排除本系统自己的写入、快照清理。读库与写库的真实行为见 apps/api/src/testing/ads-changes.db.test.ts。

const HOUR = 3_600_000
const NOW = new Date('2026-10-24T08:00:00.000Z')
const input = (patch: Partial<ScanInput> = {}): ScanInput => ({ tenantId: 't1', adsProfileId: 'ap-1', entityType: 'TARGET', now: NOW, ...patch })
const target = (patch: Record<string, unknown> = {}, created = '2026-10-01T00:00:00.000Z', id = 'tg-1'): EntityRow => ({
  id,
  label: 'yoga mat',
  createdAt: new Date(created),
  values: { expression: 'yoga mat', matchType: 'EXACT', bid: '1.200000', state: 'ENABLED', ...patch },
})
const snapshotOf = (row: EntityRow, at: string, index = 1): SnapshotRow => {
  const state = changeStateOf('TARGET', row.values)
  return { id: `snap-${row.id}-${index}`, entityId: row.id, snapshotAt: new Date(at), hash: hashOfState(state), stateJson: state }
}
const grouped = (...rows: SnapshotRow[]) => {
  const map = new Map<string, SnapshotRow[]>()
  for (const row of rows) map.set(row.entityId, [...(map.get(row.entityId) ?? []), row])
  return map
}
const noBaseline = { graceEnd: null }

describe('快照对比：第一次是基线', () => {
  it('没有任何快照时只存快照，不记任何变更（包括“新出现”）', () => {
    const plan = planPage(input(), [target(), target({}, '2026-10-02T00:00:00.000Z', 'tg-2')], new Map(), [], noBaseline)
    expect(plan.snapshots).toHaveLength(2)
    expect(plan.changes).toEqual([])
    expect(plan.created).toBe(0)
    expect(plan.snapshots[0]).toMatchObject({ entityId: 'tg-1', snapshotAt: NOW, entityType: 'TARGET', adsProfileId: 'ap-1' })
  })

  it('哈希没变的对象什么都不做', () => {
    const row = target()
    const plan = planPage(input(), [row], grouped(snapshotOf(row, '2026-10-24T07:30:00.000Z')), [], { graceEnd: new Date('2026-10-20T00:00:00.000Z') })
    expect(plan.snapshots).toEqual([])
    expect(plan.changes).toEqual([])
  })

  it('规整后相同（竞价 1.2 与 1.200000、状态大小写）不算变化', () => {
    const before = target()
    const plan = planPage(input(), [target({ bid: 1.2, state: 'enabled' })], grouped(snapshotOf(before, '2026-10-24T07:30:00.000Z')), [], noBaseline)
    expect(plan.snapshots).toEqual([])
    expect(plan.changes).toEqual([])
  })
})

describe('快照对比：新出现的对象', () => {
  const graceEnd = new Date('2026-10-21T00:00:00.000Z')

  it('基线之后（过了初始同步宽限期）才进入本系统的对象记“新出现”，名称放在改后', () => {
    const plan = planPage(input(), [target({}, '2026-10-22T00:00:00.000Z', 'tg-new')], new Map(), [], { graceEnd })
    expect(plan.created).toBe(1)
    expect(plan.changes).toEqual([expect.objectContaining({ entityId: 'tg-new', changedField: ADS_CHANGE_CREATED, beforeValue: null, afterValue: 'yoga mat', actorKind: 'EXTERNAL', occurredAt: NOW })])
    expect(plan.snapshots).toHaveLength(1)
  })

  it('宽限期内进入的对象（同步器分批入库）算基线：存快照但不记变更', () => {
    const plan = planPage(input(), [target({}, '2026-10-20T10:00:00.000Z', 'tg-batch')], new Map(), [], { graceEnd })
    expect(plan.created).toBe(0)
    expect(plan.changes).toEqual([])
    expect(plan.snapshots).toHaveLength(1)
  })
})

describe('快照对比：外部变更', () => {
  const before = target()
  const previous = snapshotOf(before, '2026-10-24T07:30:00.000Z')

  it('每个改动的字段一条：改前、改后（规整后的文字）、发生区间 [上一份快照, 检测时间]', () => {
    const plan = planPage(input(), [target({ bid: '1.500000', state: 'PAUSED' })], grouped(previous), [], noBaseline)
    expect(plan.snapshots).toHaveLength(1)
    expect(plan.changes.map(change => [change.changedField, change.beforeValue, change.afterValue])).toEqual([
      ['bid', '1.2', '1.5'],
      ['state', 'ENABLED', 'PAUSED'],
    ])
    for (const change of plan.changes) {
      expect(change).toMatchObject({ actorKind: 'EXTERNAL', occurredAt: NOW, sinceAt: previous.snapshotAt, entityLabel: 'yoga mat' })
      expect(change.actorId).toBeUndefined()
    }
  })

  it('清空一个字段（有变无）也记，改后是 null；新的快照存的是规整后的状态', () => {
    const plan = planPage(input(), [target({ matchType: null })], grouped(previous), [], noBaseline)
    expect(plan.changes).toEqual([expect.objectContaining({ changedField: 'matchType', beforeValue: 'EXACT', afterValue: null })])
    expect(plan.snapshots[0]!.stateJson).toMatchObject({ matchType: null, bid: '1.2' })
  })

  it('本系统最近写入的同对象同字段同值，不记外部变更，但快照照样更新；别的字段仍然记', () => {
    const plan = planPage(input(), [target({ bid: '1.5', state: 'PAUSED' })], grouped(previous), [{ entityId: 'tg-1', field: 'bid', after: '1.50' }], noBaseline)
    expect(plan.own).toBe(1)
    expect(plan.changes.map(change => change.changedField)).toEqual(['state'])
    expect(plan.snapshots).toHaveLength(1)
  })

  it('本系统写的是另一个值，或写的是另一个对象，都不能排除', () => {
    const rows = [target({ bid: '1.5' })]
    expect(planPage(input(), rows, grouped(previous), [{ entityId: 'tg-1', field: 'bid', after: '1.6' }], noBaseline).changes).toHaveLength(1)
    expect(planPage(input(), rows, grouped(previous), [{ entityId: 'tg-2', field: 'bid', after: '1.5' }], noBaseline).changes).toHaveLength(1)
  })

  it('上一份快照比“现在”还新（时钟倒退）时，发生区间的起点夹到现在，不违反“起点不晚于检测时间”', () => {
    const future = snapshotOf(before, '2026-10-24T09:00:00.000Z')
    const plan = planPage(input(), [target({ bid: '2' })], grouped(future), [], noBaseline)
    expect(plan.changes[0]!.sinceAt).toEqual(NOW)
  })

  it('一页里多个对象各算各的', () => {
    const second = target({}, '2026-10-01T00:00:00.000Z', 'tg-2')
    const plan = planPage(input(), [target({ bid: '3' }), second], grouped(previous, snapshotOf(second, '2026-10-24T07:30:00.000Z')), [], noBaseline)
    expect(plan.changes.map(change => change.entityId)).toEqual(['tg-1'])
  })
})

describe('快照清理', () => {
  const row = target()
  const at = (hours: number, index: number) => snapshotOf(row, new Date(NOW.getTime() - hours * HOUR).toISOString(), index)

  it('最新一份总是保留，哪怕它早于 180 天', () => {
    expect(prunable([at(24 * 200, 1)], false, NOW)).toEqual([])
  })

  it('被新快照取代、又早于 180 天的旧快照清理，较新的保留', () => {
    const list = [at(2, 1), at(24 * 10, 2), at(24 * 200, 3)]
    expect(prunable(list, true, NOW)).toEqual(['snap-tg-1-3'])
    expect(prunable(list, false, NOW)).toEqual(['snap-tg-1-3'])
  })

  it('超过每个对象 30 份的最旧几份清理（新增一份时要给它留位置）', () => {
    const list = Array.from({ length: 31 }, (_, index) => at(index + 1, index + 1))
    expect(prunable(list.slice(0, 30), false, NOW)).toEqual([])
    expect(prunable(list, false, NOW)).toEqual(['snap-tg-1-31'])
    expect(prunable(list.slice(0, 30), true, NOW)).toEqual(['snap-tg-1-30'])
    expect(prunable(list, true, NOW)).toEqual(['snap-tg-1-30', 'snap-tg-1-31'])
  })

  it('变更时一并规划清理：旧快照在计划里带出', () => {
    const old = at(24 * 200, 2)
    const plan = planPage(input(), [target({ bid: '9' })], grouped(at(1, 1), old), [], noBaseline)
    expect(plan.prune).toEqual([old.id])
  })
})
