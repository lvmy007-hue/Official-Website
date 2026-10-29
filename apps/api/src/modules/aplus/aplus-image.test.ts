import { describe, expect, it } from 'vitest'
import { formatOfContentType, readImageInfo } from './aplus-image'

// A+ 图片尺寸解析（P4-14）：PNG 读 IHDR、JPEG 扫帧头段；格式不认识、截断、尺寸为 0 都要有明确的结果。

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}
const u16 = (value: number) => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value)
  return buffer
}
const png = (width: number, height: number) => Buffer.concat([PNG_SIGNATURE, u32(13), Buffer.from('IHDR'), u32(width), u32(height), Buffer.alloc(5), Buffer.alloc(4)])

/** 一个有长度的 JPEG 段：标记 + 长度（含自身 2 字节）+ 内容。 */
const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body])
const frame = (marker: number, width: number, height: number) => segment(marker, Buffer.concat([Buffer.from([8]), u16(height), u16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]))
const jpeg = (...parts: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])])

describe('PNG', () => {
  it('读 IHDR 的宽与高', () => {
    expect(readImageInfo(png(970, 600))).toEqual({ ok: true, info: { format: 'png', width: 970, height: 600 } })
    expect(readImageInfo(png(1, 1))).toEqual({ ok: true, info: { format: 'png', width: 1, height: 1 } })
  })

  it('宽或高为 0、第一个数据块不是 IHDR、被截断都是损坏', () => {
    expect(readImageInfo(png(0, 600))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(png(600, 0))).toEqual({ ok: false, problem: 'CORRUPT' })
    const wrongChunk = png(10, 10)
    wrongChunk.write('IDAT', 12, 'ascii')
    expect(readImageInfo(wrongChunk)).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(png(10, 10).subarray(0, 20))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(PNG_SIGNATURE)).toEqual({ ok: false, problem: 'CORRUPT' })
  })
})

describe('JPEG', () => {
  it('扫描到 SOF0 取高与宽（宽在后、高在前）', () => {
    expect(readImageInfo(jpeg(frame(0xc0, 970, 600)))).toEqual({ ok: true, info: { format: 'jpeg', width: 970, height: 600 } })
  })

  it('SOF2（渐进式）等 SOF1 至 SOF15 也认；DHT（C4）、JPG（C8）、DAC（CC）不是帧头', () => {
    expect(readImageInfo(jpeg(frame(0xc2, 300, 301)))).toEqual({ ok: true, info: { format: 'jpeg', width: 300, height: 301 } })
    expect(readImageInfo(jpeg(frame(0xcf, 40, 50)))).toEqual({ ok: true, info: { format: 'jpeg', width: 40, height: 50 } })
    for (const marker of [0xc4, 0xc8, 0xcc]) expect(readImageInfo(jpeg(segment(marker, Buffer.alloc(16)))), marker.toString(16)).toEqual({ ok: false, problem: 'CORRUPT' })
  })

  it('前面有 EXIF、JFIF、量化表等段与填充字节时跳过它们，不被缩略图里的帧头迷惑', () => {
    const thumbnail = jpeg(frame(0xc0, 160, 120))
    const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), thumbnail]))
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
      exif,
      Buffer.from([0xff, 0xff]),
      segment(0xdb, Buffer.alloc(65)),
      frame(0xc0, 1200, 800),
      Buffer.from([0xff, 0xd9]),
    ])
    expect(readImageInfo(buffer)).toEqual({ ok: true, info: { format: 'jpeg', width: 1200, height: 800 } })
  })

  it('尺寸为 0、先遇到扫描数据、段被截断、标记错位都是损坏', () => {
    expect(readImageInfo(jpeg(frame(0xc0, 0, 600)))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(jpeg(frame(0xc0, 600, 0)))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(jpeg())).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(jpeg(frame(0xc0, 600, 600)).subarray(0, 8))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({ ok: false, problem: 'CORRUPT' })
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34, 1, 2]))).toEqual({ ok: false, problem: 'CORRUPT' })
    // 段结束后下一个字节不是标记起始（0xFF）
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, 0x34]))).toEqual({ ok: false, problem: 'CORRUPT' })
  })
})

describe('格式识别', () => {
  it('不是 PNG 或 JPEG（GIF、空文件、文本、网页）都是未知格式', () => {
    expect(readImageInfo(Buffer.from('GIF89a......'))).toEqual({ ok: false, problem: 'UNKNOWN_FORMAT' })
    expect(readImageInfo(Buffer.alloc(0))).toEqual({ ok: false, problem: 'UNKNOWN_FORMAT' })
    expect(readImageInfo(Buffer.from('<html></html>'))).toEqual({ ok: false, problem: 'UNKNOWN_FORMAT' })
    expect(readImageInfo(Buffer.from([0xff, 0xd8]))).toEqual({ ok: false, problem: 'UNKNOWN_FORMAT' })
  })

  it('声明的内容类型对应的格式', () => {
    expect(formatOfContentType('image/png')).toBe('png')
    expect(formatOfContentType('image/jpeg')).toBe('jpeg')
    expect(formatOfContentType('image/gif')).toBeNull()
  })
})
