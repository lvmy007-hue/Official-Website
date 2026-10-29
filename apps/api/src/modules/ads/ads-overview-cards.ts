import { ADS_CARD_KEYS, ADS_CARD_LABEL, adsRatios, pointChange, ratioChange, type AdsCard, type AdsCardKey, type AdsRatios, type AdsTotals, type DashState } from '@nova/api-contracts'
import type { StoreDay } from './ads-overview-load'

// 广告控制台的 12 张指标卡（纯函数）。状态规则：
//   NOT_CONNECTED  可见范围内从来没有任何广告日汇总（或该来源同步器未交付）；
//   NO_DATA        已接入但所选范围没有记录；
//   OK             有数据；值为空（例如没有广告销售额时的 ACoS）仍是 OK，值写“—”并说明为什么无法计算。
// 空 = 来源没给，永远不是 0。

export const NOTE_NEVER = '可见范围内还没有任何广告汇总记录；连接广告账户并同步广告报告后才会出现数据'
export const NOTE_EMPTY_RANGE = '所选日期范围内没有广告汇总记录'
export const NOTE_NO_STORE_ROWS = '所选范围内没有店铺经营汇总（订单尚未同步）'
export const NOTE_STORE_ADS_EMPTY = '已绑定店铺的广告花费尚无记录；广告账户绑定到店铺后才会计入'
export const NOTE_HALO = '光环销售额来自广告归因报告里的品牌光环字段，该同步器尚未接入'

export interface CardInput {
  everHadData: boolean
  hasRows: boolean
  current: AdsTotals
  previous: AdsTotals | null
  previousHasRows: boolean
  days: readonly string[]
  /** 逐日合计（没有行的日子不在里面） */
  daily: ReadonlyMap<string, AdsTotals>
  store: { hasRows: boolean; current: StoreDay; previous: StoreDay | null; previousHasRows: boolean; daily: ReadonlyMap<string, StoreDay> }
  budget: { state: DashState; note: string | null; utilization: number | null }
  anomalyCount: number
  anomalyState: DashState
  anomalyNote: string | null
  unboundSpend: number | null
}

type RatioKey = keyof AdsRatios
const FORMAT: Record<AdsCardKey, AdsCard['format']> = {
  spend: 'money',
  sales: 'money',
  acos: 'percent',
  adsShare: 'percent',
  roas: 'number',
  ctr: 'percent',
  cpc: 'money',
  cvr: 'percent',
  budgetUtilization: 'percent',
  anomalies: 'number',
  organicSales: 'money',
  haloSales: 'money',
}
const KIND: Record<AdsCardKey, AdsCard['changeKind']> = {
  spend: 'ratio',
  sales: 'ratio',
  acos: 'points',
  adsShare: 'points',
  roas: 'ratio',
  ctr: 'points',
  cpc: 'ratio',
  cvr: 'points',
  budgetUtilization: 'points',
  anomalies: 'ratio',
  organicSales: 'ratio',
  haloSales: 'ratio',
}

const NO_VALUE_NOTE: Partial<Record<AdsCardKey, string>> = {
  spend: '来源没有给出花费',
  sales: '来源没有给出广告销售额',
  acos: '没有广告销售额，ACoS 无法计算',
  roas: '没有花费，投入产出比无法计算',
  ctr: '没有曝光，点击率无法计算',
  cpc: '没有点击，单次点击成本无法计算',
  cvr: '没有点击，转化率无法计算',
}

function card(key: AdsCardKey, fields: Pick<AdsCard, 'state' | 'value' | 'compareValue' | 'trend' | 'note'>): AdsCard {
  const change = fields.state !== 'OK' ? null : KIND[key] === 'points' ? pointChange(fields.value, fields.compareValue) : ratioChange(fields.value, fields.compareValue)
  return { key, label: ADS_CARD_LABEL[key], format: FORMAT[key], changeKind: KIND[key], change, ...fields }
}

const empty = (key: AdsCardKey, state: DashState, note: string | null): AdsCard => card(key, { state, value: null, compareValue: null, trend: null, note })

