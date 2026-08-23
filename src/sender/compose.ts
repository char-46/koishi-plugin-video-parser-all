/**
 * 整合发送：单条解析结果构建元素数组一次发出。
 *
 * 混淆图片占位符策略：原位文字消息用〔图片已混淆〕占位（干净，
 * 不掺杂二进制图），混淆后的图片与解混淆 token 另起一条发送，
 * 群友可私聊取回。非混淆图片照常内联。
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

/** 是否有任意混淆内容（图/视频） */
function hasScrambled(item: ProcessedItem): boolean {
  return item.scrambleTokens.length > 0
    || (item.avatar.kind === 'scrambled')
    || (item.cover?.kind === 'scrambled')
    || item.images.some(i => i.kind === 'scrambled')
    || item.video.kind === 'card'
}

/**
 * 构建主消息元素（文本消息部分）：
 * - 原始图片照常内联 h.image(url)
 * - 混淆图片原位用文字占位符 〔图片已混淆〕，干净不掺杂二进制图
 */
export function buildMainElements(rt: ParserRuntime, item: ProcessedItem): h[] {
  const { config } = rt
  const p = item.parsed
  const out: h[] = []

  let text = item.text
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
    text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
  }
  if (text && config.showImageText) out.push(h.text(text))

  let scrambledCount = 0
  const pushImage = (img: ImageOutcome) => {
    if (img.kind === 'drop') return
    if (img.kind === 'raw' && img.url) { out.push(h.image(img.url)); return }
    if (img.kind === 'scrambled') { scrambledCount++; out.push(h.text(`〔图片已混淆 ${scrambledCount}〕`)); return }
    if (img.kind === 'link' && img.url) out.push(h.text(`图片链接：${img.url}`))
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

/**
 * 构建混淆附加消息（独立两条）：
 * - 第一条：token hint 文字（引导私聊解码）
 * - 第二条：所有混淆图片 buffer（群友可直接转发到私聊解码）
 * 返回 [hintText?, images?] 两个消息（null 则跳过）
 */
export function buildScrambledMessages(rt: ParserRuntime, item: ProcessedItem, quoteId?: string): { hintMsg: h[] | null; imgMsg: h[] | null } {
  const scrambledImages = [
    item.avatar, item.cover,
    ...item.images,
  ].filter((img): img is ImageOutcome => img?.kind === 'scrambled' && !!img.buffer)

  const hint = buildTokenHint(rt, item)
  let hintMsg: h[] | null = null
  if (hint) {
    hintMsg = [h.text(hint)]
    if (quoteId) hintMsg.unshift(h.quote(quoteId))
  }

  let imgMsg: h[] | null = null
  if (scrambledImages.length) {
    imgMsg = scrambledImages.map((img) => h.image(img!.buffer!, 'image/png'))
  }

  return { hintMsg, imgMsg }
}

/** 单条消息是否可行（无视频元素、图片数未超限、无混淆内容） */
export function canSingle(rt: ParserRuntime, item: ProcessedItem): boolean {
  if (hasScrambled(item)) return false // 有混淆内容时主消息干净，附加消息另发
  if (item.video.kind !== 'raw') return false
  const imageCount = item.images.filter((i) => i.kind !== 'drop').length
    + (item.cover && item.cover.kind !== 'drop' ? 1 : 0)
    + (item.avatar.kind !== 'drop' ? 1 : 0)
  if (imageCount > (rt.config.singleSendMaxImages || 10)) return false
  if (item.parsed.video && item.parsed.type !== 'live' && item.parsed.type !== 'live_photo') return false
  return true
}

/** 混淆提示文字（图片 token / 视频 token + 暂存绝对时间） */
export function buildTokenHint(rt: ParserRuntime, item: ProcessedItem): string {
  const nsfw = rt.config.nsfwPolicy || {}
  const lines: string[] = []
  const imgToken = item.scrambleTokens[0]
  if (imgToken) {
    lines.push(String(nsfw.tokenHintText || '').replace(/\$\{token\}/g, imgToken))
  }
  if (item.video.kind === 'card' && item.video.token) {
    const ttl = rt.config.nsfwVault?.ttlMinutes || 30
    const until = new Date(Date.now() + ttl * 60000)
    const untilStr = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
    lines.push(String(nsfw.videoCardHint || '')
      .replace(/\$\{token\}/g, item.video.token)
      .replace(/\$\{until\}/g, untilStr)
      .replace(/\$\{ttl\}/g, String(ttl)))
  } else if (item.video.kind === 'link' && item.video.url) {
    lines.push(`受限视频未在群内发送。视频链接：${item.video.url}`)
  } else if (item.video.kind === 'drop' && item.parsed.video) {
    lines.push('受限视频未在群内发送。')
  }
  return lines.filter(Boolean).join('\n')
}

/** 单条整合发送（主消息 + 混淆 hint + 混淆图，分三条发送以兼容各类适配器）；返回是否成功 */
export async function sendSingle(rt: ParserRuntime, session: any, item: ProcessedItem, quoteId?: string): Promise<boolean> {
  const mainElements = buildMainElements(rt, item)
  const { hintMsg, imgMsg } = buildScrambledMessages(rt, item, quoteId)
  if (!mainElements.length && !hintMsg && !imgMsg) return true
  try {
    if (mainElements.length) await sendWithTimeout(rt, session, mainElements)
    if (hintMsg) await sendWithTimeout(rt, session, hintMsg)
    if (imgMsg) await sendWithTimeout(rt, session, imgMsg)
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
