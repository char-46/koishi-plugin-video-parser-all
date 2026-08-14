import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import type { ParsedData, LinkMatch } from '../types'
import { ConcurrencyLimiter } from '../utils/concurrency'
import { logger, debugLog } from '../utils/logger'
import { delay, contentFingerprint, getText } from '../utils/common'
import { buildForwardNode } from './forward'
import { sendWithTimeout, sendMedia } from './sender'
import { getPlatformConfig } from '../platforms/custom'
import { processSingleUrl } from '../engine/fetcher'

export async function flush(rt: ParserRuntime, session: any, matches: LinkMatch[]) {
  const { config, dedupCache, contentDedupCache } = rt
  debugLog('INFO', `开始解析 ${matches.length} 个链接`)
  const items: { text: string; parsed: ParsedData }[] = []
  const errors: string[] = []
  const limiter = new ConcurrencyLimiter(config.maxConcurrent || 3)
  const promises = matches.map(async (match) => {
    await limiter.acquire()
    try {
      const platformEnabled = config.platformEnabled?.[match.type] ?? true
      if (!platformEnabled && !match.type.startsWith('custom_')) {
        debugLog('INFO', `平台 ${match.type} 已禁用，跳过链接: ${match.url}`)
        return
      }
      if (config.enableDeduplication !== false && config.deduplicationInterval > 0) {
        const lastTime = dedupCache.get(match.url)
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
      const fieldMapping = platformConf.fieldMapping
      const result = await processSingleUrl(rt, match.url, match.type, fieldMapping, platformConf)
      if (result.success) {
        if (config.enableDeduplication !== false && config.deduplicationInterval > 0) {
          const fp = contentFingerprint(result.data.parsed)
          const lastDedup = contentDedupCache.get(fp)
          if (lastDedup && (Date.now() - lastDedup < config.deduplicationInterval * 1000)) {
            debugLog('INFO', `跳过重复内容: ${match.url}`)
            return
          }
          contentDedupCache.set(fp, Date.now())
          dedupCache.set(match.url, Date.now())
        }
        items.push(result.data)
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

  const totalItems = items.length
  const enableForward = config.enableForward && (session.platform === 'onebot' || session.platform === 'satori')
  const botName = config.botName || '视频解析机器人'
  if (enableForward) {
    const forwardMessages: any[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const p = item.parsed
      const textWithIndex = (totalItems > 1) ? `【${i + 1}/${totalItems}】\n${item.text}` : item.text
      let text = textWithIndex
      if (config.showAuthorAvatar && p.avatar && config.showAuthorAvatarText) {
        text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
      }
      if (text && config.showImageText) {
        forwardMessages.push(buildForwardNode(session, text, botName))
      }
      if (config.showAuthorAvatar && p.avatar) {
        forwardMessages.push(buildForwardNode(session, h.image(p.avatar), botName))
      }
      if (p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
        if (config.showCoverText) {
          forwardMessages.push(buildForwardNode(session, config.coverText || '封面：', botName))
        }
        forwardMessages.push(buildForwardNode(session, h.image(p.cover), botName))
      }
      if (config.showMusicCover && p.music.cover) {
        forwardMessages.push(buildForwardNode(session, h.image(p.music.cover), botName))
      }
      if (p.type === 'live_photo' && p.live_photo?.length) {
        for (const lp of p.live_photo) {
          forwardMessages.push(buildForwardNode(session, h.image(lp.image), botName))
        }
      } else if (p.type === 'image' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
        const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? [])
        for (const imgUrl of imageUrls) {
          forwardMessages.push(buildForwardNode(session, h.image(imgUrl), botName))
        }
      }
      if (p.video && p.type !== 'live' && p.type !== 'live_photo') {
        forwardMessages.push(buildForwardNode(session, h.video(p.video), botName))
      }
      if (config.showMusicVoice && p.music.url) {
        forwardMessages.push(buildForwardNode(session, h.audio(p.music.url), botName))
      }
    }

    const MAX_NODES = 50
    for (let i = 0; i < forwardMessages.length; i += MAX_NODES) {
      const batch = forwardMessages.slice(i, i + MAX_NODES)
      try {
        await sendWithTimeout(rt, session, h('message', { forward: true }, batch), config.retryTimes)
      } catch (err) {
        debugLog('ERROR', '合并转发失败，降级逐条发送:', err)
        for (const node of batch) {
          await sendWithTimeout(rt, session, node.data.content).catch(() => {})
          await delay(300)
        }
      }
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const p = item.parsed
      const textWithIndex = (totalItems > 1) ? `【${i + 1}/${totalItems}】\n${item.text}` : item.text
      let text = textWithIndex
      if (config.showAuthorAvatar && p.avatar && config.showAuthorAvatarText) {
        text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
      }
      if (text && config.showImageText) { await sendWithTimeout(rt, session, text); await delay(300) }
      if (config.showAuthorAvatar && p.avatar) {
        await sendMedia(rt, session, p.avatar, 'image', config.showAuthorAvatarFile).catch(() => {})
        await delay(300)
      }
      if (p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
        if (config.showCoverText) await sendWithTimeout(rt, session, config.coverText || '封面：')
        await sendMedia(rt, session, p.cover, 'image', config.showCoverFile).catch(() => {})
        await delay(300)
      }
      if (config.showMusicCover && p.music.cover) {
        await sendMedia(rt, session, p.music.cover, 'image', true).catch(() => {})
        await delay(300)
      }
      if (p.type === 'live_photo' && p.live_photo?.length) {
        for (const lp of p.live_photo) {
          await sendMedia(rt, session, lp.image, 'image', config.showImageFileNew).catch(() => {})
          await delay(500)
        }
      } else if (p.type === 'image' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
        const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? [])
        for (let j = 0; j < imageUrls.length; j++) {
          logger.info(`[发送] 图片 ${j+1}/${imageUrls.length}`)
          await sendMedia(rt, session, imageUrls[j], 'image', config.showImageFileNew).catch(() => {})
          await delay(1000)
        }
      }
      if (p.type === 'live' && config.sendLiveMessage) {
        await sendWithTimeout(rt, session, '直播进行中，无法发送视频流。').catch(() => {})
      }
      if (config.showMusicVoice && p.music.url) {
        await sendMedia(rt, session, p.music.url, 'audio', config.showMusicVoiceFile).catch(() => {})
        await delay(300)
      }
    }
  }
  debugLog('INFO', '处理完成')
}
