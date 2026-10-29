import { describe, expect, it } from 'vitest'
import { APLUS_LIMITS, aplusFailureText } from './aplus'
import { aplusEmptyModule, aplusFormModulesOf, aplusImageRefs, aplusModuleIssues, aplusModuleToAmazon, aplusModulesFromAmazon, aplusModulesToAmazon, type AplusFormModule } from './aplus-modules'
import { aplusActionsOf, aplusCompareOf, aplusCompareWindows, aplusFixAdvice, aplusStatusOf, type AplusDailyPoint } from './aplus-math'
import { AplusAsinBodySchema, AplusCreateBodySchema, AplusListQuerySchema, AplusUpdateBodySchema, AplusUploadTicketBodySchema } from './aplus-query'

const img = (id: string) => ({ uploadDestinationId: id, altText: '商品图' })
const full: AplusFormModule[] = [
  { type: 'STANDARD_TEXT', headline: '标题', body: '正文' },
  { type: 'STANDARD_PRODUCT_DESCRIPTION', body: '描述' },
  { type: 'STANDARD_COMPANY_LOGO', image: img('u1') },
  { type: 'STANDARD_HEADER_IMAGE_TEXT', headline: '总标题', block: { image: img('u2'), headline: '小标题', body: '说明' } },
  { type: 'STANDARD_SINGLE_SIDE_IMAGE', position: 'RIGHT', block: { image: img('u3'), headline: '', body: '说明' } },
]

describe('模块与亚马逊结构互转', () => {
  it('每种模块转出去再转回来内容不变，且可编辑', () => {
    const three: AplusFormModule = { type: 'STANDARD_THREE_IMAGE_TEXT', headline: 'H', blocks: [1, 2, 3].map(n => ({ image: img(`t${n}`), headline: `h${n}`, body: `b${n}` })) as never }
    const list = [...full, three].slice(1)
    const view = aplusModulesFromAmazon(aplusModulesToAmazon(list))
    expect(view.editable).toBe(true)
    expect(view.modules).toEqual(list)
    expect(aplusFormModulesOf(aplusModulesToAmazon(list))).toEqual(list)
  })
  it('空的文字样式数组不影响可编辑判断', () => {
    const raw = aplusModuleToAmazon(full[0]!) as { standardText: { headline: Record<string, unknown> } }
    raw.standardText.headline.decoratorSet = []
    expect(aplusModulesFromAmazon([raw]).editable).toBe(true)
  })
  it('不支持的模块、带样式的段落、不同的裁剪设置都只读', () => {
    const unknown = aplusModulesFromAmazon([{ contentModuleType: 'STANDARD_COMPARISON_TABLE', standardComparisonTable: {} }])
    expect(unknown.editable).toBe(false)
    expect(unknown.note).toContain('第 1 个模块')
    const styled = aplusModuleToAmazon(full[0]!) as { standardText: { body: { textList: Array<Record<string, unknown>> } } }
    styled.standardText.body.textList[0]!.decoratorSet = [{ type: 'STYLE_BOLD' }]
    expect(aplusModulesFromAmazon([styled]).editable).toBe(false)
    const crop = aplusModuleToAmazon(full[2]!) as { standardCompanyLogo: { companyLogo: { imageCropSpecification: { offset: { x: { value: number } } } } } }
    crop.standardCompanyLogo.companyLogo.imageCropSpecification.offset.x.value = 10
    expect(aplusModulesFromAmazon([crop]).editable).toBe(false)
    expect(aplusFormModulesOf([crop])).toBeNull()
  })
  it('没有模块与超过上限', () => {
    expect(aplusModulesFromAmazon(undefined)).toEqual({ modules: [], editable: true, note: null })
    expect(aplusModulesFromAmazon(Array.from({ length: 6 }, () => aplusModuleToAmazon(full[0]!))).editable).toBe(false)
  })
})

describe('内容校验', () => {
  it('合格的内容没有问题', () => expect(aplusModuleIssues(full)).toEqual([]))
  it('空模块逐项指出缺什么', () => {
    const issues = aplusModuleIssues([aplusEmptyModule('STANDARD_TEXT'), aplusEmptyModule('STANDARD_COMPANY_LOGO')])
    expect(issues.map(item => item.field)).toEqual(['body', 'image.0'])
  })
  it('图片缺替代文字、文字超长、模块过多', () => {
    const noAlt: AplusFormModule = { type: 'STANDARD_COMPANY_LOGO', image: { uploadDestinationId: 'u', altText: ' ' } }
    expect(aplusModuleIssues([noAlt])[0]?.field).toBe('image.0.altText')
    expect(aplusModuleIssues([{ type: 'STANDARD_PRODUCT_DESCRIPTION', body: 'x'.repeat(5001) }])).toHaveLength(1)
    expect(aplusModuleIssues([])[0]?.field).toBe('modules')
    expect(aplusModuleIssues(Array.from({ length: 6 }, () => full[0]!)).some(item => item.index === -1)).toBe(true)
  })
  it('图片引用带上所在模块要求的尺寸', () => {
    expect(aplusImageRefs(full)).toEqual([
      { uploadDestinationId: 'u1', width: 600, height: 180 },
      { uploadDestinationId: 'u2', width: 970, height: 600 },
      { uploadDestinationId: 'u3', width: 300, height: 300 },
    ])
  })
})

