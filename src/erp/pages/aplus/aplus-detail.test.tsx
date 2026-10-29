import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { APLUS_ADVICE_BASIS, APLUS_COMPARE_BASIS, APLUS_PREVIEW_NOTE, type AplusCompare, type AplusDetailResponse } from '@nova/api-contracts'
import { mountApp, type Handler } from '../../test/app-harness'
import { aplusHandlers, aplusPages, compareOf, compareOk, detailResponse, lastParams, publishedDetail, readonlyDetail, rejectedDetail } from './aplus-fixtures.test-helper'

// A+ 内容详情（P4-14）：头部、被拒区块与修复建议、模块预览（占位框与预览说明）、不可编辑只读、关联 ASIN、审核时间线、发布前后对照各状态。

afterEach(() => vi.unstubAllGlobals())

const openDetail = async (response: () => AplusDetailResponse = () => detailResponse(), extra: Record<string, Handler> = {}) => {
  const app = mountApp({ url: '/app/aplus/c1', pages: aplusPages, handlers: aplusHandlers({ detail: response }, extra) })
  const page = within(await screen.findByTestId('aplus-detail-page', {}, { timeout: 15_000 }))
  return { app, page }
}

describe('A+ 内容详情：头部', () => {
  it('名称、状态、类型、店铺、版本、最近更新；草稿的已发布时间写“尚无记录”；详情不带范围参数', async () => {
    const { app, page } = await openDetail()
    const header = within(page.getByTestId('aplus-header'))
    expect(header.getByText('草稿')).toBeInTheDocument()
    expect(header.getByText('标准 A+ 内容')).toBeInTheDocument()
    expect(header.getByText('Northstar US')).toBeInTheDocument()
    expect(header.getByText('v3')).toBeInTheDocument()
    expect(header.getByText('2026-10-24 01:00 PDT')).toBeInTheDocument()
    expect(header.getByText('已发布时间').closest('.ant-descriptions-item')).toHaveTextContent('尚无记录')
    expect(page.getByRole('heading', { name: '旅行箱品牌故事' })).toBeInTheDocument()
    expect(lastParams(app, '/aplus/c1').toString()).toBe('')
  })

  it('已发布：显示已发布时间；有进行中的写入时显示“排队中/处理中·类型”', async () => {
    const { page } = await openDetail(() => publishedDetail())
    const header = within(await page.findByTestId('aplus-header'))
    expect(header.getByText('已发布时间').closest('.ant-descriptions-item')).toHaveTextContent('2026-08-31 17:00 PDT')
    expect(header.getByText('已发布', { selector: '.ant-tag' })).toHaveClass('ant-tag-green')
  })
})

describe('A+ 内容详情：被拒', () => {
  it('醒目区块：拒绝原文、按关键词给出的修复建议、建议的依据说明；状态标签是红色', async () => {
    const { page } = await openDetail(() => rejectedDetail())
    const block = within(await page.findByTestId('aplus-rejection'))
    expect(block.getByText(/拒绝原文：The image shows a price and a promotion\./)).toBeInTheDocument()
    expect(block.getByText(/删掉价格、促销、折扣与运费相关的文字/)).toBeInTheDocument()
    expect(block.getByText(/检查图片：分辨率要够/)).toBeInTheDocument()
    expect(block.getByText(APLUS_ADVICE_BASIS)).toBeInTheDocument()
    expect(within(page.getByTestId('aplus-header')).getByText('被拒', { selector: '.ant-tag' })).toHaveClass('ant-tag-red')
  })

  it('亚马逊没有返回原文：写明到卖家后台查看，不编造建议', async () => {
    const { page } = await openDetail(() => rejectedDetail(null))
    const block = within(await page.findByTestId('aplus-rejection'))
    expect(block.getByText(/亚马逊没有返回拒绝原因，请到卖家后台查看/)).toBeInTheDocument()
    expect(block.queryByText('修复建议：')).toBeNull()
  })

  it('不是被拒的内容：没有被拒区块', async () => {
    const { page } = await openDetail()
    await page.findByTestId('aplus-header')
    expect(page.queryByTestId('aplus-rejection')).toBeNull()
  })
})

