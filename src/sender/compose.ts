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
  scrambleTokens: string[]
  /**
   * 发送模式（由 processItem 计算，发送层只读不决策）：
   * - integrated：无混淆内容，所有元素可合并为一条消息
   * - decomposed：有混淆图/视频取件码，每个语义单元必须独立发送
   *   （用户需要逐条复制/转发 hint 文字、逐张保存混淆图到私聊解码）
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

/** 混淆 hint 文字（图片 token / 视频 token + 暂存截止时间） */
export function buildTokenHint(rt: ParserRuntime, item: ProcessedItem): string {
  const nsfw = rt.config.nsfwPolicy || {}
  const lines: string[] = []
  const imgToken = item.scrambleTokens[0]
  if (imgToken) lines.push(String(nsfw.tokenHintText || '').replace(/\$\{token\}/g, imgToken))
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

function pushRawImages(out: h[], imgs: ImageOutcome[]): void {
  for (const img of imgs) {
    if (img.kind === 'drop') continue
    if (img.kind === 'raw' && img.url) out.push(h.image(img.url))
    else if (img.kind === 'link' && img.url) out.push(h.text(`图片链接：${img.url}`))
  }
}

/**
 * 构建一条完整文字消息（不含二进制图，混淆图用 〔图片已混淆〕 占位）。
 * 仅在单条模式下使用；分条模式直接发 item.text。
 */
export function buildTextMessage(item: ProcessedItem, config: any): h | null {
  let text = item.text
  const p = item.parsed
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
    text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
  }
  if (!text || !config.showImageText) return null
  let n = 0
  // 在文字里内嵌占位符（混淆图）或内联原图（非混淆）
  const addCover = item.cover && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live'
  if (addCover) {
    text += '\n' + (config.showCoverText ? (config.coverText || '封面：') : '')
    if (item.cover!.kind === 'scrambled') { n++; text += `〔图片已混淆 ${n}〕` }
    else if (item.cover!.kind === 'raw' && item.cover!.url) text += `\n${item.cover!.url}`
    else if (item.cover!.kind === 'link' && item.cover!.url) text += `\n图片链接：${item.cover!.url}`
  }
  for (const img of item.images) {
    if (img.kind === 'drop') continue
    if (img.kind === 'scrambled') { n++; text += `\n〔图片已混淆 ${n}〕` }
    else if (img.kind === 'raw' && img.url) text += `\n${img.url}`
    else if (img.kind === 'link' && img.url) text += `\n图片链接：${img.url}`
  }
  return h.text(text)
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

  // ① 文字消息
  const textMsg = item.sendMode === 'decomposed'
    ? buildTextMessage(item, config)   // decomposed：含占位符 〔图片已混淆 N〕
    : (item.text && config.showImageText ? h.text(item.text) : null) // integrated：纯文字
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

  // ③ 混淆 hint（纯文字，独立一条，可复制/转发）
  if (item.sendMode === 'decomposed') {
    const hint = buildTokenHint(rt, item)
    if (hint) {
      const hintH = [h.text(hint)]
      if (opts.quoteId) hintH.unshift(h.quote(opts.quoteId))
      await sendWithTimeout(rt, session, hintH)
      await delay(500)
    }

    // ④ 混淆图（每张独立消息，可逐张保存转发到私聊解码）
    const scrambledImages = [item.avatar, item.cover, ...item.images]
      .filter((img): img is ImageOutcome => img?.kind === 'scrambled' && !!img.buffer)
    for (const img of scrambledImages) {
      await sendWithTimeout(rt, session, h.image(img.buffer!, 'image/png')).catch(() => {})
      await delay(300)
    }
  }
}