export function buildAdsCards(input: CardInput): AdsCard[] {
  const adsState: DashState = !input.everHadData ? 'NOT_CONNECTED' : !input.hasRows ? 'NO_DATA' : 'OK'
  const adsNote = adsState === 'NOT_CONNECTED' ? NOTE_NEVER : adsState === 'NO_DATA' ? NOTE_EMPTY_RANGE : null
  const nowRatios = adsRatios(input.current)
  const before = input.previous && input.previousHasRows ? input.previous : null
  const beforeRatios = before ? adsRatios(before) : null

  const fromAds = (key: AdsCardKey, pick: (totals: AdsTotals) => number | null, pickRatio?: RatioKey): AdsCard => {
    if (adsState !== 'OK') return empty(key, adsState, adsNote)
    const value = pickRatio ? nowRatios[pickRatio] : pick(input.current)
    const compareValue = beforeRatios && pickRatio ? beforeRatios[pickRatio] : before ? pick(before) : null
    const trend = input.days.map(date => {
      const day = input.daily.get(date)
      return day ? (pickRatio ? adsRatios(day)[pickRatio] : pick(day)) : null
    })
    return card(key, { state: 'OK', value, compareValue, trend, note: value === null ? (NO_VALUE_NOTE[key] ?? null) : null })
  }

  const store = input.store
  const storeCard = (key: 'adsShare' | 'organicSales'): AdsCard => {
    if (!store.hasRows) return empty(key, 'NO_DATA', NOTE_NO_STORE_ROWS)
    const valueOf = (day: StoreDay): number | null => {
      if (key === 'adsShare') return day.adsSpend !== null && day.sales > 0 ? day.adsSpend / day.sales : null
      return day.adsSales !== null && day.sales >= day.adsSales ? day.sales - day.adsSales : null
    }
    const value = valueOf(store.current)
    if (store.current.adsSpend === null && key === 'adsShare') return empty(key, 'NO_DATA', NOTE_STORE_ADS_EMPTY)
    if (store.current.adsSales === null && key === 'organicSales') return empty(key, 'NO_DATA', NOTE_STORE_ADS_EMPTY)
    const compareValue = store.previous && store.previousHasRows ? valueOf(store.previous) : null
    const trend = input.days.map(date => {
      const day = store.daily.get(date)
      return day ? valueOf(day) : null
    })
    const note =
      value !== null
        ? null
        : key === 'organicSales' && store.current.adsSales !== null && store.current.sales < store.current.adsSales
          ? '广告归因销售额大于店铺销售额（归因窗口与下单日口径不同），自然销售额无法推算'
          : '店铺总销售额为 0，无法计算'
    return card(key, { state: 'OK', value, compareValue, trend, note })
  }

  const budget = input.budget
  const spend = fromAds('spend', totals => totals.spend)
  const cards: Record<AdsCardKey, AdsCard> = {
    spend:
      input.unboundSpend !== null && input.unboundSpend > 0 && spend.state === 'OK'
        ? { ...spend, note: `含未绑定店铺的广告花费 ${input.unboundSpend.toFixed(2)} 美元（不计入广告占总销售比）` }
        : spend,
    sales: fromAds('sales', totals => totals.sales),
    acos: fromAds('acos', () => null, 'acos'),
    adsShare: storeCard('adsShare'),
    roas: fromAds('roas', () => null, 'roas'),
    ctr: fromAds('ctr', () => null, 'ctr'),
    cpc: fromAds('cpc', () => null, 'cpc'),
    cvr: fromAds('cvr', () => null, 'cvr'),
    budgetUtilization:
      budget.state === 'OK'
        ? card('budgetUtilization', { state: 'OK', value: budget.utilization, compareValue: null, trend: null, note: budget.note })
        : empty('budgetUtilization', budget.state, budget.note),
    anomalies:
      input.anomalyState === 'OK'
        ? card('anomalies', { state: 'OK', value: input.anomalyCount, compareValue: null, trend: null, note: input.anomalyNote })
        : empty('anomalies', input.anomalyState, input.anomalyNote),
    organicSales: storeCard('organicSales'),
    haloSales: empty('haloSales', 'NOT_CONNECTED', NOTE_HALO),
  }
  return ADS_CARD_KEYS.map(key => cards[key])
}
