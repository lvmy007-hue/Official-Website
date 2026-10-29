import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { runWithTenant } from '@nova/tenancy'
import { DeadLetterService, PrismaDeadLetterStore, PrismaWorkflowStore, WorkflowEngine, type CreateRunInput, type Enqueue, type TenantRunner, type WorkflowPrisma } from '@nova/workflow'
import type { RequestWithContext } from '../http'
import { PrismaService } from '../prisma.service'

// 接口服务侧的流程登记与死信管理（12.3）。
// - 受理会触发亚马逊写操作的用户请求时，先在这里登记流程（WorkflowRun），并把流程编号写到 req.writeRunId，
//   这样审计记录能指向真正执行写操作的流程；后台任务用同一个去重键续上它。
// - 死信：列出与重放。接口服务只通过租户连接访问，行级安全限定在当前租户。

/** 接口服务不做崩溃恢复扫描（那是后台任务的职责），系统客户端在这里不可用。 */
const noSystemClient = new Proxy(
  {},
  {
    get() {
      throw new Error('接口服务不使用系统连接扫描流程')
    },
  },
) as unknown as WorkflowPrisma

@Injectable()
export class WorkflowService {
  private readonly engine: WorkflowEngine
  private readonly deadLetterStore: PrismaDeadLetterStore
  private readonly runInTenant: TenantRunner

  constructor(prisma: PrismaService) {
    this.runInTenant = (tenantId, fn) => runWithTenant(tenantId, () => prisma.$transaction(tx => fn(tx as unknown as WorkflowPrisma)))
    this.engine = new WorkflowEngine(new PrismaWorkflowStore({ runInTenant: this.runInTenant, system: noSystemClient, dbNull: Prisma.DbNull }))
    this.deadLetterStore = new PrismaDeadLetterStore(this.runInTenant)
  }

  /** 登记（或续上）流程，并把流程编号写入本次请求，供审计记录引用。 */
  async registerWriteRun(req: RequestWithContext, input: CreateRunInput) {
    const { run } = await this.engine.start(input)
    req.writeRunId = run.id
    return run
  }

  listDeadLetters(tenantId: string, filter: { queue?: string; includeReplayed?: boolean; limit?: number }) {
    return this.deadLetterStore.list(tenantId, filter)
  }

  getDeadLetter(tenantId: string, id: string) {
    return this.deadLetterStore.get(tenantId, id)
  }

  /** 重放：互斥标记 → 由调用方提供的入队函数入队；返回 null 表示不存在或已被重放。 */
  replayDeadLetter(tenantId: string, id: string, userId: string, enqueue: Enqueue) {
    return new DeadLetterService(this.deadLetterStore, enqueue).replay(tenantId, id, userId)
  }
}
