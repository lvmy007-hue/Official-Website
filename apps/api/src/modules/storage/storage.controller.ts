import { Controller, Get, Param, Put, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { pipeline } from 'node:stream/promises'
import { ok, type RequestWithContext } from '../../platform/http'
import { WriteExempt } from '../../platform/write'
import { StorageService } from './storage.service'

// 本地磁盘驱动的签名链接入口（P1-23）。凭证是链接里的短时令牌，没有登录态；令牌由服务端签发并绑定文件与动作。
// 使用阿里云对象存储时这两个接口不存在（返回“接口不存在”）。
@Controller('storage/local')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  async download(@Param('token') token: string, @Res() response: Response) {
    const { stream, headers } = await this.storage.download(token)
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    await pipeline(stream, response)
  }

  @WriteExempt('签名直传：凭证是服务端签发的短时令牌（绑定文件、内容类型与大小上限），没有登录态；上传完成后由发起方在业务接口里确认并登记')
  @Put(':token')
  async upload(@Param('token') token: string, @Req() req: RequestWithContext) {
    const result = await this.storage.upload(token, req, { contentType: req.headers['content-type'], contentLength: req.headers['content-length'] })
    return ok(result, req)
  }
}
