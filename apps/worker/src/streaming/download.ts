import { PassThrough, Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

// 流式下载与解压（12.5 后台任务第 1、3 条）：下载流 → 解压流 → 逐行解析。
// 禁止：整份响应读入内存（arrayBuffer）、同步解压（gunzipSync）、整份文件转字符串。
// 内存占用只与流水线里的缓冲（每段约 64KB）有关，与文件大小无关。

export type Compression = 'gzip' | 'none' | 'auto'

/** 原始文件的去向（对象存储）：下载的原始字节（解压之前）同时写入这里，常驻内存不受影响。 */
export type RawSink = Writable

export class StreamLimitError extends Error {
  constructor(
    public readonly code: 'STREAM_TOO_LARGE' | 'STREAM_LINE_TOO_LONG',
    message: string,
  ) {
    super(message)
    this.name = 'StreamLimitError'
  }
}

/** 解压后总字节数上限，防止“压缩炸弹”拖垮进程。默认 8GB（足够容纳最大的亚马逊报告）。 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 8 * 1024 ** 3

/** 把源流同时写给 sink（原始文件落对象存储），并保持背压：sink 写得慢，下载就慢下来，而不是堆内存。 */
function tee(sink: RawSink): Transform {
  const failed = (error: Error) => tee.destroy(error)
  sink.on('error', failed)
  const tee: Transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (sink.write(chunk)) callback(null, chunk)
      else sink.once('drain', () => callback(null, chunk))
    },
    flush(callback) {
      sink.end(() => callback())
    },
    destroy(error, callback) {
      sink.off('error', failed)
      if (error) sink.destroy(error)
      callback(error)
    },
  })
  return tee
}

/** 限制通过的总字节数。 */
function limitBytes(maxBytes: number): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) callback(new StreamLimitError('STREAM_TOO_LARGE', `解压后的数据超过 ${maxBytes} 字节上限`))
      else callback(null, chunk)
    },
  })
}

/** 数组形式的 pipeline（阶段数量运行时决定，类型上放宽）。 */
function runPipeline(stages: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream>): Promise<void> {
  return pipeline(stages as unknown as [NodeJS.ReadableStream, NodeJS.WritableStream])
}

async function* prepend(first: Buffer, rest: AsyncIterator<Buffer>): AsyncGenerator<Buffer> {
  yield first
  for (;;) {
    const next = await rest.next()
    if (next.done) return
    yield next.value
  }
}

/** 自动识别：前两个字节是 1f 8b 就按 gzip 解压，否则原样透传。 */
function autoDecompress(raw: Readable, out: PassThrough, maxBytes: number): void {
  void (async () => {
    const iterator = raw[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    let head = Buffer.alloc(0)
    let first = await iterator.next()
    while (!first.done && head.length < 2) {
      head = Buffer.concat([head, first.value])
      if (head.length < 2) first = await iterator.next()
      else break
    }
    if (first.done && head.length === 0) {
      out.end()
      return
    }
    const gzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b
    const source = Readable.from(prepend(head, iterator), { objectMode: false })
    await runPipeline([source, ...(gzip ? [createGunzip()] : []), limitBytes(maxBytes), out])
  })().catch(error => out.destroy(error instanceof Error ? error : new Error(String(error))))
}

export interface OpenStreamOptions {
  compression?: Compression
  /** 原始文件（解压前）同时写入的目的地。 */
  sink?: RawSink
  maxDecompressedBytes?: number
}

/**
 * 把字节流变成“解压后的字节流”。出错（网络中断、数据损坏、超限）时输出流以该错误销毁，
 * 消费方的 for await 会抛出，不会静默截断。
 */
export function decodeStream(raw: Readable, options: OpenStreamOptions = {}): Readable {
  const { compression = 'auto', sink, maxDecompressedBytes = DEFAULT_MAX_DECOMPRESSED_BYTES } = options
  const out = new PassThrough()
  const source = sink ? raw.pipe(tee(sink)) : raw
  if (sink) raw.on('error', error => source.destroy(error))
  if (compression === 'auto') {
    autoDecompress(source, out, maxDecompressedBytes)
  } else {
    runPipeline([source, ...(compression === 'gzip' ? [createGunzip()] : []), limitBytes(maxDecompressedBytes), out]).catch(error =>
      out.destroy(error instanceof Error ? error : new Error(String(error))),
    )
  }
  return out
}

/** 把流读到结束（解析器理应已读完；万一提前返回，保证留存的原始文件是完整的）。 */
export async function drain(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return
  for await (const chunk of stream) void chunk
}

/** 从 fetch 响应得到解压后的字节流（不把响应体读入内存）。 */
export function responseStream(response: Response, options: OpenStreamOptions = {}): Readable {
  if (!response.body) throw new Error('DOWNLOAD_EMPTY_BODY')
  return decodeStream(Readable.fromWeb(response.body as never), options)
}
