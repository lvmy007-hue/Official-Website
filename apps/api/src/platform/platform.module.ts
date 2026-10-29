import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { MailService, MailTransport, UnconfiguredMailTransport } from './mail'
import { AlertService } from './observability'
import { PrismaService, SystemPrismaService } from './prisma.service'
import { CursorService } from './query/cursor.service'
import { QueueService } from './queue.service'
import { RateLimitService } from './rate-limit.service'
import { TenantSlotMiddleware } from './tenancy.middleware'
import { SampleDataService, SampleImporterRegistry } from './sample-data'
import { SecretBoxService } from './security/secret-box.service'
import { ObjectStorageService } from './storage'
import { WorkflowService } from './workflow'
import { ActionGuardService, AuditWriter, DbSwitches, IdempotencyService, IntegrationSwitchPort, StepUpService } from './write'

// 横向基础设施：数据库、队列、限流、游标分页、站内告警、写操作横向能力（审计、幂等、再次验证、动作守卫）。
// 全部领域模块共用，无业务逻辑。
@Global()
@Module({
  providers: [
    PrismaService,
    SystemPrismaService,
    QueueService,
    RateLimitService,
    CursorService,
    AlertService,
    SampleImporterRegistry,
    SampleDataService,
    WorkflowService,
    ObjectStorageService,
    SecretBoxService,
    MailService,
    // 邮件发送通道：部署专项配置邮件服务之前，如实报告“未发送”（14.10）
    { provide: MailTransport, useClass: UnconfiguredMailTransport },
    AuditWriter,
    IdempotencyService,
    StepUpService,
    ActionGuardService,
    // 写入开关的读取接口：读取开关表（无记录即关闭），环境变量紧急强制关闭优先
    { provide: IntegrationSwitchPort, useClass: DbSwitches },
  ],
  exports: [
    PrismaService,
    SystemPrismaService,
    QueueService,
    RateLimitService,
    CursorService,
    AlertService,
    SampleImporterRegistry,
    SampleDataService,
    WorkflowService,
    ObjectStorageService,
    SecretBoxService,
    MailService,
    AuditWriter,
    IdempotencyService,
    StepUpService,
    ActionGuardService,
    IntegrationSwitchPort,
  ],
})
export class PlatformModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantSlotMiddleware).forRoutes('*')
  }
}
