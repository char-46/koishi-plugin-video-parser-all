/**
 * 受限视频暂存（vault）：内存 LRU + 请求者绑定 + TTL。
 *
 * 命中 NSFW 的视频不进群：原样缓存（<=maxItemMB 下载字节；超限/下载失败不缓存，
 * 群内发原链接文字），解析请求者私聊「取视频 <token>」领取。
 * 插件卸载即清空，不落盘。
 */
import { randomBytes } from 'crypto'
import { debugLog } from '../../utils/logger'

export interface VaultEntry {
  requesterId: string
  buffer?: Buffer
  url?: string
  expiresAt: number
  meta: { title?: string; author?: string; platform?: string; sizeMB?: number }
}

export interface VaultConf {
  ttlMinutes: number
  maxItems: number
  maxItemMB: number
  budgetMB: number
}

const DEFAULT_CONF: VaultConf = { ttlMinutes: 30, maxItems: 20, maxItemMB: 200, budgetMB: 600 }

interface Stored extends VaultEntry { token: string; storedAt: number }

export class VideoVault {
  private items = new Map<string, Stored>()
  constructor(private conf: VaultConf = DEFAULT_CONF) {}

  private sweep(): void {
    const now = Date.now()
    for (const [token, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(token)
    }
  }

  private budgetBytes(): number {
    let total = 0
    for (const item of this.items.values()) total += item.buffer?.length || 0
    return total
  }

  /** 存入并返回取件 token；按条数/总预算 LRU 驱逐 */
  put(entry: VaultEntry): string {
    this.sweep()
    const token = randomBytes(16).toString('hex')
    const stored: Stored = { ...entry, token, storedAt: Date.now() }
    this.items.set(token, stored)
    const maxBytes = this.conf.budgetMB * 1048576
    while (this.items.size > this.conf.maxItems || (this.budgetBytes() > maxBytes && this.items.size > 1)) {
      const oldest = this.items.values().next().value as Stored | undefined
      if (!oldest || oldest.token === token) break
      this.items.delete(oldest.token)
      debugLog('INFO', 'vault LRU 驱逐一条暂存')
    }
    return token
  }

  /** 取件：校验请求者身份与有效期 */
  redeem(token: string, userId: string): { ok: true; entry: VaultEntry } | { ok: false; reason: 'not-found' | 'expired' | 'forbidden' } {
    this.sweep()
    const stored = this.items.get(String(token || '').trim())
    if (!stored) return { ok: false, reason: 'not-found' }
    if (stored.expiresAt <= Date.now()) return { ok: false, reason: 'expired' }
    if (stored.requesterId !== String(userId)) return { ok: false, reason: 'forbidden' }
    return { ok: true, entry: stored }
  }

  clear(): void {
    this.items.clear()
  }

  get size(): number {
    this.sweep()
    return this.items.size
  }
}

/** 插件级单例（dispose 时 clear，见 index.ts） */
export const videoVault = new VideoVault()

/** 更新单例配置（保留存量条目） */
export function configureVault(conf: Partial<VaultConf>): void {
  ;(videoVault as any).conf = { ...DEFAULT_CONF, ...conf }
}
