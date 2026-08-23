/**
 * 发送编排：把一条解析结果拆成独立消息，每条只含一个语义单元。
 *
 * 规则：
 * ① 文字消息（占位符 〔图片已混淆 N〕替代混淆图，原始图照常内联）
 * ② 视频（仅合规视频，type!=live/live_photo）
 * ③ 混淆 hint（纯文字，可复制/转发，附 token + 引用请求者）
 * ④ 混淆图 buffer（每张独立消息，可逐张保存转发到私聊解码）
 * ⑤ 视频取件提示（纯文字，附 token + 暂存截止时间）
 *
 * 非混淆内容照常内联发送（头像/封面/音乐封面/图集/音乐语音）。
 * 降级链：单条整合→合并转发→逐条，见 flush.ts。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import type { ParsedData } from '../types'
import { delay } from '../utils/common'
import { debugLog } from '../utils/logger'
import { sendWithTimeout } from './sender'
import type { ImageOutcome, VideoOutcome } from '../services/nsfw/gate'

export interface ProcessedItem {
  text: string
  parsed: ParsedData
  images: ImageOutcome[]
  avatar: ImageOutcome
  cover: ImageOutcome | null
  video: VideoOutcome
  /**
   * 发送模式（由 processItem 计算，发送层只读不决策）：
   * - integrated：无混淆内容，所有元素可合并为一条消息
   * - decomposed：有混淆图/视频取件码，每个语义单元必须独立发送
   */
  sendMode: 'integrated' | 'decomposed'
}

/** 单条发送是否可行（无视频元素、图片不超限、无混淆） */
export function canSingle(rt: ParserRuntime, item: ProcessedItem): boolean {
  if (item.sendMode === 'decomposed') return false
  const n = item.images.filter(i => i.kind !== 'drop').length
    + (item.cover && item.cover.kind !== 'drop' ? 1 : 0)
    + (item.avatar.kind !== 'drop' ? 1 : 0)
  if (n > (rt.config.singleSendMaxImages || 10)) return false
  if (item.parsed.video && item.parsed.type !== 'live' && item.parsed.type !== 'live_photo') return false
  return true
}

/** 单张混淆图的解混淆提示（附该图 token） */
export function buildImageHint(rt: ParserRuntime, token: string): string {
  const nsfw = rt.config.nsfwPolicy || {}
  return String(nsfw.tokenHintText || '').replace(/\$\{token\}/g, token)
}

/** 受限视频取件提示（附 token + 暂存截止时间） */
export function buildVideoHint(rt: ParserRuntime, item: ProcessedItem): string {
  const nsfw = rt.config.nsfwPolicy || {}
  if (item.video.kind === 'card' && item.video.token) {
    const ttl = rt.config.nsfwVault?.ttlMinutes || 30
    const until = new Date(Date.now() + ttl * 60000)
    const untilStr = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
    return String(nsfw.videoCardHint || '')
      .replace(/\$\{token\}/g, item.video.token)
      .replace(/\$\{until\}/g, untilStr)
      .replace(/\$\{ttl\}/g, String(ttl))
  }
  if (item.video.kind === 'link' && item.video.url) return `受限视频未在群内发送。视频链接：${item.video.url}`
  if (item.video.kind === 'drop' && item.parsed.video) return '受限视频未在群内发送。'
  return ''
}

/**
 * 把一条解析结果拆成独立消息并逐条发送。
 * 每次 sendWithTimeout 只发一个语义单元，适配器不可合并。
 * sendMode 由 processItem 计算，发送层只读不决策：
 * - integrated：无混淆，文字消息不内联占位符
 * - decomposed：有混淆图/视频取件码，文字消息含占位符，hint 和混淆图各自独立消息
 */
export async function sendDecomposed(
  rt: ParserRuntime,
  session: any,
  item: ProcessedItem,
  opts: { quoteId?: string } = {},
): Promise<void> {
  const { config } = rt
  const p = item.parsed

  // ① 概述文字消息（概述；混淆图/取件码在后续消息各带提示，此处不再放占位符）
  const textMsg = item.text && config.showImageText ? h.text(item.text) : null
  if (textMsg) {
    const toSend = opts.quoteId ? [h.quote(opts.quoteId), textMsg] : [textMsg]
    await sendWithTimeout(rt, session, toSend)
    await delay(300)
  }

  // 头像（非混淆时单独一条）
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && item.avatar.kind !== 'scrambled') {
    const avatarH = item.avatar.url ? h.image(item.avatar.url) : null
    if (avatarH) { await sendWithTimeout(rt, session, avatarH).catch(() => {}); await delay(300) }
  }
  // 非混淆封面单独一条
  if (item.cover && item.cover.kind === 'raw' && item.cover.url
      && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
    if (config.showCoverText) { await sendWithTimeout(rt, session, config.coverText || '封面：'); await delay(200) }
    await sendWithTimeout(rt, session, h.image(item.cover.url)).catch(() => {})
    await delay(300)
  }
  // 音乐封面
  if (config.showMusicCover && p.music.cover) {
    await sendWithTimeout(rt, session, h.image(p.music.cover)).catch(() => {})
    await delay(300)
  }
  // 非混淆图片
  {
    const rawImages = item.images.filter(i => i.kind === 'raw' && i.url)
    for (const img of rawImages) {
      await sendWithTimeout(rt, session, h.image(img.url!)).catch(() => {})
      await delay(500)
    }
    // link 类型
    for (const img of item.images.filter(i => i.kind === 'link' && i.url)) {
      await sendWithTimeout(rt, session, `图片链接：${img.url}`).catch(() => {})
      await delay(300)
    }
  }

  // ② 合规视频
  if (p.video && p.type !== 'live' && p.type !== 'live_photo' && item.video.kind === 'raw' && item.video.url) {
    if (config.showVideoFile !== false) {
      await sendWithTimeout(rt, session, h.video(item.video.url)).catch(async () => {
        await sendWithTimeout(rt, session, `视频链接：${item.video.url}`).catch(() => {})
      })
    } else {
      await sendWithTimeout(rt, session, `视频链接：${item.video.url}`).catch(() => {})
    }
  }

  // 音乐语音
  if (config.showMusicVoice && p.music.url) {
    await sendWithTimeout(rt, session, h.audio(p.music.url)).catch(() => {})
    await delay(300)
  }
  if (p.type === 'live' && config.sendLiveMessage) {
    await sendWithTimeout(rt, session, '直播进行中，无法发送视频流。')
  }

  // ③ 视频取件提示（纯文字，附 token + 暂存截止时间）
  if (item.sendMode === 'decomposed') {
    const videoHint = buildVideoHint(rt, item)
    if (videoHint) {
      const hintH = [h.text(videoHint)]
      if (opts.quoteId) hintH.unshift(h.quote(opts.quoteId))
      await sendWithTimeout(rt, session, hintH)
      await delay(500)
    }
  }

  // ④ 混淆图：每张独立消息 = 解混淆提示 + 密钥 + 混淆图（同一消息，转发即可在私聊解码）
  const scrambledImages = [item.avatar, item.cover, ...item.images]
    .filter((img): img is ImageOutcome => img?.kind === 'scrambled' && !!img.buffer)
  for (const img of scrambledImages) {
    const parts: any[] = []
    if (img.token) parts.push(h.text(buildImageHint(rt, img.token)))
    parts.push(h.image(img.buffer!, 'image/png'))
    if (opts.quoteId) parts.unshift(h.quote(opts.quoteId))
    await sendWithTimeout(rt, session, parts).catch(() => {})
    await delay(300)
  }
}
