/**
 * 审核结果缓存：同图（URL+内容哈希）在 TTL 内不重复送审，控制 API 计费。
 */
import { createHash } from 'crypto'
import { SimpleLRUCache } from '../../../utils/cache'
import type { CheckInput, CheckResult } from './types'

const CACHE_TTL_MS = 30 * 60 * 1000

const store = new SimpleLRUCache<CheckResult>(300, CACHE_TTL_MS)

export function cacheKey(input: CheckInput): string {
  const h = createHash('sha256')
  h.update(input.url)
  h.update(input.buffer)
  return h.digest('hex')
}

export function getCached(input: CheckInput): CheckResult | undefined {
  return store.get(cacheKey(input))
}

export function setCached(input: CheckInput, result: CheckResult): void {
  store.set(cacheKey(input), result)
}

export function clearModerationCache(): void {
  store.clear()
}
