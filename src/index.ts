import type { Context } from 'koishi'
import { h } from 'koishi'
import { name, Config } from './config'
import { logger, debugLog, setVerboseLogging } from './utils/logger'
import { getText } from './utils/common'
import { linkTypeParser, extractAllUrlsFromMessage } from './utils/url'
import { createRuntime } from './runtime'
import { sendWithTimeout } from './sender/sender'
import { flush } from './sender/flush'
import { diagnoseTls } from './utils/tls-client'
import { nsfwCapability } from './services/nsfw/gate'
import { videoVault, configureVault } from './services/nsfw/vault'
import { initModerationCache, flushModerationCache } from './services/nsfw/moderation/cache'
import { createHash } from 'crypto'

export { name, Config }

/** 可选服务依赖：ferret-transform-image (>=0.0.4) 提供图片混淆服务 */
export const inject = {
  optional: ['ferret-transform'],
}

export function apply(ctx: Context, config: any) {
  setVerboseLogging(config.debug || false)
  logger.info('插件启动')

  const rt = createRuntime(ctx, config)

  // 内容安全子系统：按配置初始化 vault 与审核缓存（配置签名变更自动作废旧持久化结果）
  if (config.nsfwVault) configureVault(config.nsfwVault)
  const modSig = createHash('sha256').update(JSON.stringify(config.nsfwModeration || {})).digest('hex').slice(0, 16)
  initModerationCache((ctx as any).baseDir, modSig)
  const cap = nsfwCapability(rt)
  ctx.logger.info(`内容安全能力：混淆${cap.ferret ? '可用（ferret-transform 服务已加载）' : '不可用（未检测到 koishi-plugin-ferret-transform-image，相关功能停用）'}；审核${cap.moderation ? `已启用（${cap.moderation}）` : '未配置'}`)
  // 易踩坑提示：配了审核 Provider 但模式全 off，审核不会执行
  if (cap.moderation) {
    const globalMode = config.nsfwGlobalMode || 'off'
    const anyPlatformOn = Object.values(config.nsfwPlatformMode || {}).some((m: any) => m === 'smart' || m === 'full')
    if (globalMode === 'off' && !anyPlatformOn) {
      ctx.logger.warn('内容安全：审核 Provider 已配置，但全平台一刀切模式为「关闭」且无任何平台显式开启——审核不会执行。请在「全平台一刀切模式」选 smart/full，或单独设置平台处理模式。')
    }
  }

  ctx.on('message', async (session) => {
    if (!config.enable) return
    if (/^\s*parse\b/i.test(session.content || '')) return
    if (/^\s*(取视频|parse\/getvideo)\b/i.test(session.content || '')) return
    if (session.subtype === 'file_upload') return
    if (session.elements?.some(elem => elem.type === 'file' || elem.type === 'folder')) return
    if (session.selfId === session.userId) return
    const matches = extractAllUrlsFromMessage(session, rt.allRules)
    if (!matches.length) return
    debugLog(`检测到 ${matches.length} 个链接`)
    if (config.showWaitingTip) {
      try {
        await sendWithTimeout(rt, session, h.quote(session.messageId) + getText(config, 'waitingTipText'))
      } catch(e) {
        logger.warn('等待提示发送失败:', e)
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
    await flush(rt, session, matches, { skipDedup: true })
  })

  ctx.command('parse/getvideo <token>', '领取受限暂存视频（仅私聊）').alias('取视频')
    .action(async ({ session }, token) => {
      if (!session) return
      if (session.guildId) return '该命令仅限私聊使用（凭 token 领取受限视频）。'
      if (!token) return '请提供取件 token。'
      const tokenShare = config.nsfwVault?.tokenShare !== false
      const result = videoVault.redeem(token, String(session.userId), tokenShare)
      if (!result.ok) {
        if (result.reason === 'forbidden') return '该 token 不属于你，无法领取（管理员未开启取件码共享）。'
        if (result.reason === 'expired') return '暂存已过期，请重新触发解析获取新 token。'
        return 'token 无效或暂存已被清理。'
      }
      const { entry } = result
      const label = entry.meta.title ? `「${entry.meta.title.slice(0, 40)}」` : '视频'
      try {
        if (entry.buffer) {
          await sendWithTimeout(rt, session, `${label}（${entry.meta.sizeMB ?? '?'}MB）：`)
          await sendWithTimeout(rt, session, h.video(entry.buffer, 'video/mp4'), config.retryTimes)
        } else if (entry.url) {
          await sendWithTimeout(rt, session, h.video(entry.url), config.retryTimes)
        } else {
          return '暂存条目已损坏。'
        }
      } catch (e: any) {
        logger.error('取视频发送失败:', e?.message || e)
        return `视频发送失败：${e?.message || e}。可稍后重试「取视频 <token>」（有效期内可多次领取）。`
      }
    })

  if (config.enableDiagCommand) {
    ctx.command('parse/diag', '诊断 X 登录态解析环境（tlsget）').action(async ({ session }) => {
      await sendWithTimeout(rt, session, '开始诊断 tlsget 环境，约需 30 秒…')
      try {
        const lines = await diagnoseTls()
        await sendWithTimeout(rt, session, lines.join('\n'))
      } catch (e: any) {
        await sendWithTimeout(rt, session, '诊断异常：' + (e?.message || e))
      }
    })
  }

  // 加载时自动体检 tlsget 环境（仅登录态推文需要；未配置凭证则跳过）
  if (config.twitterAuthToken && config.twitterCt0) {
    ctx.logger.info('检测到 X 登录态凭证，开始 tlsget 环境自检…')
    diagnoseTls().then((lines) => {
      for (const line of lines) ctx.logger.info(`[tlsget-diag] ${line}`)
    }).catch((e) => {
      ctx.logger.warn(`[tlsget-diag] 自检异常：${e?.message || e}`)
    })
  }

  ctx.on('dispose', () => {
    rt.urlCacheLocal.clear()
    rt.dedupCache.clear()
    videoVault.clear()
    flushModerationCache() // 审核缓存持久化保留（防抖未落盘的立即写出）
    debugLog('插件已卸载')
  })

  logger.info('插件初始化完成')
}
