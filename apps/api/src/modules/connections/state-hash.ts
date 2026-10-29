import { createHash } from 'node:crypto'

// 授权回调的 state 只存摘要，库里不留原值。
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
