/**
 * 合并转发模式：每个 item 构建合并转发节点（转发气泡）。
 * 混淆内容占位符 + 独立 hint 节点 + 独立图片节点（与 compose.ts 分解发送一致）。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { sendWithTimeout } from './sender'
import { delay } from '../utils/common'
import { debugLog } from '../utils/logger'
import { buildTokenHint, hasScrambled, type ProcessedItem } from './compose'
import type { ImageOutcome } from '../nsfw/gate'

export function buildForwardNode(session: any, content: any, botName: string) {
  let messageContent: any[]
  if (Array.isArray(content)) messageContent = content
  else if (content && typeof content === 'object' && content.type) messageContent = [content]
  else messageContent = [h.text(String(content))]
  return h('node', { user: { nickname: botName.substring(0, 15), user_id: session.selfId } }, messageContent)
}

function imageNode(img: ImageOutcome, placeholderIndex?: { n: number }): h | null {
  if (img.kind === 'drop') return null
  if (img.kind === 'scrambled' && placeholderIndex) { placeholderIndex.n++; return h.text(`〔图片已混淆 ${placeholderIndex.n}〕`) }
  if (img.kind === 'raw' && img.url) return h.image(img.url)
  if (img.kind === 'link' && img.url) return h.text(`图片链接：${img.url}`)
  return null
}

export async function sendForward(rt: ParserRuntime, session: any, items: ProcessedItem[]): Promise<void> {
  const { config } = rt
  const botName = config.botName || '视频解析机器人'
  const nodes: any[] = []
  const total = items.length

  for (let i = 0; i < total; i++) {
    const item = items[i]
    const p = item.parsed
    const idx = { n: 0 }
    const scrambledBufs: Buffer[] = []

    const withIndex = (s: string) => (total > 1 ? `【${i + 1}/${total}】\n${s}` : s)
    let text = withIndex(item.text)
    if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
      text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
    }
    if (text && config.showImageText) nodes.push(buildForwardNode(session, text, botName))

    const handleImg = (img: ImageOutcome) => {
      if (img.kind === 'drop') return
      if (img.kind === 'scrambled' && img.buffer) {
        idx.n++
        scrambledBufs.push(img.buffer)
        nodes.push(buildForwardNode(session, `〔图片已混淆 ${idx.n}〕`, botName))
        return
      }
      const n = imageNode(img)
      if (n) nodes.push(buildForwardNode(session, n, botName))
    }

    if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop') handleImg(item.avatar)
    if (item.cover && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
      if (config.showCoverText) nodes.push(buildForwardNode(session, config.coverText || '封面：', botName))
      handleImg(item.cover)
    }
    if (config.showMusicCover && p.music.cover) nodes.push(buildForwardNode(session, h.image(p.music.cover), botName))
    for (const img of item.images) handleImg(img)
    if (p.video && p.type !== 'live' && p.type !== 'live_photo' && item.video.kind === 'raw' && item.video.url) {
      nodes.push(buildForwardNode(session, h.video(item.video.url), botName))
    }
    if (config.showMusicVoice && p.music.url) nodes.push(buildForwardNode(session, h.audio(p.music.url), botName))

    // 混淆 hint 独立气泡
    const hint = buildTokenHint(rt, item)
    if (hint) nodes.push(buildForwardNode(session, hint, botName))
    // 混淆图独立气泡（每张图在转发里是一个 node，群友可逐张保存转发）
    if (scrambledBufs.length) {
      for (const buf of scrambledBufs) {
        nodes.push(buildForwardNode(session, h.image(buf, 'image/png'), botName))
      }
    }
  }

  const MAX_NODES = 50
  for (let i = 0; i < nodes.length; i += MAX_NODES) {
    const batch = nodes.slice(i, i + MAX_NODES)
    try {
      await sendWithTimeout(rt, session, h('message', { forward: true }, batch), config.retryTimes)
    } catch (err) {
      debugLog('ERROR', '合并转发失败，降级逐条发送:', err)
      for (const item of items) {
        await sendWithTimeout(rt, session, item.text || '').catch(() => {})
        const hint = buildTokenHint(rt, item)
        if (hint) await sendWithTimeout(rt, session, hint).catch(() => {})
        await delay(300)
      }
      return
    }
  }
}

export { sendMedia } from './sender'
