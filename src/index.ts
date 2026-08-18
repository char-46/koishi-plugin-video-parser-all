import type { Context } from 'koishi'
import { h } from 'koishi'
import { name, Config } from './config'
import { debugLog, setDebugEnabled } from './utils/logger'
import { getText } from './utils/common'
import { linkTypeParser, extractAllUrlsFromMessage } from './utils/url'
import { createRuntime } from './runtime'
import { sendWithTimeout } from './sender/sender'
import { flush } from './sender/flush'
import { diagnoseTls } from './utils/tls-client'

export { name, Config }

export function apply(ctx: Context, config: any) {
  setDebugEnabled(config.debug || false)
  debugLog('INFO', 'plugin start')

  const rt = createRuntime(ctx, config)

  ctx.on('message', async (session) => {
    if (!config.enable) return
    if (/^\s*parse\b/i.test(session.content || '')) return
    if (session.subtype === 'file_upload') return
    if (session.elements?.some(elem => elem.type === 'file' || elem.type === 'folder')) return
    if (session.selfId === session.userId) return
    const matches = extractAllUrlsFromMessage(session, rt.allRules)
    if (!matches.length) return
    debugLog('INFO', `检测到 ${matches.length} 个链接`)
    if (config.showWaitingTip) {
      try {
        await sendWithTimeout(rt, session, h.quote(session.messageId) + getText(config, 'waitingTipText'))
      } catch(e) {
        debugLog('WARN', '等待提示发送失败:', e)
      }
    }
    await flush(rt, session, matches)
  })

  ctx.command('parse <url>', '手动解析视频').action(async ({ session }, url) => {
    if (!url) { await sendWithTimeout(rt, session, getText(config, 'invalidLinkText')); return }
    const matches = linkTypeParser(url, rt.allRules)
    if (!matches.length) { await sendWithTimeout(rt, session, getText(config, 'invalidLinkText')); return }
    if (config.showWaitingTip) {
      try {
        await sendWithTimeout(rt, session, h.quote(session?.messageId) + getText(config, 'waitingTipText'))
      } catch {}
    }
    await flush(rt, session, matches)
  })

  if (config.enableDiagCommand !== false) {
    ctx.command('parse/diag', '诊断 X 登录态解析环境（cycletls）').action(async ({ session }) => {
      await sendWithTimeout(rt, session, '开始诊断 cycletls 环境，约需 30 秒…')
      try {
        const lines = await diagnoseTls()
        await sendWithTimeout(rt, session, lines.join('\n'))
      } catch (e: any) {
        await sendWithTimeout(rt, session, '诊断异常：' + (e?.message || e))
      }
    })
  }

  ctx.on('dispose', () => {
    rt.urlCacheLocal.clear()
    rt.dedupCache.clear()
    debugLog('INFO', '插件已卸载')
  })

  debugLog('INFO', '插件初始化完成')
}
