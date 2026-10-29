import { describe, expect, it } from 'vitest'
import type { AdsHourlyCell } from './ads-campaigns-tabs'
import { DAYPARTING_EXECUTION_PENDING, DAYPARTING_GRID_SIZE, DAYPARTING_SIM_ASSUMPTIONS } from './dayparting'
import { daypartingDueOf, daypartingValueLabel, describeGrid, gridIndexOf, gridIssue, isValidTimeZone, neutralGrid, simulateGrid } from './dayparting-math'
import { DaypartingBodySchema, DaypartingUpdateBodySchema } from './dayparting-query'

const grid = (patch: Record<number, number> = {}): number[] => neutralGrid().map((value, index) => patch[index] ?? value)
const cell = (weekday: number, hour: number, patch: Partial<AdsHourlyCell> = {}): AdsHourlyCell => ({ weekday, hour, spend: 10, clicks: 10, orders: 2, sales: 40, samples: 2, ...patch })
const body = (patch: Record<string, unknown> = {}) => ({
  adsProfileId: 'prof_1',
  name: '工作日晚间加价',
  kind: 'BID_MULTIPLIER',
  level: 'CAMPAIGN',
  targetIds: ['c1'],
  grid: grid({ 20: 1.2 }),
  ...patch,
})

describe('分时策略：格子与取值校验', () => {
  it('一周 168 格，周一 0 点是 0、周日 23 点是 167', () => {
    expect(DAYPARTING_GRID_SIZE).toBe(168)
    expect(gridIndexOf(0, 0)).toBe(0)
    expect(gridIndexOf(6, 23)).toBe(167)
    expect(neutralGrid()).toHaveLength(168)
  })

  it('竞价系数：0.1 至 3、最多两位小数；全部是 1 不允许', () => {
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 1.5 }))).toBeNull()
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 3 }))).toBeNull()
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 0.1 }))).toBeNull()
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 3.01 }))).toContain('0.1 至 3')
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 0.05 }))).toContain('0.1 至 3')
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: 1.234 }))).toContain('两位小数')
    expect(gridIssue('BID_MULTIPLIER', neutralGrid())).toContain('不会改变任何东西')
    expect(gridIssue('BID_MULTIPLIER', grid({ 5: Number.NaN }))).toContain('不是数字')
  })

  it('启停：只能是 0 或 1，至少要有一个暂停的格子', () => {
    expect(gridIssue('ON_OFF', grid({ 0: 0, 1: 0 }))).toBeNull()
    expect(gridIssue('ON_OFF', grid({ 3: 0.5 }))).toContain('只能是 0')
    expect(gridIssue('ON_OFF', neutralGrid())).toContain('至少要有一个暂停')
  })

  it('长度不是 168 给出原因', () => {
    expect(gridIssue('ON_OFF', [0, 1])).toContain('168')
  })

  it('时区名：认识的标准名通过，乱写的不通过', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('分时策略：当前时段与摘要', () => {
  it('按策略自己的时区算此刻是周几几点（周一为 0）', () => {
    // 2026-10-19 是周一；UTC 08:30 在洛杉矶（PDT, UTC-7）是周一 01 点，在上海是周一 16 点
    const at = new Date('2026-10-19T08:30:00Z')
    const values = grid({ [gridIndexOf(0, 1)]: 1.5, [gridIndexOf(0, 16)]: 0.5 })
    expect(daypartingDueOf('BID_MULTIPLIER', values, 'America/Los_Angeles', at)).toMatchObject({ weekday: 0, hour: 1, value: 1.5, label: '竞价 ×1.50' })
    expect(daypartingDueOf('BID_MULTIPLIER', values, 'Asia/Shanghai', at)).toMatchObject({ weekday: 0, hour: 16, value: 0.5, label: '竞价 ×0.50' })
  })

  it('周日 23 点是最后一格；启停显示暂停与启用', () => {
    const at = new Date('2026-10-25T23:10:00Z')
    expect(daypartingDueOf('ON_OFF', grid({ 167: 0 }), 'UTC', at)).toMatchObject({ weekday: 6, hour: 23, value: 0, label: '暂停' })
    expect(daypartingValueLabel('ON_OFF', 1)).toBe('启用')
    expect(daypartingValueLabel('BID_MULTIPLIER', null)).toBe('无')
  })

  it('摘要：竞价系数数提高与降低，启停数暂停', () => {
    expect(describeGrid('BID_MULTIPLIER', grid({ 0: 1.2, 1: 1.3, 2: 0.8 }))).toBe('竞价系数：提高 2 格，降低 1 格，不变 165 格')
    expect(describeGrid('ON_OFF', grid({ 0: 0, 1: 0, 2: 0 }))).toBe('启停：暂停 3 个小时格，启用 165 个')
  })
})

describe('分时策略：效果模拟（模型估算）', () => {
  it('没有历史格子时不估算', () => {
    expect(simulateGrid([], 'ON_OFF', grid({ 0: 0 }))).toEqual({ coveredCells: 0, changedCells: 1, baseline: null, estimated: null })
  })

  it('启停：暂停的格子整格归零，其余不变', () => {
    const cells = [cell(0, 0), cell(0, 1)]
    const result = simulateGrid(cells, 'ON_OFF', grid({ [gridIndexOf(0, 0)]: 0 }))
    expect(result.coveredCells).toBe(2)
    expect(result.changedCells).toBe(1)
    expect(result.baseline).toMatchObject({ spend: 20, sales: 80, orders: 4, clicks: 20, acos: 0.25, cpc: 1 })
    expect(result.estimated).toMatchObject({ spend: 10, sales: 40, orders: 2, clicks: 10, acos: 0.25, cpc: 1 })
  })

  it('竞价系数：点击按 m 的 0.5 次方、单次点击成本按 m 变化，花费按 m 的 1.5 次方', () => {
    const result = simulateGrid([cell(1, 5, { spend: 100, clicks: 100, orders: 10, sales: 400 })], 'BID_MULTIPLIER', grid({ [gridIndexOf(1, 5)]: 4 }))
    // m = 4：点击与销售额 × 2，花费 × 8
    expect(result.estimated).toMatchObject({ spend: 800, sales: 800, clicks: 200, orders: 20, acos: 1, cpc: 4 })
    expect(result.baseline).toMatchObject({ spend: 100, acos: 0.25 })
  })

  it('花费或销售额来源没给的格子保持空，不当 0', () => {
    const result = simulateGrid([cell(0, 0, { spend: null, sales: null })], 'ON_OFF', grid({ 5: 0 }))
    expect(result.baseline).toMatchObject({ spend: null, sales: null, acos: null, cpc: null })
    expect(result.estimated).toMatchObject({ spend: null, sales: null })
  })

  it('历史里没有的格子不参与；格子没覆盖到的策略取值不影响合计', () => {
    const result = simulateGrid([cell(2, 3)], 'ON_OFF', grid({ [gridIndexOf(6, 23)]: 0 }))
    expect(result.estimated).toEqual(result.baseline)
    expect(result.changedCells).toBe(1)
  })

  it('模型假设原样给出（页面标“模型估算”）', () => {
    expect(DAYPARTING_SIM_ASSUMPTIONS[0]).toContain('模型估算')
    expect(DAYPARTING_EXECUTION_PENDING.state).toBe('CONNECTED')
    expect(DAYPARTING_EXECUTION_PENDING.note).toContain('分时策略执行')
  })
})

describe('分时策略：请求校验', () => {
  it('合法的创建请求通过，状态默认已暂停', () => {
    const parsed = DaypartingBodySchema.parse(body())
    expect(parsed.status).toBe('PAUSED')
    expect(parsed.targetIds).toEqual(['c1'])
  })

  it('取值不合法的原因落在 grid 字段上', () => {
    const result = DaypartingBodySchema.safeParse(body({ grid: neutralGrid() }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].path).toEqual(['grid'])
  })

  it('启停策略不能带基准竞价；竞价系数策略可以', () => {
    expect(DaypartingBodySchema.safeParse(body({ kind: 'ON_OFF', grid: grid({ 0: 0 }), baseBid: 1.5 })).success).toBe(false)
    expect(DaypartingBodySchema.safeParse(body({ baseBid: 1.5 })).success).toBe(true)
    expect(DaypartingBodySchema.safeParse(body({ baseBid: 0 })).success).toBe(false)
  })

  it('对象不能重复、不能为空、不能超过 200 个；时区要认识；未知字段拒绝', () => {
    expect(DaypartingBodySchema.safeParse(body({ targetIds: ['c1', 'c1'] })).success).toBe(false)
    expect(DaypartingBodySchema.safeParse(body({ targetIds: [] })).success).toBe(false)
    expect(DaypartingBodySchema.safeParse(body({ targetIds: Array.from({ length: 201 }, (_, index) => `c${index}`) })).success).toBe(false)
    expect(DaypartingBodySchema.safeParse(body({ timezone: 'Mars/Olympus' })).success).toBe(false)
    expect(DaypartingBodySchema.safeParse(body({ timezone: 'Asia/Shanghai' })).success).toBe(true)
    expect(DaypartingBodySchema.safeParse(body({ extra: 1 })).success).toBe(false)
  })

  it('修改必须带版本号并至少改一项；档案与类型不能改', () => {
    expect(DaypartingUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(DaypartingUpdateBodySchema.safeParse({ name: '新名称' }).success).toBe(false)
    expect(DaypartingUpdateBodySchema.safeParse({ version: 2, status: 'ACTIVE' }).success).toBe(true)
    expect(DaypartingUpdateBodySchema.safeParse({ version: 2, kind: 'ON_OFF' }).success).toBe(false)
    expect(DaypartingUpdateBodySchema.safeParse({ version: 2, adsProfileId: 'x' }).success).toBe(false)
    expect(DaypartingUpdateBodySchema.safeParse({ version: 2, grid: [1, 2] }).success).toBe(false)
  })
})
