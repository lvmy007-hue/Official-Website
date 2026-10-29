import { describe, expect, it } from 'vitest'
import {
  BOX_NO_MAX_LENGTH,
  DEFAULT_BOX_NO_RULE,
  DEFAULT_LABEL_OPTIONS,
  LABEL_OPTION_META,
  LABEL_PAPERS,
  LABEL_PAPER_SPEC,
  boxNoPreview,
  formatBoxNo,
  labelsPerPage,
  normalizeBoxNoRule,
  normalizeLabelOptions,
  validateBoxNoRule,
  validateLabelTemplate,
  type LabelTemplateInput,
} from './label-template.js'

const template = (patch: Partial<LabelTemplateInput> = {}): LabelTemplateInput => ({
  name: '热敏纸标准',
  paper: 'THERMAL_4X6',
  options: { ...DEFAULT_LABEL_OPTIONS },
  boxNoRule: { ...DEFAULT_BOX_NO_RULE },
  ...patch,
})
const fields = (input: LabelTemplateInput) => validateLabelTemplate(input).map(issue => issue.field)

describe('箱号规则', () => {
  it('前缀、计划号、递增数字、后缀依次拼接，空的部分跳过', () => {
    expect(formatBoxNo(DEFAULT_BOX_NO_RULE, 'PLAN', 0)).toBe('BOX-001')
    expect(formatBoxNo({ ...DEFAULT_BOX_NO_RULE, includePlanNo: true, suffix: 'CN' }, 'wf-9', 11)).toBe('BOX-wf-9-012-CN')
    expect(formatBoxNo({ ...DEFAULT_BOX_NO_RULE, prefix: '', joiner: '' }, 'P', 4)).toBe('005')
  })

  it('起始序号可以覆盖，数字超过位数时不截断', () => {
    expect(formatBoxNo(DEFAULT_BOX_NO_RULE, 'P', 0, 101)).toBe('BOX-101')
    expect(formatBoxNo({ ...DEFAULT_BOX_NO_RULE, digits: 2 }, 'P', 0, 1000)).toBe('BOX-1000')
  })

  it('预览给出前几个箱号', () => {
    expect(boxNoPreview({ ...DEFAULT_BOX_NO_RULE, start: 8 }, 'P')).toEqual(['BOX-008', 'BOX-009', 'BOX-010'])
    expect(boxNoPreview(DEFAULT_BOX_NO_RULE, 'P', 2)).toEqual(['BOX-001', 'BOX-002'])
  })

  it('校验：字符、长度、位数、起始序号、整体长度', () => {
    expect(validateBoxNoRule(DEFAULT_BOX_NO_RULE)).toEqual([])
    const fieldsOf = (patch: Partial<typeof DEFAULT_BOX_NO_RULE>) => validateBoxNoRule({ ...DEFAULT_BOX_NO_RULE, ...patch }).map(issue => issue.field)
    expect(fieldsOf({ prefix: '箱' })).toEqual(['boxNoRule.prefix'])
    expect(fieldsOf({ suffix: 'A B' })).toEqual(['boxNoRule.suffix'])
    expect(fieldsOf({ prefix: 'ABCDEFGHIJKLM' })).toEqual(['boxNoRule.prefix'])
    expect(fieldsOf({ joiner: '----' })).toEqual(['boxNoRule.joiner'])
    expect(fieldsOf({ digits: 0 })).toEqual(['boxNoRule.digits'])
    expect(fieldsOf({ digits: 9 })).toEqual(['boxNoRule.digits'])
    expect(fieldsOf({ digits: 1.5 })).toEqual(['boxNoRule.digits'])
    expect(fieldsOf({ start: -1 })).toEqual(['boxNoRule.start'])
    expect(fieldsOf({ start: 100_000_000 })).toEqual(['boxNoRule.start'])
    const long = { prefix: 'A'.repeat(12), suffix: 'B'.repeat(12), joiner: '---', digits: 8, includePlanNo: true }
    expect(formatBoxNo({ ...DEFAULT_BOX_NO_RULE, ...long }, 'P'.repeat(10), 0).length).toBeGreaterThan(BOX_NO_MAX_LENGTH)
    expect(validateBoxNoRule({ ...DEFAULT_BOX_NO_RULE, ...long }, 'P'.repeat(10)).map(issue => issue.field)).toEqual(['boxNoRule'])
  })

  it('读取存储内容时补齐缺失字段，错误类型回到默认值', () => {
    expect(normalizeBoxNoRule(null)).toEqual(DEFAULT_BOX_NO_RULE)
    expect(normalizeBoxNoRule({ prefix: 'X', digits: 'a', start: 2.5, includePlanNo: 'yes' })).toEqual({ ...DEFAULT_BOX_NO_RULE, prefix: 'X' })
    expect(normalizeBoxNoRule({ prefix: 'X', digits: 4, start: 7, includePlanNo: true, suffix: 'S', joiner: '_' })).toEqual({
      prefix: 'X',
      digits: 4,
      start: 7,
      includePlanNo: true,
      suffix: 'S',
      joiner: '_',
    })
    expect(normalizeLabelOptions([])).toEqual(DEFAULT_LABEL_OPTIONS)
    expect(normalizeLabelOptions({ showSku: false, order: 'OURS', originText: 5, showFnsku: 'x' })).toEqual({ ...DEFAULT_LABEL_OPTIONS, showSku: false, order: 'OURS' })
  })
})

