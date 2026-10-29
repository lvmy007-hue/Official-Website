import { aplusModulesToAmazon, type AplusFormModule } from '@nova/api-contracts'
import { vi } from 'vitest'
import { createTestApp, sessionStub } from './harness'

// A+ 内容接口测试（P4-14）的共用替身与样例：内存里的“数据库”只实现被测代码调用的方法，调用到没有替身的方法会直接报错。
// 读取与各写入接口的用例分在三个文件里（aplus.http / aplus-write.http / aplus-upload.http），都从这里取替身。

export const READ = 'aplus.read'
export const WRITE = 'aplus.write'
export const ANALYTICS = 'analytics.read'

export const emptyRows = () => vi.fn().mockResolvedValue([])

/** 受限成员：只有店铺 s9 的数据范围（替身的店铺查询不看条件，所以一并把可见店铺换成 s9）。 */
export const OTHER_SCOPE = {
  membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's9' }]) },
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's9', displayName: '店铺 s9' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
}

export const img = (id: string, altText = '商品图') => ({ uploadDestinationId: id, altText })
export const textModule = (headline = '标题', body = '正文'): AplusFormModule => ({ type: 'STANDARD_TEXT', headline, body })
export const logoModule = (id: string): AplusFormModule => ({ type: 'STANDARD_COMPANY_LOGO', image: img(id) })

const AT = new Date('2026-10-20T00:00:00.000Z')

/** 一份已同步到亚马逊的草稿内容（版本 3、两个关联 ASIN、一个纯文字模块）。 */
export const contentRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  contentReferenceKey: 'KEY-1',
  name: '春季新品',
  contentType: 'EBC',
  locale: 'en-US',
  status: 'DRAFT',
  asinCount: 2,
  rejectionReason: null,
  draftJson: { contentModuleList: aplusModulesToAmazon([textModule()]) },
  amazonUpdatedAt: null,
  publishedAt: null,
  lastSyncedAt: null,
  version: 3,
  createdBy: 'user-1',
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

export const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  contentId: 'c1',
  kind: 'UPDATE',
  status: 'SUCCEEDED',
  requestJson: {},
  resultJson: null,
  warningsJson: null,
  failureCode: null,
  requestedBy: 'user-1',
  syncJobId: 'j1',
  createdAt: AT,
  finishedAt: AT,
  ...over,
})

/** 一次成功的图片上传记录（上传编号在 resultJson，宽高在 requestJson）。 */
export const uploadRun = (id: string, width: number, height: number, over: Record<string, unknown> = {}) =>
  runRow({
    id: `up-${id}`,
    contentId: null,
    kind: 'UPLOAD',
    requestJson: { fileName: `${id}.png`, contentType: 'image/png', sizeBytes: 1000, width, height },
    resultJson: { uploadDestinationId: id },
    ...over,
  })

/** 全部可用的默认替身：店铺 s1 已授权、写入开关开启、没有内容。用例按需覆盖。 */
export function aplusStubs(permissions: string[], extra: Record<string, unknown> = {}) {
  const stubs: Record<string, any> = {
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1', displayName: '店铺 s1' }) },
    membership: { ...(sessionStub(permissions).membership as object), findMany: emptyRows() },
    aplusContent: {
      findMany: emptyRows(),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: emptyRows(),
      create: vi.fn(async (args: { data: { version: number } }) => ({ version: args.data.version })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    aplusWriteRun: {
      findMany: emptyRows(),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: emptyRows(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    aplusAsinRelation: { findMany: emptyRows() },
    aplusReviewEvent: { findMany: emptyRows() },
    fbaProduct: { findMany: emptyRows() },
    salesTrafficAsinDaily: { findMany: emptyRows() },
    dataFreshness: { findMany: emptyRows() },
    syncJob: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...args.data })), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', lastErrorCode: null, healthChecks: [] }), findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1' }]) },
    integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    ...extra,
  }
  // 事务：同一份替身当作事务客户端，用例可以断言事务里的写入
  stubs.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(stubs))
  return stubs
}

type Harness = Awaited<ReturnType<typeof createTestApp>>
let current: Harness | undefined

export async function openAplus(permissions: string[], extra: Record<string, unknown> = {}) {
  await closeAplus()
  const stubs = aplusStubs(permissions, extra)
  current = await createTestApp({ ...sessionStub(permissions), ...stubs })
  return { app: current, stubs }
}

export async function closeAplus() {
  await current?.close()
  current = undefined
}
