import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { sendWithTimeout, sendMedia } from './sender'
import { delay } from '../utils/common'
import { debugLog } from '../utils/logger'
import type { ProcessedItem } from './compose'
import { buildTokenHint } from './compose'
import type { ImageOutcome } from '../nsfw/gate'

export function buildForwardNode(session: any, content: any, botName: string) {
  let messageContent: any[]
  if (Array.isArray(content)) messageContent = content
  else if (content && typeof content === 'object' && content.type) messageContent = [content]
  else messageContent = [h.text(String(content))]
  return h('node', { user: { nickname: botName.substring(0, 15), user_id: session.selfId } }, messageContent)
}

function imageNode(img: ImageOutcome): h | null {
  if (img.kind === 'drop') return null
  if (img.kind === 'scrambled' && img.buffer) return h.image(img.buffer, 'image/png')
  if (img.kind === 'raw' && img.url) return h.image(img.url)
  if (img.kind === 'link' && img.url) return h.text(`图片链接：${img.url}`)
  return null
}

/** 合并转发模式（消费 gate 处理后的 item） */
export async function sendForward(rt: ParserRuntime, session: any, items: ProcessedItem[]): Promise<void> {
  const { config } = rt
  const botName = config.botName || '视频解析机器人'
  const nodes: any[] = []
  const total = items.length

  for (let i = 0; i < total; i++) {
    const item = items[i]
    const p = item.parsed
    const withIndex = (s: string) => (total > 1 ? `【${i + 1}/${total}】\n${s}` : s)
    let text = withIndex(item.text)
    if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
      text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
    }
    if (text && config.showImageText) nodes.push(buildForwardNode(session, text, botName))
    if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop') {
      const n = imageNode(item.avatar)
      if (n) nodes.push(buildForwardNode(session, n, botName))
    }
    if (item.cover && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
      if (config.showCoverText) nodes.push(buildForwardNode(session, config.coverText || '封面：', botName))
      const n = imageNode(item.cover)
      if (n) nodes.push(buildForwardNode(session, n, botName))
    }
    if (config.showMusicCover && p.music.cover) nodes.push(buildForwardNode(session, h.image(p.music.cover), botName))
    for (const img of item.images) {
      const n = imageNode(img)
      if (n) nodes.push(buildForwardNode(session, n, botName))
    }
    if (p.video && item.video.kind === 'raw' && item.video.url) {
      nodes.push(buildForwardNode(session, h.video(item.video.url), botName))
    }
    if (config.showMusicVoice && p.music.url) nodes.push(buildForwardNode(session, h.audio(p.music.url), botName))
    const hint = buildTokenHint(rt, item)
    if (hint) nodes.push(buildForwardNode(session, hint, botName))
  }

  const MAX_NODES = 50
  for (let i = 0; i < nodes.length; i += MAX_NODES) {
    const batch = nodes.slice(i, i + MAX_NODES)
    try {
      await sendWithTimeout(rt, session, h('message', { forward: true }, batch), config.retryTimes)
    } catch (err) {
      debugLog('ERROR', '合并转发失败，降级逐条发送:', err)
      for (const item of items) {
        // 降级：仅发文字与媒体链接，避免逐条重发全部媒体造成刷屏
        await sendWithTimeout(rt, session, item.text || '').catch(() => {})
        const hint = buildTokenHint(rt, item)
        if (hint) await sendWithTimeout(rt, session, hint).catch(() => {})
        await delay(300)
      }
      return
    }
  }
}

/** 保留旧导出（sendMedia 引用兼容） */
export { sendMedia }
