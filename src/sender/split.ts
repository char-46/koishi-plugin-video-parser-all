/**
 * 逐条分开发送（旧版行为，作为 single 失败且不允许转发时的兜底）。
 * 消费 gate 处理后的 ProcessedItem。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { sendWithTimeout } from './sender'
import { buildTokenHint, pace, type ProcessedItem } from './compose'
import type { ImageOutcome } from '../nsfw/gate'

async function sendImageOutcome(rt: ParserRuntime, session: any, img: ImageOutcome, showFile: boolean): Promise<void> {
  if (img.kind === 'drop') return
  if (img.kind === 'scrambled' && img.buffer) {
    await sendWithTimeout(rt, session, h.image(img.buffer, 'image/png')).catch(() => {})
    return
  }
  const url = img.url || ''
  if (!url) return
  if (img.kind === 'link' || !showFile) {
    await sendWithTimeout(rt, session, `图片链接：${url}`).catch(() => {})
    return
  }
  await sendWithTimeout(rt, session, h.image(url)).catch(async () => {
    await sendWithTimeout(rt, session, `图片链接：${url}`).catch(() => {})
  })
}

export async function sendSplit(rt: ParserRuntime, session: any, item: ProcessedItem, hint: string): Promise<void> {
  const { config } = rt
  const p = item.parsed
  let text = item.text
  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop' && config.showAuthorAvatarText) {
    text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
  }
  if (text && config.showImageText) { await sendWithTimeout(rt, session, text); await pace(300) }

  if (config.showAuthorAvatar && p.avatar && item.avatar.kind !== 'drop') {
    await sendImageOutcome(rt, session, item.avatar, config.showAuthorAvatarFile)
    await pace(300)
  }
  if (item.cover && p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
    if (config.showCoverText) await sendWithTimeout(rt, session, config.coverText || '封面：')
    await sendImageOutcome(rt, session, item.cover, config.showCoverFile)
    await pace(300)
  }
  for (const img of item.images) {
    await sendImageOutcome(rt, session, img, config.showImageFileNew)
    await pace(500)
  }
  if (p.type === 'live' && config.sendLiveMessage) {
    await sendWithTimeout(rt, session, '直播进行中，无法发送视频流。').catch(() => {})
  }
  if (p.video && p.type !== 'live' && p.type !== 'live_photo' && item.video.kind === 'raw' && item.video.url) {
    const url = item.video.url
    if (config.showVideoFile !== false) {
      await sendWithTimeout(rt, session, h.video(url)).catch(async () => {
        await sendWithTimeout(rt, session, `视频链接：${url}`).catch(() => {})
      })
    } else {
      await sendWithTimeout(rt, session, `视频链接：${url}`).catch(() => {})
    }
  }
  if (config.showMusicVoice && p.music.url) {
    await sendWithTimeout(rt, session, h.audio(p.music.url)).catch(() => {})
    await pace(300)
  }
  if (hint) {
    await sendWithTimeout(rt, session, hint).catch(() => {})
  }
}
