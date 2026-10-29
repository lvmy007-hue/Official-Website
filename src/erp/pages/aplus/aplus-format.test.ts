import { describe, expect, it } from 'vitest'
import { APLUS_LIMITS, aplusEmptyModule } from '@nova/api-contracts'
import {
  conversionText,
  deltaText,
  editorIssues,
  formatBytes,
  imageFileIssue,
  imageOptionState,
  imageSizeText,
  parseAsinInput,
  pendingRunText,
  rawModuleType,
  relativeText,
  writeBlockOf,
  writeResultNote,
} from './aplus-format'

// A+ 内容的纯函数（P4-14）：ASIN 解析、图片校验、写入入口判断、转化率文字、编辑器本地校验。

describe('parseAsinInput', () => {
  it('空格、逗号、换行分隔；转大写；去重并记录重复个数', () => {
    const parsed = parseAsinInput('b0abcde123, B0ABCDE124\nb0abcde123；b0abcde125')
    expect(parsed.asins).toEqual(['B0ABCDE123', 'B0ABCDE124', 'B0ABCDE125'])
    expect(parsed.duplicates).toBe(1)
    expect(parsed.issues).toEqual([])
  })

  it('不是 10 位字母或数字的逐个指出，超过 5 个写“等 N 个”', () => {
    expect(parseAsinInput('B0ABCDE123 SHORT').issues[0]).toContain('SHORT')
    const many = parseAsinInput('A1 A2 A3 A4 A5 A6 A7').issues[0]
    expect(many).toContain('等 7 个')
    expect(parseAsinInput('B0ABCDE12!').issues).toHaveLength(1)
  })

  it('一次最多 50 个：超出时给出问题；刚好 50 个通过', () => {
    const make = (count: number) => Array.from({ length: count }, (_v, index) => `B0ABCD${String(index).padStart(4, '0')}`).join(' ')
    expect(parseAsinInput(make(APLUS_LIMITS.asinsPerRequestMax)).issues).toEqual([])
    expect(parseAsinInput(make(APLUS_LIMITS.asinsPerRequestMax + 1)).issues[0]).toContain(`一次最多关联 ${APLUS_LIMITS.asinsPerRequestMax} 个`)
  })

  it('什么都没填：没有 ASIN，也没有问题', () => {
    expect(parseAsinInput('  ,\n ')).toEqual({ asins: [], duplicates: 0, issues: [] })
  })
})

describe('图片文件与图库选项', () => {
  const file = (type: string, size: number) => ({ name: 'a.png', type, size })

  it('只收 JPG 与 PNG，不超过 5 MB，不能是空文件', () => {
    expect(imageFileIssue(file('image/png', 1024))).toBeNull()
    expect(imageFileIssue(file('image/jpeg', APLUS_LIMITS.imageMaxBytes))).toBeNull()
    expect(imageFileIssue(file('image/gif', 1024))).toContain('不是 JPG 或 PNG')
    expect(imageFileIssue(file('image/png', APLUS_LIMITS.imageMaxBytes + 1))).toContain('超过')
    expect(imageFileIssue(file('image/png', 0))).toContain('空文件')
  })

  it('图库选项：没上传成功不可选；尺寸不够不可选并写明差多少；够用可选', () => {
    const upload = { status: 'SUCCEEDED' as const, uploadDestinationId: 'd1', width: 1000, height: 700 }
    expect(imageOptionState(upload, 'STANDARD_HEADER_IMAGE_TEXT')).toEqual({ usable: true, reason: null })
    expect(imageOptionState({ ...upload, width: 900 }, 'STANDARD_HEADER_IMAGE_TEXT')).toEqual({ usable: false, reason: '尺寸不够：至少需要 970×600，这张只有 900×700' })
    expect(imageOptionState({ ...upload, status: 'RUNNING' }, 'STANDARD_COMPANY_LOGO').usable).toBe(false)
    expect(imageOptionState({ ...upload, uploadDestinationId: null }, 'STANDARD_COMPANY_LOGO').usable).toBe(false)
  })

  it('模块要求的尺寸文字；文字模块没有', () => {
    expect(imageSizeText('STANDARD_HEADER_IMAGE_TEXT')).toBe('970×600 像素')
    expect(imageSizeText('STANDARD_TEXT')).toBeNull()
  })
})

