import { inflateRawSync } from 'node:zlib'
import { crc32Update } from './zip-stream'

// 测试用的最小 ZIP 读取器：按结尾记录找到中央目录，逐个解压并核对 CRC 与大小。只用于验证我们自己写出的文件。

export interface ZipFile {
  name: string
  data: Buffer
}

export function readZip(buffer: Buffer): ZipFile[] {
  let end = buffer.length - 22
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('找不到 ZIP 结尾记录')
  const count = buffer.readUInt16LE(end + 10)
  let pointer = buffer.readUInt32LE(end + 16)
  const files: ZipFile[] = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('中央目录记录损坏')
    const method = buffer.readUInt16LE(pointer + 10)
    const crc = buffer.readUInt32LE(pointer + 16)
    const compressed = buffer.readUInt32LE(pointer + 20)
    const size = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const offset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`${name} 的本地头损坏`)
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const raw = buffer.subarray(dataStart, dataStart + compressed)
    if (method !== 8) throw new Error(`${name} 不是 deflate 压缩`)
    const data = inflateRawSync(raw)
    if (data.length !== size) throw new Error(`${name} 解压后大小不符`)
    if (crc32Update(0, data) !== crc) throw new Error(`${name} 的 CRC 校验不符`)
    // 数据描述符紧跟压缩数据
    if (buffer.readUInt32LE(dataStart + compressed) !== 0x08074b50) throw new Error(`${name} 缺少数据描述符`)
    files.push({ name, data })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return files
}

export const zipText = (files: ZipFile[], name: string) => files.find(file => file.name === name)?.data.toString('utf8')
