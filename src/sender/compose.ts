/**
 * 整合发送：单条解析结果构建元素数组一次发出。
 *
 * 降级链：图片过多 / 含视频 → 合并转发（onebot/satori + enableForward）→ 逐条（split.ts）。
 * 消费 gate 处理后的媒体（raw url / scrambled buffer / 视频 card）。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import type { ParsedData } from '../types'
import { delay } from '../utils/common'
import { debugLog } from '../utils/logger'
import { sendWithTimeout } from './sender'
import type { ImageOutcome, VideoOutcome } from '../nsfw/gate'

export interface ProcessedItem {
  text: string
  parsed: ParsedData
  images: ImageOutcome[]
  avatar: ImageOutcome
  cover: ImageOutcome | null
  video: VideoOutcome
  scrambleTokens: string[]
}

/** 组装单条结果的元素数组（不发送） */
export function buildElements(rt: ParserRuntime, item: ProcessedItem): h[] {
  const { config } = rt
  const p = item.parsed
  const out: h[] = []

  let text = item.text
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
    text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
  }
  if (text && config.showImageText) out.push(h.text(text))

  const pushImage = (img: ImageOutcome) => {
    if (img.kind === 'drop') return
    if (img.kind === 'raw' && img.url) out.push(h.image(img.url))
    else if (img.kind === 'scrambled' && img.buffer) out.push(h.image(img.buffer, 'image/png'))
    else if (img.kind === 'link' && img.url) out.push(h.text(`图片链接：${img.url}`))
  }

  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop') pushImage(item.avatar)
  if (item.cover && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
    if (config.showCoverText) out.push(h.text(config.coverText || '封面：'))
    pushImage(item.cover)
  }
  for (const img of item.images) pushImage(img)
  if (p.type === 'live' && config.sendLiveMessage) out.push(h.text('直播进行中，无法发送视频流。'))
  if (config.showMusicVoice && p.music.url) out.push(h.audio(p.music.url))

  return out
}

/** 单条消息是否可行（无视频元素、图片数未超限） */
export function canSingle(rt: ParserRuntime, item: ProcessedItem): boolean {
  if (item.video.kind !== 'raw') return false // card/link/drop 不发视频元素，走文字卡片
  const imageCount = item.images.filter((i) => i.kind !== 'drop').length
    + (item.cover && item.cover.kind !== 'drop' ? 1 : 0)
    + (item.avatar.kind !== 'drop' ? 1 : 0)
  if (imageCount > (rt.config.singleSendMaxImages || 10)) return false
  if (item.parsed.video && item.parsed.type !== 'live' && item.parsed.type !== 'live_photo' && item.video.kind === 'raw') return false // 含视频元素回退
  return true
}

/** 混淆提示文字（图片 token / 视频 token / 两者） */
export function buildTokenHint(rt: ParserRuntime, item: ProcessedItem): string {
  const nsfw = rt.config.nsfwPolicy || {}
  const lines: string[] = []
  const imgToken = item.scrambleTokens[0]
  if (imgToken) {
    lines.push(String(nsfw.tokenHintText || '').replace(/\$\{token\}/g, imgToken))
  }
  if (item.video.kind === 'card' && item.video.token) {
    const ttl = (rt.config.nsfwVault?.ttlMinutes) || 30
    lines.push(String(nsfw.videoCardHint || '').replace(/\$\{token\}/g, item.video.token).replace(/\$\{ttl\}/g, String(ttl)))
  } else if (item.video.kind === 'link' && item.video.url) {
    lines.push(`检测到受限视频，未在群内发送。视频链接：${item.video.url}`)
  } else if (item.video.kind === 'drop' && item.parsed.video) {
    lines.push('检测到受限视频，未在群内发送。')
  }
  return lines.filter(Boolean).join('\n')
}

/** 单条整合发送；返回是否成功 */
export async function sendSingle(rt: ParserRuntime, session: any, item: ProcessedItem, quoteId?: string): Promise<boolean> {
  const elements = buildElements(rt, item)
  const hint = buildTokenHint(rt, item)
  if (hint) elements.push(h.text('\n' + hint))
  if (quoteId && (item.video.kind !== 'raw' || item.scrambleTokens.length)) {
    // 受限内容提示需定向到请求者：整条引用请求者消息
    elements.unshift(h.quote(quoteId))
  }
  if (!elements.length) return true
  try {
    await sendWithTimeout(rt, session, elements)
    return true
  } catch (e) {
    debugLog('WARN', '单条整合发送失败，回退分条/转发:', e)
    return false
  }
}

/** 原有的逐条延迟节奏（供 split 模式复用） */
export async function pace(ms: number): Promise<void> {
  await delay(ms)
}
