import type { AplusImageRef } from '@nova/api-contracts'
import { appError } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'
import { isRecord } from './aplus-common'

// 模块里图片的核对（P4-14）：创建与保存时，模块引用的每张图片必须是这个店铺成功上传（SUCCEEDED 的 UPLOAD 写入记录，resultJson 里有同一个上传编号）的，
// 并且原图宽高都不小于所在模块要求的尺寸。保存已有内容时，当前文档里已有的图片（keep）沿用旧图，不需要重新上传，也不核对尺寸。

const unprocessable = (message: string) => appError('VALIDATION_FAILED', message, { fieldErrors: { modules: [message] } })
const MISSING_TEXT = '有图片不是这个店铺成功上传的（可能还在上传中、上传失败或属于别的店铺），请在图片库确认上传完成后再选择'

interface Uploaded {
  fileName: string
  width: number
  height: number
}

export async function assertImagesUsable(prisma: PrismaService, input: { tenantId: string; storeId: string; refs: readonly AplusImageRef[]; keep?: ReadonlySet<string> }): Promise<void> {
  const fresh = input.refs.filter(ref => !input.keep?.has(ref.uploadDestinationId))
  if (fresh.length === 0) return
  const ids = [...new Set(fresh.map(ref => ref.uploadDestinationId))]
  const runs = await prisma.aplusWriteRun.findMany({
    where: {
      tenantId: input.tenantId,
      sellerAccountId: input.storeId,
      kind: 'UPLOAD',
      status: 'SUCCEEDED',
      OR: ids.map(id => ({ resultJson: { path: ['uploadDestinationId'], equals: id } })),
    },
    select: { requestJson: true, resultJson: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: ids.length * 5,
  })
  const uploaded = new Map<string, Uploaded>()
  for (const run of runs) {
    const result = isRecord(run.resultJson) ? run.resultJson : {}
    const request = isRecord(run.requestJson) ? run.requestJson : {}
    const id = result.uploadDestinationId
    if (typeof id !== 'string' || uploaded.has(id)) continue
    if (typeof request.width !== 'number' || typeof request.height !== 'number') continue
    uploaded.set(id, { fileName: typeof request.fileName === 'string' ? request.fileName : '图片', width: request.width, height: request.height })
  }
  for (const ref of fresh) {
    const image = uploaded.get(ref.uploadDestinationId)
    if (!image) throw unprocessable(MISSING_TEXT)
    if (image.width < ref.width || image.height < ref.height) {
      throw unprocessable(`图片「${image.fileName}」只有 ${image.width}×${image.height} 像素，所在模块要求至少 ${ref.width}×${ref.height}，请换一张更大的图片`)
    }
  }
}