describe('状态、动作与修复建议', () => {
  it('已批准且有上线时间才算已发布，不认识的状态不覆盖', () => {
    expect(aplusStatusOf('APPROVED', false)).toBe('APPROVED')
    expect(aplusStatusOf('approved', true)).toBe('PUBLISHED')
    expect(aplusStatusOf('REJECTED', true)).toBe('REJECTED')
    expect(aplusStatusOf('ARCHIVED', false)).toBeNull()
    expect(aplusStatusOf(null, false)).toBeNull()
  })
  it('修复建议按关键词给，没有原文给空，不认识的给兜底', () => {
    expect(aplusFixAdvice(null)).toEqual([])
    expect(aplusFixAdvice('Image contains a watermark and a price')).toHaveLength(2)
    expect(aplusFixAdvice('something odd')).toHaveLength(1)
  })
  const base = { status: 'DRAFT' as const, hasKey: true, busy: false, asinCount: 1, editable: true, editNote: null }
  it('草稿可编辑可提交，没有 ASIN 不能提交', () => {
    const ok = aplusActionsOf(base)
    expect([ok.edit.allowed, ok.associate.allowed, ok.submit.allowed]).toEqual([true, true, true])
    expect(aplusActionsOf({ ...base, asinCount: 0 }).submit.reason).toContain('至少要关联一个')
  })
  it('没创建成功、有写入在处理、审核中、已批准、不可编辑都说明原因', () => {
    expect(aplusActionsOf({ ...base, hasKey: false }).edit.reason).toContain('还没有创建成功')
    expect(aplusActionsOf({ ...base, busy: true }).submit.reason).toContain('正在处理')
    const retry = aplusActionsOf({ ...base, hasKey: false, createFailed: true })
    expect([retry.edit.allowed, retry.associate.allowed, retry.submit.allowed]).toEqual([true, false, false])
    expect(aplusActionsOf({ ...base, hasKey: false, createFailed: true, busy: true }).edit.allowed).toBe(false)
    const submitted = aplusActionsOf({ ...base, status: 'SUBMITTED' })
    expect([submitted.edit.allowed, submitted.associate.allowed, submitted.submit.allowed]).toEqual([false, false, false])
    const approved = aplusActionsOf({ ...base, status: 'APPROVED' })
    expect([approved.edit.allowed, approved.associate.allowed, approved.submit.allowed]).toEqual([false, true, false])
    expect(aplusActionsOf({ ...base, editable: false, editNote: '含不支持的模块' }).edit.reason).toBe('含不支持的模块')
  })
})

describe('发布前后对照', () => {
  const now = new Date('2026-10-24T08:00:00Z')
  const daily = (from: string, days: number, sessions: number, units: number): AplusDailyPoint[] =>
    Array.from({ length: days }, (_, i) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), sessions, units }))
  const input = { status: 'PUBLISHED' as const, publishedAt: '2026-09-20T05:00:00Z', asinCount: 2, now }
  it('窗口以发布日为界，发布当天不计，发布后到昨天为止', () => {
    const w = aplusCompareWindows('2026-09-20T05:00:00Z', now)
    expect(w.before).toEqual({ from: '2026-08-23', to: '2026-09-19', days: 28 })
    expect(w.after).toEqual({ from: '2026-09-21', to: '2026-10-18', days: 28 })
    expect(aplusCompareWindows('2026-10-20T00:00:00Z', now).after).toEqual({ from: '2026-10-21', to: '2026-10-23', days: 3 })
  })
  it('样本够就给结论', () => {
    const rows = [...daily('2026-08-23', 28, 10, 1), ...daily('2026-09-21', 28, 10, 2)]
    const out = aplusCompareOf({ ...input, daily: rows })
    expect(out.state).toBe('OK')
    expect(out.before?.conversion).toBeCloseTo(0.1)
    expect(out.after?.conversion).toBeCloseTo(0.2)
    expect(out.delta).toBeCloseTo(0.1)
    expect(out.relative).toBeCloseTo(1)
  })
  it('每种不能下结论的情形都有状态与原因，不给估算值', () => {
    expect(aplusCompareOf({ ...input, status: 'DRAFT', publishedAt: null, daily: [] }).state).toBe('NOT_PUBLISHED')
    expect(aplusCompareOf({ ...input, status: 'APPROVED', publishedAt: null, daily: [] }).state).toBe('NO_PUBLISH_TIME')
    expect(aplusCompareOf({ ...input, daily: 'RESTRICTED' }).state).toBe('RESTRICTED')
    expect(aplusCompareOf({ ...input, daily: null }).state).toBe('NOT_CONNECTED')
    expect(aplusCompareOf({ ...input, publishedAt: '2026-10-20T00:00:00Z', daily: [] }).state).toBe('TOO_RECENT')
    const thin = aplusCompareOf({ ...input, daily: [...daily('2026-08-23', 28, 1, 0), ...daily('2026-09-21', 28, 10, 1)] })
    expect(thin.state).toBe('INSUFFICIENT_DATA')
    expect(thin.note).toContain('发布前')
    expect(thin.delta).toBeNull()
    expect(aplusCompareOf({ ...input, daily: [] }).state).toBe('INSUFFICIENT_DATA')
  })
  it('会话有、订购件数缺失时不算转化率', () => {
    const rows = [...daily('2026-08-23', 28, 10, 1), ...daily('2026-09-21', 28, 10, 1)].map(item => (item.date > '2026-09-20' ? { ...item, units: null } : item))
    const out = aplusCompareOf({ ...input, daily: rows })
    expect(out.state).toBe('INSUFFICIENT_DATA')
    expect(out.note).toContain('订购件数')
  })
})

