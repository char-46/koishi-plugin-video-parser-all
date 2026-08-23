/**
 * 合并转发模式：把每个语义单元（MessageUnit）构建为一个转发气泡。
 *
 * 合并转发卡片 = <message forward> 嵌套多个 <message>，每个内层 <message> 是一个气泡，
 * 用 <author> 设置气泡昵称（模拟机器人发送）。
 * 仅一个气泡时不打包卡片，直接发送。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { sendWithTimeout } from './sender'
import { delay } from '../utils/common'
import { debugLog, logger } from '../utils/logger'
import { buildUnits, type ProcessedItem } from './compose'

/** 一个转发气泡：<message><author>bot</author>…content…</message> */
export function buildForwardNode(session: any, content: any, botName: string) {
  let messageContent: any[]
  if (Array.isArray(content)) messageContent = content
  else if (content && typeof content === 'object' && content.type) messageContent = [content]
  else messageContent = [h.text(String(content))]
  return h('message', h('author', { id: session.selfId, name: botName.substring(0, 15) }), messageContent)
}

export async function sendForward(rt: ParserRuntime, session: any, items: ProcessedItem[]): Promise<void> {
  const { config } = rt
  const botName = config.botName || '视频解析机器人'
  const bubbles: any[] = []
  const total = items.length

  for (let i = 0; i < total; i++) {
    const item = items[i]
    const units = buildUnits(rt, item)
    // 多 item 时给概述文字加序号前缀
    if (total > 1) {
      for (const u of units) {
        const txt = u.content.find((e: any) => e.type === 'text')
        if (txt) { txt.attrs = { ...txt.attrs, content: `【${i + 1}/${total}】\n${txt.attrs?.content ?? ''}` }; break }
      }
    }
    // mergeable 单元（概述+图片+提示）合并为第一个气泡；非 mergeable（视频文件/取件码/混淆图）各占一个气泡
    const mergeable = units.filter(u => u.mergeable)
    const standalone = units.filter(u => !u.mergeable)
    if (mergeable.length) bubbles.push(buildForwardNode(session, mergeable.flatMap(u => u.content), botName))
    for (const u of standalone) bubbles.push(buildForwardNode(session, u.content, botName))
  }

  // 仅一条消息：不打包转发卡片，直接发送
  if (bubbles.length === 1) {
    const content = bubbles[0].children
    await sendWithTimeout(rt, session, content, config.retryTimes)
    return
  }

  const MAX_BUBBLES = 50
  for (let i = 0; i < bubbles.length; i += MAX_BUBBLES) {
    const batch = bubbles.slice(i, i + MAX_BUBBLES)
    try {
      await sendWithTimeout(rt, session, h('message', { forward: true }, batch), config.retryTimes)
    } catch (err) {
      logger.error('合并转发失败，降级逐条发送:', err)
      for (const item of items) {
        for (const u of buildUnits(rt, item)) {
          await sendWithTimeout(rt, session, u.content).catch(() => {})
          await delay(300)
        }
      }
      return
    }
  }
}

export { sendMedia } from './sender'
