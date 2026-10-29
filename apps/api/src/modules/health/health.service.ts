import { Injectable } from '@nestjs/common'
import { AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      await this.queue.ping()
      return {
        status: 'ok',
        service: 'nova-api',
        mode: process.env.APP_MODE ?? 'development',
        checks: { database: 'ok', redis: 'ok' },
      }
    } catch {
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', '依赖服务尚未就绪，请稍后重试', true)
    }
  }
}
