import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { StorageError } from './errors.js'
import type { ObjectWriter, StoredObject } from './types.js'

/** 具体存储的“字节落点”：按顺序接收分段，结束时提交，出错时丢弃。 */
export interface ByteSink {
  write(chunk: Buffer): Promise<void>
  /** 全部写完后提交（本地：重命名；云：完成分段上传）。 */
  finish(): Promise<void>
  /** 丢弃已写入的部分（本地：删临时文件；云：取消分段上传）。可重复调用。 */
  abort(): Promise<void>
}

/**
 * 把 ByteSink 包成流式写入句柄：边写边计算大小与 SHA-256，超过上限立即中止；
 * end() 的回调要等 sink.finish() 完成才触发，所以上游（下载流水线）结束即代表文件已经落稳。
 */
export function createObjectWriter(key: string, sink: ByteSink, maxBytes?: number): ObjectWriter {
  const hash = createHash('sha256')
  let size = 0
  let settled = false
  let resolveDone!: (value: StoredObject) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<StoredObject>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  done.catch(() => undefined) // 调用方可能只关心流的错误，避免“未处理的拒绝”

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (maxBytes !== undefined && size > maxBytes) {
        callback(new StorageError('STORAGE_OBJECT_TOO_LARGE', `文件超过 ${maxBytes} 字节上限`))
        return
      }
      hash.update(chunk)
      sink.write(chunk).then(() => callback(), callback)
    },
    final(callback) {
      sink.finish().then(() => {
        settled = true
        resolveDone({ key, sizeBytes: size, sha256: hash.digest('hex') })
        callback()
      }, callback)
    },
    destroy(error, callback) {
      if (settled) {
        callback(error)
        return
      }
      settled = true
      const reason = error ?? new Error('写入被中止')
      rejectDone(reason)
      sink.abort().then(
        () => callback(error),
        () => callback(error),
      )
    },
  })
  return {
    stream,
    done,
    abort: async () => {
      if (!stream.destroyed) stream.destroy()
      await sink.abort()
    },
  }
}
