import { Injectable } from '@nestjs/common'
import { runWithTenant } from '@nova/tenancy'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { AppError } from '../http'
import { PrismaService } from '../prisma.service'

// 测试租户与官方格式样例文件的加载机制（P1-29，11 章 11.4）。
//
// 规则：
//   1. 只有“测试环境 + 测试租户（Tenant.mode = TEST）”才允许加载；生产环境无论租户是什么一律拒绝，在代码层判断，不靠配置；
//   2. 样例文件必须是亚马逊官方格式，登记在 fixtures/amazon-official/manifest.json，登记内容含来源说明与摘要，文件被改动即拒绝；
//   3. 样例文件只交给真实导入器处理，走与生产相同的解析、校验、写入链路；这里不写入任何业务表，也不伪造数据；
//   4. 没有登记导入器的样例文件，在读取任何文件之前整体拒绝，不会出现“加载一半”。

export const SAMPLE_DATA_TENANT_MODE = 'TEST'
export const DEFAULT_FIXTURE_DIR = resolve(__dirname, '../../../fixtures/amazon-official')

export interface SampleFileEntry {
  /** 处理该文件的导入器标识。 */
  importer: string
  /** 相对样例目录的文件名。 */
  file: string
  /** 文件内容的 SHA-256（十六进制）。 */
  sha256: string
  /** 官方格式的来源说明（文档名称与版本）。 */
  source: string
}

export interface SampleManifest {
  version: 1
  files: SampleFileEntry[]
}

export interface SampleImportInput {
  tenantId: string
  fileName: string
  content: Buffer
}
export interface SampleImporter {
  readonly key: string
  /** 真实导入器的入口：解析、校验、写入，并且必须幂等。返回处理的行数。 */
  importSample(input: SampleImportInput): Promise<{ rows: number }>
}

export class SampleDataRefusedError extends AppError {
  constructor(message: string) {
    super(403, 'SAMPLE_DATA_FORBIDDEN', message)
  }
}

/** 代码层的硬性判断。生产环境（APP_MODE=production）永远拒绝。 */
export function assertSampleDataAllowed(tenant: { id: string; mode: string } | null, env: NodeJS.ProcessEnv = process.env): asserts tenant is { id: string; mode: string } {
  if (env.APP_MODE === 'production') throw new SampleDataRefusedError('生产环境不允许加载样例文件')
  if (!tenant) throw new SampleDataRefusedError('租户不存在，不能加载样例文件')
  if (tenant.mode !== SAMPLE_DATA_TENANT_MODE) throw new SampleDataRefusedError('只有测试租户可以加载样例文件')
}

@Injectable()
export class SampleImporterRegistry {
  private readonly importers = new Map<string, SampleImporter>()
  register(importer: SampleImporter) {
    if (this.importers.has(importer.key)) throw new Error(`sample importer already registered: ${importer.key}`)
    this.importers.set(importer.key, importer)
  }
  get(key: string) {
    return this.importers.get(key)
  }
}

export interface SampleDataOptions {
  fixtureDir?: string
  env?: NodeJS.ProcessEnv
}

@Injectable()
export class SampleDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SampleImporterRegistry,
  ) {}

  // 运维脚本与测试直接调用，没有请求上下文：显式在目标租户中运行，导入器的全部数据库访问都带着这个租户。
  load(tenantId: string, options: SampleDataOptions = {}) {
    return runWithTenant(tenantId, () => this.loadInTenant(tenantId, options))
  }

  private async loadInTenant(tenantId: string, options: SampleDataOptions) {
    const env = options.env ?? process.env
    // 先判断环境，再访问数据库：生产环境不做任何多余的事。
    if (env.APP_MODE === 'production') throw new SampleDataRefusedError('生产环境不允许加载样例文件')
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, mode: true } })
    assertSampleDataAllowed(tenant, env)

    const dir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR
    const manifest = await this.readManifest(dir)
    const missing = [...new Set(manifest.files.filter(entry => !this.registry.get(entry.importer)).map(entry => entry.importer))]
    if (missing.length > 0) throw new AppError(409, 'SAMPLE_IMPORTER_MISSING', `样例文件对应的导入器尚未注册：${missing.join('、')}`)

    // 先全部读取并校验，再开始导入。
    const loaded: Array<{ entry: SampleFileEntry; content: Buffer }> = []
    for (const entry of manifest.files) loaded.push({ entry, content: await this.readVerified(dir, entry) })

    const results: Array<{ importer: string; file: string; rows: number }> = []
    for (const { entry, content } of loaded) {
      const { rows } = await this.registry.get(entry.importer)!.importSample({ tenantId, fileName: entry.file, content })
      results.push({ importer: entry.importer, file: entry.file, rows })
    }
    return results
  }

  private async readManifest(dir: string): Promise<SampleManifest> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      throw new AppError(500, 'SAMPLE_MANIFEST_INVALID', '样例文件清单不存在或格式错误')
    }
    const manifest = parsed as Partial<SampleManifest>
    const valid =
      manifest?.version === 1 &&
      Array.isArray(manifest.files) &&
      manifest.files.every(
        entry =>
          entry &&
          typeof entry.importer === 'string' &&
          typeof entry.file === 'string' &&
          /^[0-9a-f]{64}$/.test(String(entry.sha256)) &&
          typeof entry.source === 'string' &&
          entry.source.trim().length > 0,
      )
    if (!valid) throw new AppError(500, 'SAMPLE_MANIFEST_INVALID', '样例文件清单格式错误：每个文件都必须登记导入器、摘要与官方来源说明')
    return manifest as SampleManifest
  }

  private async readVerified(dir: string, entry: SampleFileEntry): Promise<Buffer> {
    const root = resolve(dir)
    const target = resolve(root, normalize(entry.file))
    if (isAbsolute(entry.file) || !target.startsWith(root + sep)) throw new AppError(500, 'SAMPLE_MANIFEST_INVALID', `样例文件路径不合法：${entry.file}`)
    const content = await readFile(target).catch(() => {
      throw new AppError(500, 'SAMPLE_FILE_MISSING', `样例文件不存在：${entry.file}`)
    })
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new AppError(500, 'SAMPLE_FILE_CHANGED', `样例文件与登记的摘要不一致：${entry.file}`)
    return content
  }
}
