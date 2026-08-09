import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { hash, verify } from '@node-rs/argon2'

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  })
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}