describe('A+ 内容详情：模块预览', () => {
  it('固定显示预览说明；文字用真实文字，图片用占位框（尺寸与替代文字），不渲染真实图片', async () => {
    const { page } = await openDetail()
    const preview = within(await page.findByTestId('aplus-preview'))
    expect(preview.getByTestId('aplus-preview-note')).toHaveTextContent(APLUS_PREVIEW_NOTE)
    expect(preview.getByText('品牌故事')).toBeInTheDocument()
    expect(preview.getByText('我们从 2015 年开始做旅行箱。')).toBeInTheDocument()
    expect(preview.getByText('重量只有 2.8 公斤')).toBeInTheDocument()
    const placeholder = preview.getByTestId('aplus-image-placeholder')
    expect(placeholder).toHaveTextContent('图片 970×600')
    expect(placeholder).toHaveTextContent('替代文字：蓝色旅行箱正面')
    expect(placeholder.getAttribute('style')).toContain('dashed')
    expect(placeholder.getAttribute('style')).toContain('970 / 600')
    expect(page.getByTestId('aplus-preview').querySelector('img')).toBeNull()
    expect(preview.getByText(/模块 2 · 大图文/)).toBeInTheDocument()
  })

  it('没有模块：写“尚无记录”', async () => {
    const { page } = await openDetail(() => detailResponse({ modules: [] }))
    expect(await page.findByText(/尚无记录：这份内容里还没有模块/)).toBeInTheDocument()
  })

  it('不能转换的模块：显示“不支持预览的模块：<类型>”；不可编辑时写原因并禁用编辑', async () => {
    const { page } = await openDetail(() => readonlyDetail())
    const preview = within(await page.findByTestId('aplus-preview'))
    expect(preview.getByText('不支持预览的模块：STANDARD_COMPARISON_TABLE')).toBeInTheDocument()
    expect(preview.getByTestId('aplus-preview-note')).toHaveTextContent(APLUS_PREVIEW_NOTE)
    expect(page.getByTestId('aplus-edit-note')).toHaveTextContent('不在编辑器支持的范围内')
    expect(page.getByRole('button', { name: /编\s*辑/ })).toBeDisabled()
    expect(page.getByTestId('aplus-action-notes')).toHaveTextContent('不能编辑：')
  })
})

describe('A+ 内容详情：关联 ASIN 与时间线', () => {
  it('关联 ASIN 表：ASIN、标题、上线时间；没有标题与上线时间写“尚无记录”；截断提示', async () => {
    const { page } = await openDetail(() => detailResponse({ asinsTruncated: true }))
    const asins = within(await page.findByTestId('aplus-asins'))
    const first = asins.getByText('B0APLUS001').closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('旅行箱 24 寸')
    expect(first).toHaveTextContent('尚无记录')
    const second = asins.getByText('B0APLUS002').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('尚无记录')
    expect(second).toHaveTextContent('2026-08-31 17:00 PDT')
    expect(asins.getByText(/只显示了前 500 个/)).toBeInTheDocument()
  })

  it('没有关联 ASIN：写“尚无记录”', async () => {
    const { page } = await openDetail(() => detailResponse({ asins: [] }))
    expect(await within(await page.findByTestId('aplus-asins')).findByText(/还没有关联 ASIN/)).toBeInTheDocument()
  })

  it('审核时间线：状态、时间、来源与亚马逊原文；没有记录写“尚无记录”', async () => {
    const { page } = await openDetail(() => rejectedDetail())
    const timeline = within(await page.findByTestId('aplus-timeline'))
    expect(timeline.getByText(/2026-10-21 01:00 PDT · 本系统操作/)).toBeInTheDocument()
    expect(timeline.getByText(/2026-10-22 01:00 PDT · 亚马逊同步/)).toBeInTheDocument()
    expect(timeline.getAllByText('The image shows a price and a promotion.').length).toBeGreaterThan(0)
    expect(timeline.getByText('被拒', { selector: '.ant-tag' })).toHaveClass('ant-tag-red')
  })

  it('时间线为空：写“尚无记录”', async () => {
    const { page } = await openDetail(() => detailResponse({ timeline: [] }))
    expect(await within(await page.findByTestId('aplus-timeline')).findByText(/尚无记录：还没有状态变化记录/)).toBeInTheDocument()
  })
})

