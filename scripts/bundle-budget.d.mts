export const DEFAULT_LIMIT_BYTES: number
export const ROOT_MATCHERS: RegExp[]
export type ManifestEntry = { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean }
export type Manifest = Record<string, ManifestEntry>
export function collectInitialChunks(manifest: Manifest, roots?: RegExp[]): Array<{ key: string; file: string }>
export function evaluateBudget(
  manifest: Manifest,
  readGzipSize: (file: string) => number,
  limitBytes?: number,
  roots?: RegExp[],
): { total: number; limitBytes: number; ok: boolean; chunks: Array<{ key: string; file: string; gzip: number }> }
