import { describe, expect, it } from 'vitest'
import { decodeCsv } from './decode-csv'

describe('表格文件解码', () => {
  it('UTF-8 照常读，带 BOM 的会去掉 BOM', () => {
    expect(decodeCsv(new TextEncoder().encode('箱号,SKU').buffer as ArrayBuffer)).toBe('箱号,SKU')
    expect(decodeCsv(new TextEncoder().encode('\uFEFF箱号').buffer as ArrayBuffer)).toBe('箱号')
  })

  it('不是合法 UTF-8 时按 GBK 读（中文版 Excel 另存的 CSV）', () => {
    // “箱号,SKU” 的 GBK 字节
    const bytes = new Uint8Array([0xcf, 0xe4, 0xba, 0xc5, 0x2c, 0x53, 0x4b, 0x55])
    expect(decodeCsv(bytes.buffer)).toBe('箱号,SKU')
  })
})
