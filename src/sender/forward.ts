/**
 * 合并转发模式：每个 item 的语义单元构建为合并转发节点（转发气泡）。
 * 单元来自 compose.buildUnits（混淆图 / 取件码同样作为独立气泡）。
 * 仅一个节点时不打包转发卡片，直接发送。
 */
import { h } from 'koishi'
import type { ParserRuntime } from '../runtime'
import { sendWithTimeout } from './sender'
import { delay } from '../utils/common'
import { debugLog } from '../utils/logger'
import { buildUnits, type ProcessedItem } from './compose'

export function buildForwardNode(session: any, content: any, botName: string) {
  let messageContent: any[]
  if (Array.isArray(content)) messageContent = content
  else if (content && typeof content === 'object' && content.type) messageContent = [content]
  else messageContent = [h.text(String(content))]
  return h('node', { user: { nickname: botName.substring(0, 15), user_id: session.selfId } }, messageContent)
}

export async function sendForward(rt: ParserRuntime, session: any, items: ProcessedItem[]): Promise<void> {
  const { config } = rt
  const botName = config.botName || '视频解析机器人'
  const nodes: any[] = []
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
    for (const u of units) nodes.push(buildForwardNode(session, u.content, botName))
  }

  // 仅一条消息：直接发送，不打包转发卡片
  if (nodes.length === 1) {
    const single = nodes[0]
    const content = Array.isArray(single.children) ? single.children : [single.children]
    await sendWithTimeout(rt, session, content, config.retryTimes)
    return
  }

  const MAX_NODES = 50
  for (let i = 0; i < nodes.length; i += MAX_NODES) {
    const batch = nodes.slice(i, i + MAX_NODES)
    try {
      await sendWithTimeout(rt, session, h('message', { forward: true }, batch), config.retryTimes)
    } catch (err) {
      debugLog('ERROR', '合并转发失败，降级逐条发送:', err)
      for (const item of items) {
        const units = buildUnits(rt, item)
        for (const u of units) {
          await sendWithTimeout(rt, session, u.content).catch(() => {})
          await delay(300)
        }
      }
      return
    }
  }
}

export { sendMedia } from './sender'