describe('写入入口与结果', () => {
  const off = { allowed: false, step: 'SWITCH' as const, reason: '开关没开', remedyPath: '/app/settings/integrations' }
  it('没权限先说无权限；开关没开给原因与处理入口；都通过为 null；还没读到写入状态时提示读取中', () => {
    expect(writeBlockOf(off, false)?.reason).toContain('无权限')
    expect(writeBlockOf(off, true)).toEqual({ reason: '开关没开', remedyPath: '/app/settings/integrations' })
    expect(writeBlockOf({ ...off, allowed: true, reason: null }, true)).toBeNull()
    expect(writeBlockOf(undefined, true)?.reason).toContain('正在读取')
  })

  it('受理成功只说已登记；没能入队要明说', () => {
    expect(writeResultNote({ queued: true })).toEqual({ type: 'success', text: '已登记，稍后在写入记录里看结果' })
    const failed = writeResultNote({ queued: false })
    expect(failed.type).toBe('warning')
    expect(failed.text).toContain('没能进入任务队列')
  })

  it('进行中写入：排队中·提交审核', () => {
    expect(pendingRunText({ status: 'QUEUED', kindLabel: '提交审核' })).toBe('排队中·提交审核')
    expect(pendingRunText({ status: 'RUNNING', kindLabel: '保存修改' })).toBe('处理中·保存修改')
  })
})

describe('数字文字', () => {
  it('转化率保留 2 位百分比；没有数据写“尚无记录”，不写 0', () => {
    expect(conversionText(0.0512)).toBe('5.12%')
    expect(conversionText(null)).toBe('尚无记录')
    expect(deltaText(0.01)).toBe('+1.00 个百分点')
    expect(deltaText(-0.005)).toBe('-0.50 个百分点')
    expect(deltaText(null)).toBe('尚无记录')
    expect(relativeText(0.2)).toBe('+20.00%')
    expect(relativeText(null)).toContain('无法计算相对变化')
  })

  it('文件大小：不足 1 MB 用 KB', () => {
    expect(formatBytes(40 * 1024)).toBe('40.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB')
    expect(formatBytes(null)).toBe('尚无记录')
  })

  it('原始模块的类型名：缺失写“未知”', () => {
    expect(rawModuleType({ contentModuleType: 'STANDARD_X' })).toBe('STANDARD_X')
    expect(rawModuleType(null)).toBe('未知')
    expect(rawModuleType({})).toBe('未知')
  })
})

describe('editorIssues', () => {
  it('店铺、名称、模块问题逐条给出', () => {
    const issues = editorIssues({ storeId: undefined, name: '  ', modules: [aplusEmptyModule('STANDARD_PRODUCT_DESCRIPTION'), aplusEmptyModule('STANDARD_COMPANY_LOGO')], needStore: true })
    expect(issues).toEqual(['请先选择店铺', '请填写内容名称', '第 1 个模块（商品描述）的正文不能为空', '第 2 个模块（品牌标志）还没有选择图片'])
  })

  it('编辑时不要求店铺；名称超 100 字符与没有模块也要报', () => {
    const issues = editorIssues({ storeId: undefined, name: 'x'.repeat(101), modules: [], needStore: false })
    expect(issues).toEqual(['名称不能超过 100 个字符，现在有 101 个', '至少添加一个模块'])
  })

  it('全部合格返回空数组', () => {
    expect(editorIssues({ storeId: 's', name: '名称', modules: [{ type: 'STANDARD_TEXT', headline: '', body: '正文' }], needStore: true })).toEqual([])
  })
})
