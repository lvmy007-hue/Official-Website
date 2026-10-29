// A+ 图片尺寸解析（P4-14）：纯函数，只读文件头，不依赖图片库。
// PNG：文件头 8 字节签名后第一个数据块必须是 IHDR，宽高是其中的两个 32 位大端整数；
// JPEG：从 SOI 之后逐段扫描，遇到 SOF0 至 SOF15（C4、C8、CC 不是帧头）取高与宽（各 16 位大端），先遇到 SOS（扫描数据）还没见到帧头就算损坏。

export type ImageFormat = 'png' | 'jpeg'
export interface ImageInfo {
  format: ImageFormat
  width: number
  height: number
}
export type ImageProblem = 'UNKNOWN_FORMAT' | 'CORRUPT'
export type ImageReadResult = { ok: true; info: ImageInfo } | { ok: false; problem: ImageProblem }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const corrupt: ImageReadResult = { ok: false, problem: 'CORRUPT' }

/** 宽高都要是正整数；0 或超出常识上限（65535 以上的 JPEG 不存在，PNG 上限取 2^31-1）一律当损坏。 */
const valid = (width: number, height: number, max: number) => Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= max && height <= max

function readPng(buffer: Buffer): ImageReadResult {
  // 签名 8 字节 + 数据块长度 4 字节 + 类型 4 字节 + 宽高 8 字节
  if (buffer.length < 24) return corrupt
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return corrupt
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return valid(width, height, 0x7fffffff) ? { ok: true, info: { format: 'png', width, height } } : corrupt
}

const isFrameMarker = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
/** 没有长度字段的标记：RSTn、TEM。 */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)

function readJpeg(buffer: Buffer): ImageReadResult {
  let offset = 2
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return corrupt
    // 标记前可以有任意个填充的 0xFF
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) return corrupt
    const marker = buffer[offset]!
    offset += 1
    if (marker === 0x00 || marker === 0xd8 || isStandalone(marker)) continue
    // EOI 或扫描数据开始还没见到帧头：不是一张完整的图
    if (marker === 0xd9 || marker === 0xda) return corrupt
    if (offset + 2 > buffer.length) return corrupt
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return corrupt
    if (isFrameMarker(marker)) {
      // 段内：长度 2 字节、精度 1 字节、高 2 字节、宽 2 字节
      if (length < 7) return corrupt
      const height = buffer.readUInt16BE(offset + 3)
      const width = buffer.readUInt16BE(offset + 5)
      return valid(width, height, 0xffff) ? { ok: true, info: { format: 'jpeg', width, height } } : corrupt
    }
    offset += length
  }
  return corrupt
}

/** 按文件头识别格式并读出宽高；不是 PNG 或 JPEG 为 UNKNOWN_FORMAT，头部损坏、被截断或尺寸不合法为 CORRUPT。 */
export function readImageInfo(buffer: Buffer): ImageReadResult {
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return readPng(buffer)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return readJpeg(buffer)
  return { ok: false, problem: 'UNKNOWN_FORMAT' }
}

/** 声明的内容类型对应的格式。 */
export const formatOfContentType = (contentType: string): ImageFormat | null => (contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpeg' : null)
