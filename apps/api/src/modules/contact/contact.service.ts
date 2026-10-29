import { Injectable } from '@nestjs/common'
import type { ContactRequestInput } from '@nova/api-contracts'
import { AppError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'

export const CONTACT_STATUSES = ['NEW', 'IN_PROGRESS', 'QUALIFIED', 'CLOSED', 'SPAM'] as const

@Injectable()
export class ContactService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly context: ContextService,
  ) {}

  // 官网咨询表单提交。蜜罐字段有值时直接回执但不落库。
  async create(input: ContactRequestInput) {
    if (input.companyWebsite) return { accepted: true, reference: 'CONTACT-RECEIVED', receivedAt: new Date() }
    const record = await this.prisma.contactRequest.create({
      data: {
        name: input.name,
        company: input.company,
        email: input.email,
        message: input.message,
        phone: input.phone,
        topic: input.topic,
        storeBand: input.storeBand,
      },
    })
    return { accepted: true, reference: `CONTACT-${record.id}`, receivedAt: record.createdAt }
  }

  async list(req: RequestWithContext, query: Record<string, string>) {
    await this.context.authorize(req, 'connection.manage')
    const where = query.status ? { status: query.status } : {}
    return this.prisma.contactRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 })
  }

  async updateStatus(req: RequestWithContext, id: string, status: string) {
    await this.context.authorize(req, 'connection.manage')
    if (!(CONTACT_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, 'INVALID_STATUS', 'Unsupported contact request status')
    }
    return this.prisma.contactRequest.update({ where: { id }, data: { status } })
  }
}
