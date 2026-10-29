import {
  DAYPARTING_EXECUTION_PENDING,
  DAYPARTING_SIM_ASSUMPTIONS,
  DAYPARTING_SIM_MODEL,
  daypartingDueOf,
  describeGrid,
  type DaypartingListResponse,
  type DaypartingRunRow,
  type DaypartingSimulateResponse,
  type DaypartingStrategyRow,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 分时策略页测试用的假服务端数据（只在测试里使用）。

/** 周一 0 至 5 点暂停，其余启用。 */
export const offGrid = (): number[] => Array.from({ length: 168 }, (_, index) => (index < 6 ? 0 : 1))
/** 周一 0 点 ×0.5，周一 1 点 ×1.5，其余 ×1。 */
export const bidGrid = (): number[] => Array.from({ length: 168 }, (_, index) => (index === 0 ? 0.5 : index === 1 ? 1.5 : 1))

const NOW = new Date('2026-10-23T10:30:00Z') // 周五 10 点（UTC）

export const strategyRow = (patch: Partial<DaypartingStrategyRow> = {}): DaypartingStrategyRow => {
  const kind = patch.kind ?? 'ON_OFF'
  const grid = patch.grid ?? (kind === 'ON_OFF' ? offGrid() : bidGrid())
  return {
    id: 'st-1',
    adsProfileId: 'ap-a',
    accountName: '美国账户',
    storeName: 'Northstar US',
    name: '夜间关停',
    kind,
    level: 'CAMPAIGN',
    status: 'ACTIVE',
    timezone: 'UTC',
    baseBid: null,
    targets: [
      { id: 'cam-1', name: '春季推广' },
      { id: 'cam-2', name: '夏季推广' },
    ],
    grid,
    summary: describeGrid(kind, grid),
    due: daypartingDueOf(kind, grid, 'UTC', NOW),
    version: 3,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    updatedByName: '林然',
    ...patch,
  }
}

export const runRow = (patch: Partial<DaypartingRunRow> = {}): DaypartingRunRow => ({
  id: 'run-1',
  strategyId: 'st-1',
  strategyName: '夜间关停',
  entityId: 'cam-1',
  entityName: '春季推广',
  hour: 3,
  appliedMultiplier: 0,
  executed: false,
  outcome: 'SKIPPED',
  message: '写入未接入',
  runAt: '2026-10-22T03:00:00.000Z',
  ...patch,
})

export const listResponse = (patch: Partial<DaypartingListResponse> = {}): DaypartingListResponse => ({
  streamConnected: true,
  heatmap: {
    state: 'OK',
    note: null,
    zone: 'UTC',
    historyDays: 14,
    cells: [
      { weekday: 0, hour: 9, spend: 12, clicks: 30, orders: 3, sales: 60, samples: 2 },
      { weekday: 4, hour: 21, spend: 40, clicks: 80, orders: 1, sales: 50, samples: 2 },
    ],
  },
  strategies: {
    state: 'OK',
    note: null,
    items: [strategyRow(), strategyRow({ id: 'st-2', name: '广告组倍率', kind: 'BID_MULTIPLIER', level: 'AD_GROUP', baseBid: 1.2, status: 'PAUSED', targets: [{ id: 'ag-1', name: '核心词组' }] })],
    truncated: false,
  },
  runs: { state: 'NO_DATA', note: '尚无记录：已启用的策略每小时执行一次，执行（包括跳过与失败）之后在这里显示', items: [] },
  profiles: [{ id: 'ap-a', name: '美国账户', storeName: 'Northstar US', timezone: 'America/Los_Angeles' }],
  canWrite: true,
  execution: DAYPARTING_EXECUTION_PENDING,
  assumptions: DAYPARTING_SIM_ASSUMPTIONS,
  ...patch,
})

export const simulateResponse = (patch: Partial<DaypartingSimulateResponse> = {}): DaypartingSimulateResponse => ({
  state: 'OK',
  note: null,
  strategyId: 'st-1',
  historyDays: 14,
  coveredCells: 2,
  changedCells: 6,
  baseline: { clicks: 110, spend: 52, sales: 110, orders: 4, acos: 52 / 110, cpc: 52 / 110 },
  estimated: { clicks: 80, spend: 40, sales: 50, orders: 1, acos: 0.8, cpc: 0.5 },
  model: DAYPARTING_SIM_MODEL,
  assumptions: DAYPARTING_SIM_ASSUMPTIONS,
  ...patch,
})

export const campaignRows = () => ({
  items: [
    { id: 'cam-1', adsProfileId: 'ap-a', name: '春季推广' },
    { id: 'cam-2', adsProfileId: 'ap-a', name: '夏季推广' },
    { id: 'cam-x', adsProfileId: 'ap-other', name: '别的账户的活动' },
  ],
})

export const listHandlers = (response: () => DaypartingListResponse = () => listResponse(), extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/ads/dayparting': () => ok(response()),
  '/ads/campaigns': () => ok(campaignRows()),
  ...extra,
})
