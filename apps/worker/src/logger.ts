import { PII_REDACT_KEYS } from '@nova/api-contracts'
import pino, { type DestinationStream, type Logger } from 'pino'

// 后台任务的结构化日志（P1-29）：与接口服务使用同一套敏感字段规则，买家信息、联系方式、令牌与密钥永不写入日志。
export const SENSITIVE_LOG_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'cookie',
  'setCookie',
  'secret',
  'clientSecret',
  'apiKey',
  'signature',
  'encryptedRefreshToken',
  'refreshTokenHash',
  'email',
  'phone',
  'contactEmail',
  'contactPhone',
  'buyerName',
  'buyerEmail',
  'buyerPhone',
  'shippingAddress',
  'address',
  'piiCiphertext',
] as const

export const REDACTED = '[已隐藏]'

/** 实际脱敏的字段名：上面的清单加上个人信息守卫（P6-14）约定的全部个人信息字段名，两边不会漂移。 */
export const LOG_REDACT_KEYS: readonly string[] = [...new Set<string>([...SENSITIVE_LOG_KEYS, ...PII_REDACT_KEYS])]

const redactPaths = LOG_REDACT_KEYS.flatMap(key => [key, `*.${key}`, `*.*.${key}`])

export function createWorkerLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, base: { service: 'nova-worker' }, timestamp: pino.stdTimeFunctions.isoTime, redact: { paths: redactPaths, censor: REDACTED } }, destination)
}
