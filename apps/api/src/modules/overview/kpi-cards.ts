import type { DashState, KpiCard, KpiKey } from '@nova/api-contracts'
import { changeRatio, dailySeries, pointsChange, safeDivide, type DayValues } from './aggregate'

// 7 个指标卡的构造（纯函数，04 章 4.1 第 2 项）。
// 每张卡都带状态：没有数据的指标如实标注“尚未接入”“尚无记录”或“无权限”，不显示成 0。

export const NOTE_PROFIT = '净利润来自利润日表，利润计算在阶段 2b（P2b-09）交付，目前尚未接入'
export const NOTE_ADS = '广告数据同步在阶段 3 交付，目前尚未接入'
export const NOTE_STOCK = '可售天数风险数来自库存规则引擎（P2a-06），目前尚未接入'
export const NOTE_NO_SALES = '所选范围内没有订单记录（可能该时段没有销售，也可能还没同步，可对照下方数据源健康）'
export const NOTE_FORBIDDEN = '需要“利润”字段权限（财务相关角色）才能查看'
export const NOTE_PROFIT_MARGIN = '利润率 = 净利润 ÷ 销售额，需要净利润先接入'

export interface KpiInput {
  current: DayValues
  currentHasRows: boolean
  /** 没有对比期为 null */
  previous: DayValues | null
  previousHasRows: boolean
  daily: ReadonlyMap<string, DayValues>
  days: readonly string[]
  canSeeProfit: boolean
  anomalies: { critical: number; warning: number; info: number }
}

type Draft = Omit<KpiCard, 'key' | 'label' | 'format' | 'drill' | 'changeKind'> & { changeKind?: KpiCard['changeKind'] }

const card = (key: KpiKey, label: string, format: KpiCard['format'], drill: string, draft: Draft): KpiCard => ({ key, label, format, drill, changeKind: 'ratio', ...draft })
const absent = (state: DashState, note: string): Draft => ({ state, value: null, compareValue: null, change: null, trend: null, note })

export function buildKpiCards(input: KpiInput): KpiCard[] {
  const { current, previous, daily, days } = input
  const hasPrevious = previous !== null && input.previousHasRows

  // 销售额
  const sales: Draft = input.currentHasRows
    ? {
        state: 'OK',
        value: current.sales,
        compareValue: hasPrevious ? previous.sales : null,
        change: hasPrevious ? changeRatio(current.sales, previous.sales) : null,
        trend: dailySeries(days, daily, day => day.sales, 0),
        note: previous && !input.previousHasRows ? '对比期没有订单记录，无法计算变化' : null,
      }
    : absent('NO_DATA', NOTE_NO_SALES)

  // 净利润、利润率：需要字段权限，且利润日表接入后才有值
  const profitReady = input.canSeeProfit && current.profit !== null
  const profit: Draft = !input.canSeeProfit
    ? absent('RESTRICTED', NOTE_FORBIDDEN)
    : current.profit === null
      ? absent('NOT_CONNECTED', NOTE_PROFIT)
      : {
          state: 'OK',
          value: current.profit,
          compareValue: hasPrevious ? previous.profit : null,
          change: hasPrevious ? changeRatio(current.profit, previous.profit) : null,
          trend: dailySeries(days, daily, day => day.profit, null),
          note: null,
        }
  const marginOf = (values: DayValues) => safeDivide(values.profit, values.sales)
  const margin: Draft = !input.canSeeProfit
    ? absent('RESTRICTED', NOTE_FORBIDDEN)
    : !profitReady
      ? absent('NOT_CONNECTED', NOTE_PROFIT_MARGIN)
      : {
          state: 'OK',
          value: marginOf(current),
          compareValue: hasPrevious ? marginOf(previous) : null,
          change: hasPrevious ? pointsChange(marginOf(current), marginOf(previous)) : null,
          changeKind: 'points',
          trend: dailySeries(days, daily, day => safeDivide(day.profit, day.sales), null),
          note: marginOf(current) === null ? '销售额为 0，无法计算利润率' : null,
        }

  // 广告花费、广告占总销售比（M-008：广告花费 ÷ 销售额）
  const adsReady = current.adsSpend !== null
  const adsSpend: Draft = !adsReady
    ? absent('NOT_CONNECTED', NOTE_ADS)
    : {
        state: 'OK',
        value: current.adsSpend,
        compareValue: hasPrevious ? previous.adsSpend : null,
        change: hasPrevious ? changeRatio(current.adsSpend, previous.adsSpend) : null,
        trend: dailySeries(days, daily, day => day.adsSpend, null),
        note: null,
      }
  const shareOf = (values: DayValues) => safeDivide(values.adsSpend, values.sales)
  const adsShare: Draft = !adsReady
    ? absent('NOT_CONNECTED', NOTE_ADS)
    : {
        state: 'OK',
        value: shareOf(current),
        compareValue: hasPrevious ? shareOf(previous) : null,
        change: hasPrevious ? pointsChange(shareOf(current), shareOf(previous)) : null,
        changeKind: 'points',
        trend: dailySeries(days, daily, day => safeDivide(day.adsSpend, day.sales), null),
        note: shareOf(current) === null ? '销售额为 0，无法计算广告占总销售比' : null,
      }

  // 待处理异常数（M-010）：预警实例处于“新”“处理中”的数量，不是 0 就是真实的数
  const total = input.anomalies.critical + input.anomalies.warning + input.anomalies.info
  const anomalies: Draft = {
    state: 'OK',
    value: total,
    compareValue: null,
    change: null,
    trend: null,
    note: total === 0 ? '目前没有待处理的预警（预警规则与评估器随各数据域陆续上线）' : `严重 ${input.anomalies.critical} · 警告 ${input.anomalies.warning} · 提示 ${input.anomalies.info}`,
  }

  return [
    card('sales', '销售额', 'money', 'OrdersPage', sales),
    card('profit', '净利润', 'money', 'ProfitPage', profit),
    card('margin', '利润率', 'percent', 'ProfitPage', margin),
    card('adsSpend', '广告花费', 'money', 'AdsConsolePage', adsSpend),
    card('adsShare', '广告占总销售比', 'percent', 'AdsConsolePage', adsShare),
    card('stockRisk', '可售天数风险数', 'number', 'InventoryHealthPage', absent('NOT_CONNECTED', NOTE_STOCK)),
    card('anomalies', '待处理异常数', 'number', 'MyWorkItemsPage', anomalies),
  ]
}
