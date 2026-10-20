import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function keyBytes() {
  const key = process.env.TOKEN_ENCRYPTION_KEY ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('TOKEN_VAULT_NOT_CONFIGURED')
  return Buffer.from(key, 'hex')
}

export function sealPii(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}

export function openPii(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split('.')
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('PII_CIPHERTEXT_INVALID')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}
