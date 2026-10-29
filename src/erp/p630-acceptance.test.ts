import { join } from 'node:path'
import { METRIC_DEFINITIONS } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { ERP, productionFiles, rel, sourceText } from './acceptance-scan.test-helper'

// 阶段 6 全站验收（P6-30）里能用源码锁定的条目。缺口与是否阻塞上线见
// docs/acceptance/p6-30-acceptance-report.md。这里不证明真实浏览器或真实店铺。

/** metrics.md 10.7 的核心指标。两项都非空才算覆盖。 */
const CORE_METRICS = [
  'M-005',
  'M-006',
  'M-007',
  'M-008',
  'M-009',
  'M-015',
  'M-020',
  'M-021',
  'M-022',
  'M-023',
  'M-200',
  'M-201',
  'M-202',
  'M-203',
  'M-204',
  'M-205',
  'M-206',
  'M-207',
  'M-208',
  'M-209',
  'M-210',
  'M-211',
  'M-213',
  'M-216',
  'M-219',
  'M-220',
  'M-230',
  'M-237',
  'M-401',
  'M-402',
  'M-420',
  'M-421',
  'M-422',
  'M-423',
  'M-424',
  'M-440',
  'M-450',
  'M-452',
  'M-500',
  'M-501',
  'M-502',
  'M-503',
  'M-504',
  'M-505',
  'M-506',
  'M-511',
  'M-512',
  'M-513',
  'M-520',
  'M-521',
]

const ADS_LEVEL_PAGES = ['AdsCampaignsPage.tsx', 'AdsAdGroupsPage.tsx', 'AdsTargetsPage.tsx', 'AdsSearchTermsPage.tsx', 'AdsProductsPage.tsx']

describe('P6-30 设计一致性', () => {
  it('SimpleTable 已删除，页面目录不再引用', () => {
    const pages = productionFiles(join(ERP, 'pages'))
    const hits = pages.filter(file => /\bSimpleTable\b/.test(sourceText(file))).map(rel)
    expect(hits).toEqual([])
  })

  it('src/erp 下不再有 antd Table：列表与详情页签、抽屉里的小表都用 SimpleGrid / LocalGrid / PagedGrid / MassiveGrid', () => {
    const found = productionFiles(ERP)
      .filter(file => /<Table(?:\s|<|>)/.test(sourceText(file)))
      .map(rel)
    expect(found).toEqual([])
  })

  it('广告五个层级页面都使用 AdsLevelGrid', () => {
    for (const name of ADS_LEVEL_PAGES) {
      expect(sourceText(join(ERP, 'pages', 'advertising', name)), name).toContain('AdsLevelGrid')
    }
  })
})

describe('P6-30 核心指标对账字段', () => {
  it('50 个核心指标都有对账页面和至少一条对不上的原因', () => {
    const byId = new Map(METRIC_DEFINITIONS.map(item => [item.id, item]))
    const missing = CORE_METRICS.filter(id => {
      const item = byId.get(id)
      return !item || item.reconcileWith.length === 0 || item.mismatchReasons.length === 0
    })
    expect(CORE_METRICS.length).toBe(50)
    expect(missing).toEqual([])
  })
})