describe('标签模板校验', () => {
  it('默认模板合格；每个纸张都有规格，一页的标签数与行列一致', () => {
    expect(validateLabelTemplate(template())).toEqual([])
    expect(LABEL_PAPERS.map(labelsPerPage)).toEqual([1, 2, 4])
    for (const paper of LABEL_PAPERS) expect(LABEL_PAPER_SPEC[paper].amazonPageType).toMatch(/^PackageLabel_/)
  })

  it('名称：必填、去掉空格后判断、最多 40 个字符', () => {
    expect(fields(template({ name: '   ' }))).toEqual(['name'])
    expect(fields(template({ name: 'a'.repeat(41) }))).toEqual(['name'])
    expect(fields(template({ name: ' 甲 ' }))).toEqual([])
  })

  it('原产地：勾选后必须填文字，文字最多 40 个字符', () => {
    expect(fields(template({ options: { ...DEFAULT_LABEL_OPTIONS, originText: '  ' } }))).toEqual(['options.originText'])
    expect(fields(template({ options: { ...DEFAULT_LABEL_OPTIONS, showOrigin: false, originText: '' } }))).toEqual([])
    expect(fields(template({ options: { ...DEFAULT_LABEL_OPTIONS, originText: 'x'.repeat(41) } }))).toEqual(['options.originText'])
  })

  it('追加到原标签只有热敏纸可用；多张拼版不能按我方箱号重排', () => {
    expect(fields(template({ options: { ...DEFAULT_LABEL_OPTIONS, appendToOriginal: true } }))).toEqual([])
    expect(fields(template({ paper: 'A4_4UP', options: { ...DEFAULT_LABEL_OPTIONS, appendToOriginal: true } }))).toEqual(['options.appendToOriginal'])
    expect(fields(template({ paper: 'A4_2UP', options: { ...DEFAULT_LABEL_OPTIONS, order: 'OURS' } }))).toEqual(['options.order'])
    expect(fields(template({ options: { ...DEFAULT_LABEL_OPTIONS, order: 'OURS' } }))).toEqual([])
  })

  it('箱号规则的问题一并返回', () => {
    expect(fields(template({ boxNoRule: { ...DEFAULT_BOX_NO_RULE, prefix: '箱' } }))).toEqual(['boxNoRule.prefix'])
  })

  it('每个勾选项都写明了印出来的条件', () => {
    expect(LABEL_OPTION_META.map(item => item.key).sort()).toEqual(['appendToOriginal', 'showBoxNo', 'showFnsku', 'showOrigin', 'showProductName', 'showSku', 'showUnits', 'taskNamePage'])
    for (const item of LABEL_OPTION_META) expect(item.condition.length).toBeGreaterThan(8)
  })
})