describe('A+ 内容详情：发布前后对照', () => {
  it('OK：两侧的会话、订购件数、转化率（百分比 2 位）与差值、相对变化；固定显示口径说明', async () => {
    const { page } = await openDetail(() => publishedDetail())
    const compare = within(await page.findByTestId('aplus-compare'))
    const sessions = compare.getByText('会话').closest('tr, [role=row]') as HTMLElement
    expect(sessions).toHaveTextContent('4,000')
    expect(sessions).toHaveTextContent('4,200')
    expect(compare.getByText('订购件数').closest('tr, [role=row]')).toHaveTextContent('200')
    expect(compare.getByText('订购件数').closest('tr, [role=row]')).toHaveTextContent('252')
    const conversion = compare.getByText('转化率').closest('tr, [role=row]') as HTMLElement
    expect(conversion).toHaveTextContent('5.00%')
    expect(conversion).toHaveTextContent('6.00%')
    expect(compare.getByTestId('aplus-compare-delta')).toHaveTextContent('转化率差：+1.00 个百分点；相对变化：+20.00%')
    expect(compare.getByText('统计区间').closest('tr, [role=row]')).toHaveTextContent('2026-08-04 至 2026-08-31（28/28 天有数据）')
    expect(compare.getByText(APLUS_COMPARE_BASIS)).toBeInTheDocument()
  })

  it('OK 但某一侧没有订购件数：写“尚无记录”，不写 0', async () => {
    const ok = compareOk()
    const compare: AplusCompare = { ...ok, before: { ...(ok.before as NonNullable<AplusCompare['before']>), units: null, conversion: null }, delta: null, relative: null }
    const { page } = await openDetail(() => detailResponse({ compare }))
    const card = within(await page.findByTestId('aplus-compare'))
    expect(card.getByText('订购件数').closest('tr, [role=row]')).toHaveTextContent('尚无记录')
    expect(card.getByText('转化率').closest('tr, [role=row]')).toHaveTextContent('尚无记录')
    expect(card.getByTestId('aplus-compare-delta')).toHaveTextContent('转化率差：尚无记录')
    expect(card.getByTestId('aplus-compare-delta')).not.toHaveTextContent('0')
  })

  const cases: Array<[AplusCompare['state'], string, string]> = [
    ['NOT_PUBLISHED', '尚无数据', '内容还没有发布，发布后才能对比前后转化率'],
    ['NO_PUBLISH_TIME', '尚无数据', '内容已批准，但发布记录里还没有查到上线时间，无法划分发布前后'],
    ['TOO_RECENT', '尚无数据', '发布后只有 3 天的完整数据，至少需要 7 天才对比'],
    ['INSUFFICIENT_DATA', '样本不足', '发布后的会话不足 100（或没有数据），样本太小不给结论'],
    ['NOT_CONNECTED', '尚未接入', '这些 ASIN 还没有同步到销售与流量数据，暂时无法对比'],
    ['RESTRICTED', '无权限', '查看销售与流量需要“分析”相关权限，你没有这个权限'],
  ]
  it.each(cases)('%s：显示“%s”与原因，不显示成 0，口径说明仍在', async (state, title, note) => {
    const { page } = await openDetail(() => detailResponse({ compare: compareOf({ state, note }) }))
    const card = within(await page.findByTestId('aplus-compare'))
    const alert = within(card.getByTestId('aplus-compare-state'))
    expect(alert.getByText(title)).toBeInTheDocument()
    expect(alert.getByText(note)).toBeInTheDocument()
    expect(card.queryByTestId('aplus-compare-delta')).toBeNull()
    expect(card.queryByRole('table')).toBeNull()
    expect(card.getByText(APLUS_COMPARE_BASIS)).toBeInTheDocument()
  })
})
