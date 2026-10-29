import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 模型与迁移的一致性：执行全部迁移后，数据库结构必须与 schema.prisma 完全一致；
// 并用真实的 Prisma 客户端对分区表做一轮读写，确认模型映射可用。

const SCHEMA = join(__dirname, '../../../../database/prisma/schema.prisma')

describe('模型与迁移一致性、客户端读写', () => {
  let db: TestDatabase
  let prisma: PrismaClient
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('schema')
    const client = await db.connect('schema')
    await applyMigrations(client)
    await client.end()
    prisma = new PrismaClient({ datasources: { db: { url: db.urlFor('schema') } } })
  })
  afterAll(async () => {
    await prisma?.$disconnect()
    await db?.stop()
  })

  it('数据库结构与 schema.prisma 没有差异', () => {
    const prismaCli = require.resolve('prisma/build/index.js')
    const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-url', db.urlFor('schema'), '--to-schema-datamodel', SCHEMA, '--exit-code', '--script'], { encoding: 'utf8' })
    expect(result.status, `发现结构差异：\n${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it('Prisma 客户端可对分区表做幂等写入与读取', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'T', slug: 't-prisma' } })
    const legal = await prisma.legalEntity.create({ data: { tenantId: tenant.id, name: 'L', registeredCountry: 'US' } })
    const seller = await prisma.sellerAccount.create({
      data: { tenantId: tenant.id, legalEntityId: legal.id, sellerId: 'S1', logicalRegion: 'na', displayName: '店铺', marketplaceIds: ['ATVPDKIKX0DER'] },
    })
    const purchaseDate = new Date('2026-10-05T10:00:00.000Z')
    const base = {
      tenantId: tenant.id,
      sellerAccountId: seller.id,
      amazonOrderId: '111-1111111-1111111',
      marketplaceId: 'ATVPDKIKX0DER',
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: new Date(),
      sourceRecordId: 'x',
    }
    const upsert = () =>
      prisma.order.upsert({
        where: { sellerAccountId_amazonOrderId_purchaseDate: { sellerAccountId: seller.id, amazonOrderId: base.amazonOrderId, purchaseDate } },
        create: { ...base, purchaseDate },
        update: { status: 'Shipped', sourceUpdatedAt: new Date() },
      })
    const first = await upsert()
    const second = await upsert()
    expect(second.id).toBe(first.id)
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(1)

    await prisma.orderItem.create({
      data: {
        tenantId: tenant.id,
        sellerAccountId: seller.id,
        orderId: first.id,
        orderPurchaseDate: purchaseDate,
        amazonOrderId: base.amazonOrderId,
        orderItemId: 'oi-1',
        sourceUpdatedAt: new Date(),
      },
    })
    const withItems = await prisma.order.findUnique({ where: { id_purchaseDate: { id: first.id, purchaseDate } }, include: { items: true } })
    expect(withItems?.items).toHaveLength(1)

    const audit = await prisma.auditEvent.create({ data: { tenantId: tenant.id, action: 'TEST', resourceType: 'X', requestId: 'r1', result: 'SUCCEEDED' } })
    expect(audit.occurredAt).toBeInstanceOf(Date)
    const listed = await prisma.auditEvent.findMany({ where: { tenantId: tenant.id }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] })
    expect(listed).toHaveLength(1)
  })
})
