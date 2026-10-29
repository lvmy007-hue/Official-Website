import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { createDeflateRaw } from 'node:zlib'

// 流式 ZIP 写入（XLSX 文件本质是 ZIP）：每个文件边压缩边写出，内存占用与文件大小无关。
// 使用“数据描述符”（先写头、后补 CRC 与大小），不需要预先知道内容长度。不支持 ZIP64（单文件与总大小需小于 4GB，调用方限制行数）。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc ^ 0xffffffff
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Entry {
  name: Buffer
  crc: number
  compressed: number
  size: number
  offset: number
}

const GENERAL_FLAGS = 0x0808 // 第 3 位：使用数据描述符；第 11 位：文件名为 UTF-8
const FOUR_GB = 0xffffffff

function dosDateTime(now: Date) {
  const time = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1)
  const date = ((Math.max(now.getUTCFullYear(), 1980) - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()
  return { time, date }
}

export class ZipStream {
  private readonly entries: Entry[] = []
  private offset = 0

  constructor(
    private readonly target: Writable,
    private readonly now: Date = new Date(),
  ) {}

  private async raw(buffer: Buffer) {
    // 先同步写出并累计偏移（保证多段压缩输出的顺序与偏移一致），再按需等待排空
    const flushed = this.target.write(buffer)
    this.offset += buffer.length
    if (this.offset > FOUR_GB) throw new Error('ZIP_TOO_LARGE')
    if (!flushed) await once(this.target, 'drain')
  }

  /** 添加一个文件：produce 通过 write 逐段写入内容（字符串按 UTF-8 编码）。 */
  async addFile(name: string, produce: (write: (chunk: string | Buffer) => Promise<void>) => Promise<void>) {
    const nameBytes = Buffer.from(name, 'utf8')
    const { time, date } = dosDateTime(this.now)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(GENERAL_FLAGS, 6)
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt16LE(nameBytes.length, 26)
    const entry: Entry = { name: nameBytes, crc: 0, compressed: 0, size: 0, offset: this.offset }
    await this.raw(header)
    await this.raw(nameBytes)

    const deflate = createDeflateRaw()
    const pending: Promise<void>[] = []
    deflate.on('data', (chunk: Buffer) => {
      entry.compressed += chunk.length
      pending.push(this.raw(chunk))
    })
    const finished = once(deflate, 'end')
    const write = async (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      entry.crc = crc32Update(entry.crc, bytes)
      entry.size += bytes.length
      if (!deflate.write(bytes)) await once(deflate, 'drain')
      await Promise.all(pending.splice(0))
    }
    try {
      await produce(write)
      deflate.end()
      await finished
      await Promise.all(pending.splice(0))
    } catch (error) {
      deflate.destroy()
      throw error
    }
    if (entry.size > FOUR_GB) throw new Error('ZIP_TOO_LARGE')
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(entry.crc, 4)
    descriptor.writeUInt32LE(entry.compressed, 8)
    descriptor.writeUInt32LE(entry.size, 12)
    await this.raw(descriptor)
    this.entries.push(entry)
  }

  /** 写中央目录与结尾记录。之后不能再添加文件；是否结束 target 由调用方决定。 */
  async finish() {
    const { time, date } = dosDateTime(this.now)
    const start = this.offset
    for (const entry of this.entries) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(GENERAL_FLAGS, 8)
      record.writeUInt16LE(8, 10)
      record.writeUInt16LE(time, 12)
      record.writeUInt16LE(date, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.compressed, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.name.length, 28)
      record.writeUInt32LE(entry.offset, 42)
      await this.raw(record)
      await this.raw(entry.name)
    }
    const size = this.offset - start
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    await this.raw(end)
  }
}
