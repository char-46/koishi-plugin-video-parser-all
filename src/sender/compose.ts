/**
 * 发送编排：把一条解析结果拆成「语义单元」（MessageUnit），按发送策略消费。
 *
 * 每个单元带 mergeable 标记：
 * - mergeable=true：概述文字/头像/封面/图片/音乐/提示文案（含受限视频与混淆图提示），
 *   全部并入首条消息——提示说清楚「怎么取」
 * - mergeable=false：后面跟着的干脆的可领取形式，不含其他内容：
 *   视频文件 / 「取视频 <token>」/ 「解混淆 <token>[混淆图]」
 *
 * 消费方式见 flush.ts：
 * - sendSingle：合并所有 mergeable 单元为一条，mergeable=false 单元逐条
 * - sendSplit：每个单元一条
 * - sendForward：每个单元一个转发气泡（仅一条时不打包直接发送）
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import type { ParsedData } from '../types'
import { delay } from '../utils/common'
import { sendWithTimeout } from './sender'
import type { ImageOutcome, VideoOutcome } from '../services/nsfw/gate'

export interface ProcessedItem {
  text: string
  parsed: ParsedData
  images: ImageOutcome[]
  avatar: ImageOutcome
  cover: ImageOutcome | null
  video: VideoOutcome
}

/** 一个待发送的语义单元 */
export interface MessageUnit {
  content: h[]
  /** true=可合并进单条消息；false=必须独立发送（视频文件/混淆图/取件码） */
  mergeable: boolean
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

/** 把 ProcessedItem 拆成有序语义单元 */
export function buildUnits(rt: ParserRuntime, item: ProcessedItem): MessageUnit[] {
  const { config } = rt
  const p = item.parsed
  const units: MessageUnit[] = []
  const push = (content: h[], mergeable: boolean) => { if (content.length) units.push({ content, mergeable }) }

  // ① 概述文字
  if (item.text && config.showImageText) push([h.text(item.text)], true)

  // ② 头像（非混淆）
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && item.avatar.kind !== 'scrambled' && item.avatar.url) {
    push([h.image(item.avatar.url)], true)
  }
  // ③ 封面（非混淆）
  if (item.cover && item.cover.kind === 'raw' && item.cover.url
      && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
    const c: h[] = []
    if (config.showCoverText) c.push(h.text(config.coverText || '封面：'))
    c.push(h.image(item.cover.url))
    push(c, true)
  }
  // ④ 音乐封面
  if (config.showMusicCover && p.music.cover) push([h.image(p.music.cover)], true)

  // ⑤ 非混淆图片
  for (const img of item.images) {
    if (img.kind === 'raw' && img.url) push([h.image(img.url)], true)
    else if (img.kind === 'link' && img.url) push([h.text(`图片链接：${img.url}`)], true)
  }

  // ⑥ 合规视频（必须独立，含视频自动分条）
  if (p.video && p.type !== 'live' && p.type !== 'live_photo' && item.video.kind === 'raw' && item.video.url) {
    push([config.showVideoFile !== false ? h.video(item.video.url) : h.text(`视频链接：${item.video.url}`)], false)
  }

  // ⑦ 音乐语音
  if (config.showMusicVoice && p.music.url) push([h.audio(p.music.url)], true)
  // ⑧ 直播提示
  if (p.type === 'live' && config.sendLiveMessage) push([h.text('直播进行中，无法发送视频流。')], true)

  // ⑨ 受限视频：提示并入首条消息；取件码独立为干脆的「取视频 <token>」
  const videoHint = buildVideoHint(rt, item)
  if (videoHint) push([h.text(videoHint)], true)
  if (item.video.kind === 'card' && item.video.token) push([h.text(`取视频 ${item.video.token}`)], false)

  // ⑩ 混淆图：提示并入首条消息；独立消息为干脆的「解混淆 <token>[混淆图]」
  for (const img of [item.avatar, item.cover, ...item.images]) {
    if (img?.kind === 'scrambled' && img.buffer) {
      if (img.token) push([h.text(buildImageHint(rt, img.token))], true)
      const c: h[] = []
      if (img.token) c.push(h.text(`解混淆 ${img.token}`))
      c.push(h.image(img.buffer, 'image/png'))
      push(c, false)
    }
  }

  return units
}

/** 发送单个单元；视频发送失败降级为链接文字 */
async function sendContent(rt: ParserRuntime, session: any, content: h[], quoteId?: string): Promise<void> {
  const toSend = quoteId ? [h.quote(quoteId), ...content] : content
  await sendWithTimeout(rt, session, toSend).catch(async () => {
    const links = content.map((e: any) => e.type === 'video' && e.attrs?.src ? h.text(`视频链接：${e.attrs.src}`) : e)
    await sendWithTimeout(rt, session, quoteId ? [h.quote(quoteId), ...links] : links).catch(() => {})
  })
}

/**
 * 单条整合：合并所有 mergeable 单元为一条消息（图片超限则退化为逐条），
 * mergeable=false 单元独立逐条。
 */
export async function sendSingle(
  rt: ParserRuntime,
  session: any,
  item: ProcessedItem,
  opts: { quoteId?: string } = {},
): Promise<void> {
  const units = buildUnits(rt, item)
  const mergeable = units.filter(u => u.mergeable)
  const standalone = units.filter(u => !u.mergeable)
  const maxImages = rt.config.singleSendMaxImages || 10

  let quote = opts.quoteId
  if (mergeable.length) {
    const imgCount = mergeable.reduce((n, u) => n + u.content.filter((e: any) => e.type === 'img').length, 0)
    if (imgCount <= maxImages) {
      const merged = mergeable.flatMap(u => u.content)
      await sendContent(rt, session, merged, quote)
      await delay(300)
      quote = undefined // 仅首条引用原消息
    } else {
      for (const u of mergeable) {
        await sendContent(rt, session, u.content, quote)
        await delay(300)
        quote = undefined
      }
    }
  }

  for (const u of standalone) {
    await sendContent(rt, session, u.content, quote)
    await delay(300)
    quote = undefined
  }
}

/** 逐条发送：每个语义单元一条消息 */
export async function sendSplit(
  rt: ParserRuntime,
  session: any,
  item: ProcessedItem,
  opts: { quoteId?: string } = {},
): Promise<void> {
  const units = buildUnits(rt, item)
  let quote = opts.quoteId
  for (const u of units) {
    await sendContent(rt, session, u.content, quote)
    await delay(300)
    quote = undefined
  }
}
