import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaService } from '../prisma.service'
import { assertSampleDataAllowed, DEFAULT_FIXTURE_DIR, SampleDataRefusedError, SampleDataService, SampleImporterRegistry, type SampleImporter } from './sample-data.service'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('样例文件加载（P1-29）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-sample-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const manifest = (files: unknown[]) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, files }))
  const entry = (importer: string, file: string, content: string) => ({ importer, file, sha256: sha(content), source: '亚马逊官方报告格式说明' })
  const prismaFor = (tenant: { id: string; mode: string } | null) => {
    const findUnique = vi.fn().mockResolvedValue(tenant)
    return { prisma: { tenant: { findUnique } } as unknown as PrismaService, findUnique }
  }
  const importer = (key: string, calls: string[] = []): SampleImporter & { calls: string[] } => ({
    key,
    calls,
    importSample: vi.fn(async input => {
      calls.push(`${key}:${input.fileName}:${input.content.toString()}`)
      return { rows: 2 }
    }),
  })
  const setup = (tenant: { id: string; mode: string } | null, importers: SampleImporter[]) => {
    const registry = new SampleImporterRegistry()
    importers.forEach(item => registry.register(item))
    const { prisma, findUnique } = prismaFor(tenant)
    return { service: new SampleDataService(prisma, registry), findUnique }
  }
  const testEnv = { APP_MODE: 'test' } as NodeJS.ProcessEnv

  describe('生产环境拒绝', () => {
    it('即使是测试租户，生产环境也拒绝，并且不访问数据库、不读取文件、不调用导入器', async () => {
      const content = 'a'
      writeFileSync(join(dir, 'a.tsv'), content)
      manifest([entry('orders', 'a.tsv', content)])
      const imp = importer('orders')
      const { service, findUnique } = setup({ id: 't1', mode: 'TEST' }, [imp])
      await expect(service.load('t1', { fixtureDir: dir, env: { APP_MODE: 'production' } as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(SampleDataRefusedError)
      expect(findUnique).not.toHaveBeenCalled()
      expect(imp.importSample).not.toHaveBeenCalled()
    })

    it('判断函数：生产环境拒绝，非测试租户拒绝，租户不存在拒绝，测试环境的测试租户通过', () => {
      expect(() => assertSampleDataAllowed({ id: 't', mode: 'TEST' }, { APP_MODE: 'production' } as NodeJS.ProcessEnv)).toThrow(SampleDataRefusedError)
      expect(() => assertSampleDataAllowed({ id: 't', mode: 'LIVE' }, testEnv)).toThrow(SampleDataRefusedError)
      expect(() => assertSampleDataAllowed(null, testEnv)).toThrow(SampleDataRefusedError)
      expect(() => assertSampleDataAllowed({ id: 't', mode: 'TEST' }, testEnv)).not.toThrow()
    })

    it('非测试环境变量（APP_MODE 未设置）同样需要测试租户', () => {
      expect(() => assertSampleDataAllowed({ id: 't', mode: 'LIVE' }, {} as NodeJS.ProcessEnv)).toThrow(SampleDataRefusedError)
    })
  })

  describe('租户检查', () => {
    it('正式租户（LIVE）拒绝加载', async () => {
      manifest([])
      const { service } = setup({ id: 't1', mode: 'LIVE' }, [])
      await expect(service.load('t1', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_DATA_FORBIDDEN' })
    })
    it('租户不存在拒绝加载', async () => {
      manifest([])
      const { service } = setup(null, [])
      await expect(service.load('missing', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_DATA_FORBIDDEN' })
    })
  })

  describe('测试租户加载', () => {
    it('按清单顺序把文件交给对应的真实导入器', async () => {
      writeFileSync(join(dir, 'orders.tsv'), 'ORDERS')
      writeFileSync(join(dir, 'fees.tsv'), 'FEES')
      manifest([entry('orders', 'orders.tsv', 'ORDERS'), entry('fees', 'fees.tsv', 'FEES')])
      const calls: string[] = []
      const { service } = setup({ id: 't1', mode: 'TEST' }, [importer('orders', calls), importer('fees', calls)])
      const result = await service.load('t1', { fixtureDir: dir, env: testEnv })
      expect(calls).toEqual(['orders:orders.tsv:ORDERS', 'fees:fees.tsv:FEES'])
      expect(result).toEqual([
        { importer: 'orders', file: 'orders.tsv', rows: 2 },
        { importer: 'fees', file: 'fees.tsv', rows: 2 },
      ])
    })

    it('清单里的导入器没有注册时，整体拒绝，不会加载一半', async () => {
      writeFileSync(join(dir, 'orders.tsv'), 'ORDERS')
      writeFileSync(join(dir, 'x.tsv'), 'X')
      manifest([entry('orders', 'orders.tsv', 'ORDERS'), entry('unknown', 'x.tsv', 'X')])
      const imp = importer('orders')
      const { service } = setup({ id: 't1', mode: 'TEST' }, [imp])
      await expect(service.load('t1', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_IMPORTER_MISSING' })
      expect(imp.importSample).not.toHaveBeenCalled()
    })

    it('文件内容被改动（摘要不一致）时整体拒绝，已校验通过的文件也不会导入', async () => {
      writeFileSync(join(dir, 'a.tsv'), 'A')
      writeFileSync(join(dir, 'b.tsv'), 'B-changed')
      manifest([entry('orders', 'a.tsv', 'A'), entry('orders', 'b.tsv', 'B')])
      const imp = importer('orders')
      const { service } = setup({ id: 't1', mode: 'TEST' }, [imp])
      await expect(service.load('t1', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_FILE_CHANGED' })
      expect(imp.importSample).not.toHaveBeenCalled()
    })

    it('拒绝目录之外的路径', async () => {
      manifest([{ importer: 'orders', file: '../secret.txt', sha256: sha('x'), source: '官方格式' }])
      const { service } = setup({ id: 't1', mode: 'TEST' }, [importer('orders')])
      await expect(service.load('t1', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_MANIFEST_INVALID' })
    })

    it('清单里的文件缺少官方来源说明时视为格式错误', async () => {
      writeFileSync(join(dir, 'a.tsv'), 'A')
      manifest([{ importer: 'orders', file: 'a.tsv', sha256: sha('A'), source: '' }])
      const { service } = setup({ id: 't1', mode: 'TEST' }, [importer('orders')])
      await expect(service.load('t1', { fixtureDir: dir, env: testEnv })).rejects.toMatchObject({ code: 'SAMPLE_MANIFEST_INVALID' })
    })

    it('仓库自带的清单格式正确', async () => {
      const { service } = setup({ id: 't1', mode: 'TEST' }, [])
      await expect(service.load('t1', { fixtureDir: DEFAULT_FIXTURE_DIR, env: testEnv })).resolves.toEqual([])
    })
  })

  it('同一个导入器标识不能重复注册', () => {
    const registry = new SampleImporterRegistry()
    registry.register(importer('orders'))
    expect(() => registry.register(importer('orders'))).toThrow()
  })
})