describe('请求校验', () => {
  const text = { type: 'STANDARD_TEXT', headline: '', body: 'x' }
  it('新建：名称、模块个数与默认值', () => {
    const ok = AplusCreateBodySchema.parse({ storeId: 's1', name: ' 新品 ', modules: [text] })
    expect(ok).toMatchObject({ name: '新品', locale: 'en-US', contentType: 'EBC' })
    expect(AplusCreateBodySchema.safeParse({ storeId: 's1', name: '', modules: [text] }).success).toBe(false)
    expect(AplusCreateBodySchema.safeParse({ storeId: 's1', name: 'a', modules: [] }).success).toBe(false)
    expect(AplusCreateBodySchema.safeParse({ storeId: 's1', name: 'a', modules: Array.from({ length: APLUS_LIMITS.modulesMax + 1 }, () => text) }).success).toBe(false)
    expect(AplusCreateBodySchema.safeParse({ storeId: 's1', name: 'a', modules: [{ type: 'OTHER' }] }).success).toBe(false)
    expect(AplusCreateBodySchema.safeParse({ storeId: 's1', name: 'a', modules: [text], extra: 1 }).success).toBe(false)
  })
  it('修改：要带版本号，至少改一项', () => {
    expect(AplusUpdateBodySchema.safeParse({ version: 2, name: 'n' }).success).toBe(true)
    expect(AplusUpdateBodySchema.safeParse({ version: 2 }).success).toBe(false)
    expect(AplusUpdateBodySchema.safeParse({ name: 'n' }).success).toBe(false)
  })
  it('关联 ASIN：规整成大写、去重检查、上限', () => {
    expect(AplusAsinBodySchema.parse({ version: 1, asins: [' b0abcde123 '] }).asins).toEqual(['B0ABCDE123'])
    expect(AplusAsinBodySchema.safeParse({ version: 1, asins: ['B0ABCDE123', 'b0abcde123'] }).success).toBe(false)
    expect(AplusAsinBodySchema.safeParse({ version: 1, asins: ['short'] }).success).toBe(false)
    expect(AplusAsinBodySchema.safeParse({ version: 1, asins: [] }).success).toBe(false)
  })
  it('图片票据：只收 JPG 与 PNG，大小有上限', () => {
    const ok = { storeId: 's1', fileName: 'a.png', contentType: 'image/png', sizeBytes: 1000 }
    expect(AplusUploadTicketBodySchema.safeParse(ok).success).toBe(true)
    expect(AplusUploadTicketBodySchema.safeParse({ ...ok, contentType: 'image/gif' }).success).toBe(false)
    expect(AplusUploadTicketBodySchema.safeParse({ ...ok, sizeBytes: APLUS_LIMITS.imageMaxBytes + 1 }).success).toBe(false)
  })
  it('列表查询默认按最近更新倒序', () => {
    const query = AplusListQuerySchema.parse({})
    expect(query.sort).toEqual({ field: 'updatedAt', dir: 'desc' })
    expect(AplusListQuerySchema.safeParse({ status: 'WRONG' }).success).toBe(false)
  })
})

describe('失败说明', () => {
  it('只留来源加状态码，不显示亚马逊原文', () => {
    expect(aplusFailureText(null)).toBeNull()
    expect(aplusFailureText('SP_API_403')).toContain('授权')
    expect(aplusFailureText('SP_API_400')).toContain('400')
    expect(aplusFailureText('SP_API_429')).toContain('限流')
    expect(aplusFailureText('SP_API_503')).toContain('暂时不可用')
    expect(aplusFailureText('APL_SWITCH_OFF')).toContain('开关')
    expect(aplusFailureText('???')).toContain('失败')
  })
})
