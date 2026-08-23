/**
 * 解析编排：三层去重 → 并发解析 → gate（NSFW 策略）预处理 → 发送分派。
 *
 * 去重三层（默认全开）：
 * ① 同消息 URL 去重（含并发竞态）
 * ② 内容指纹去重（不同链接相同内容只发首个）
 * ③ title===desc 抑制（engine/parser 与 twitter mapper 内实现）
 *
 * 发送分派（优先级）：
 * enableForward(onebot/satori) → 合并转发
 * sendStrategy='single'（默认）→ 单条整合；不可行/失败 → 转发 → split
 * sendStrategy='split' → 逐条
 */
import type { ParserRuntime } from '../runtime'
import type { LinkMatch } from '../types'
import { ConcurrencyLimiter } from '../utils/concurrency'
import { debugLog } from '../utils/logger'
import { contentFingerprint, getText } from '../utils/common'
import { getPlatformConfig } from '../platforms/custom'
import { processSingleUrl } from '../engine/fetcher'
import { processImage, processVideo } from '../nsfw/gate'
import type { ImageOutcome, VideoOutcome } from '../nsfw/gate'
import { sendWithTimeout } from './sender'
import { sendSingle, buildTokenHint, canSingle, type ProcessedItem } from './compose'
import { sendSplit } from './split'
import { sendForward } from './forward'

export interface FlushOptions {
  /** 手动命令（parse <url>）显式触发：跳过去重检查（用户明确要求重新解析） */
  skipDedup?: boolean
}

/** 去重键按会话隔离：防的是同一会话内刷屏，不阻断内容跨会话传播 */
function dedupScopeKey(session: any, url: string): string {
  const scope = session?.channelId || session?.guildId || session?.userId || 'global'
  return `${scope}::${url}`
}

/** gate 预处理：把 ParsedData 转成发送层消费的 ProcessedItem */
async function processItem(rt: ParserRuntime, session: any, platform: string, text: string, parsed: any): Promise<ProcessedItem> {
  const requesterId = String(session?.userId || 'unknown')
  const images: ImageOutcome[] = []
  const scrambleTokens: string[] = []
  for (const url of (parsed.images || []) as string[]) {
    const out = await processImage(rt, platform, url, 'image')
    if (out.kind === 'scrambled' && out.token) scrambleTokens.push(out.token)
    images.push(out)
  }
  const avatar = parsed.avatar ? await processImage(rt, platform, parsed.avatar, 'avatar') : { kind: 'drop' as const }
  if (avatar.kind === 'scrambled' && avatar.token) scrambleTokens.push(avatar.token)
  const cover = (parsed.cover && parsed.type !== 'image' && parsed.type !== 'live_photo' && parsed.type !== 'live')
    ? await processImage(rt, platform, parsed.cover, 'cover')
    : null
  if (cover && cover.kind === 'scrambled' && cover.token) scrambleTokens.push(cover.token)

  const video: VideoOutcome = parsed.video
    ? await processVideo(rt, platform, parsed.video, parsed.cover || '', { title: parsed.title, author: parsed.author, requesterId })
    : { kind: 'raw' as const, url: '' }

  return { text, parsed, images, avatar, cover, video, scrambleTokens }
}

export async function flush(rt: ParserRuntime, session: any, matches: LinkMatch[], opts: FlushOptions = {}) {
  const { config, dedupCache, contentDedupCache } = rt
  debugLog('INFO', `开始解析 ${matches.length} 个链接`)
  const items: ProcessedItem[] = []
  const errors: string[] = []
  const limiter = new ConcurrencyLimiter(config.maxConcurrent || 3)

  // 去重层①：同消息 URL 去重（保序）
  const seenUrl = new Set<string>()
  const uniqueMatches = matches.filter((m) => {
    const key = m.url.replace(/\/+$/, '')
    if (seenUrl.has(key)) return false
    seenUrl.add(key)
    return true
  })

  const promises = uniqueMatches.map(async (match) => {
    await limiter.acquire()
    try {
      const platformEnabled = config.platformEnabled?.[match.type] ?? true
      if (!platformEnabled && !match.type.startsWith('custom_')) {
        debugLog('INFO', `平台 ${match.type} 已禁用，跳过链接: ${match.url}`)
        return
      }
      const dedupEnabled = !opts.skipDedup && config.enableDeduplication !== false && config.deduplicationInterval > 0
      const scopeKey = dedupScopeKey(session, match.url)
      if (dedupEnabled) {
        const lastTime = dedupCache.get(scopeKey)
        if (lastTime && (Date.now() - lastTime < config.deduplicationInterval * 1000)) {
          debugLog('INFO', `跳过重复链接: ${match.url}`)
          const shortUrl = match.url.length > 80 ? match.url.slice(0, 80) + '...' : match.url
          const tip = getText(config, 'deduplicationTipText').replace(/\$\{url\}/g, shortUrl).replace(/\$\{interval\}/g, String(config.deduplicationInterval))
          await sendWithTimeout(rt, session, tip).catch(() => {})
          return
        }
      }
      debugLog('INFO', `解析链接: ${match.url} (${match.type})`)
      const platformConf = getPlatformConfig(rt, match.type)
      const result = await processSingleUrl(rt, match.url, match.type, platformConf.fieldMapping, platformConf)
      if (result.success) {
        if (dedupEnabled) {
          // 去重层②：内容指纹按会话隔离；不同链接相同内容只发首个
          const fp = dedupScopeKey(session, contentFingerprint(result.data.parsed))
          const lastDedup = contentDedupCache.get(fp)
          if (lastDedup && (Date.now() - lastDedup < config.deduplicationInterval * 1000)) {
            debugLog('INFO', `跳过重复内容: ${match.url}`)
            return
          }
          contentDedupCache.set(fp, Date.now())
          dedupCache.set(scopeKey, Date.now())
        }
        items.push(await processItem(rt, session, match.type, result.data.text, result.data.parsed))
      } else {
        const displayUrl = match.url.length > 80 ? match.url.slice(0, 80) + '...' : match.url
        const item = getText(config, 'parseErrorItemFormat').replace(/\$\{url\}/g, displayUrl).replace(/\$\{msg\}/g, result.msg)
        errors.push(item)
      }
    } finally {
      limiter.release()
    }
  })
  await Promise.all(promises)

  if (errors.length) await sendWithTimeout(rt, session, `${getText(config, 'parseErrorPrefix')}\n${errors.join('\n')}`)
  if (!items.length) return

  const forwardAllowed = config.enableForward && (session.platform === 'onebot' || session.platform === 'satori')

  if (forwardAllowed) {
    await sendForward(rt, session, items)
    debugLog('INFO', '处理完成（合并转发）')
    return
  }

  if (config.sendStrategy === 'split') {
    for (const item of items) await sendSplit(rt, session, item, buildTokenHint(rt, item))
    debugLog('INFO', '处理完成（逐条）')
    return
  }

  // single（默认）：单条整合，失败降级 split（转发不可用）
  for (const item of items) {
    const ok = canSingle(rt, item) ? await sendSingle(rt, session, item, session?.messageId) : false
    if (!ok) await sendSplit(rt, session, item, buildTokenHint(rt, item))
  }
  debugLog('INFO', '处理完成')
}
