import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { logger } from '../utils/logger'
import { delay, getErrorMessage } from '../utils/common'

export async function sendWithTimeout(rt: ParserRuntime, session: any, content: any, customRetries?: number): Promise<any> {
  const { config } = rt
  const maxRetries = customRetries ?? config.retryTimes ?? 3
  const retryDelay = config.retryInterval || 1000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let sendPromise = session.send(content)
      if (config.videoSendTimeout > 0) {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('发送超时')), config.videoSendTimeout))
        return await Promise.race([sendPromise, timeoutPromise])
      } else {
        return await sendPromise
      }
    } catch (err) {
      const errMsg = getErrorMessage(err)
      logger.error(`发送失败尝试 ${attempt+1}: ${errMsg}`)
      if (attempt < maxRetries) await delay(retryDelay)
      else if (!config.ignoreSendError) throw err
    }
  }
  return null
}

export async function sendMedia(
  rt: ParserRuntime,
  session: any,
  url: string,
  type: 'image' | 'video' | 'audio',
  showFile: boolean
) {
  if (!url) return
  if (!showFile) {
    await sendWithTimeout(rt, session, `${type === 'audio' ? '音乐' : type === 'video' ? '视频' : '图片'}链接：${url}`).catch(() => {})
    return
  }
  try {
    await sendWithTimeout(rt, session, type === 'audio' ? h.audio(url) : type === 'video' ? h.video(url) : h.image(url))
  } catch {
    await sendWithTimeout(rt, session, `${type === 'audio' ? '音乐' : type === 'video' ? '视频' : '图片'}链接：${url}`).catch(() => {})
  }
}
