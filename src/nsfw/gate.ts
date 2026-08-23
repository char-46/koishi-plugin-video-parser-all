/**
 * NSFW 网关：策略解析 + 出站媒体处理编排。
 *
 * 策略模型：
 * - 平台三态 off / full / smart（简洁模式 platformMode 表；高级模式 platformPolicyAdvanced 覆盖优先）
 * - 配置了审核 Provider → smart 优先于 full（全量混淆自动失效）
 * - smart：图片逐一送审，视频仅封面送审；命中才混淆/遮蔽
 * - full：无条件按命中处理
 * - fail-closed：审核异常按命中（见 moderation/index.ts）
 *
 * 动作（全局或平台覆盖）：
 * - imageAction: scramble（混淆图+token）| link（只发链接文字）| drop（不发送）
 * - videoAction: redeem（暂存+私聊凭 token 取）| link（发原链接文字）| drop
 */
import type { ParserRuntime } from '../runtime'
import { debugLog } from '../utils/logger'
import { createProvider, withFailClosed } from './moderation'
import type { ModerationProvider } from './moderation'
import { getFerret, scrambleImage } from './scramble'
import { videoVault } from './vault'

export type PlatformMode = 'off' | 'full' | 'smart'
export type ImageAction = 'scramble' | 'link' | 'drop'
export type VideoAction = 'redeem' | 'link' | 'drop'
export type MediaKind = 'cover' | 'image' | 'avatar' | 'music-cover'

export interface ResolvedPolicy {
  mode: PlatformMode
  imageAction: ImageAction
  videoAction: VideoAction
}

interface AdvancedPolicyEntry {
  platform: string
  mode?: PlatformMode
  imageAction?: ImageAction
  videoAction?: VideoAction
}

/** provider 缓存（WeakMap per runtime，配置变化随插件重载自然重建） */
const providerCache = new class {
  private map = new WeakMap<object, ModerationProvider | null>()
  get(rt: ParserRuntime): ModerationProvider | null {
    if (!this.map.has(rt.ctx)) this.map.set(rt.ctx, buildProvider(rt))
    return this.map.get(rt.ctx) ?? null
  }
}()

function buildProvider(rt: ParserRuntime): ModerationProvider | null {
  const conf = rt.config.nsfwModeration
  if (!conf) return null
  const raw = createProvider(conf as any, rt.http)
  return raw ? withFailClosed(raw) : null
}

export function getModerationProvider(rt: ParserRuntime): ModerationProvider | null {
  return providerCache.get(rt)
}

/** 解析平台最终策略：高级显式覆盖 > 平台级显式（inherit 跟随全局）> 全局一刀切；
 *  配置审核 Provider 时，非高级显式的 full 自动转 smart（高级模式显式 full 视为专家意图，保留一刀切） */
export function resolvePolicy(rt: ParserRuntime, platform: string): ResolvedPolicy {
  const nsfw = rt.config.nsfwPolicy || {}
  const platformVal = rt.config.nsfwPlatformMode?.[platform]
  const globalMode = rt.config.nsfwGlobalMode || 'off'
  let mode: PlatformMode = platformVal && platformVal !== 'inherit' ? platformVal : globalMode
  const policy: ResolvedPolicy = {
    mode,
    imageAction: nsfw.imageAction || 'scramble',
    videoAction: nsfw.videoAction || 'redeem',
  }
  let advancedFull = false
  if (rt.config.nsfwAdvancedPolicy) {
    const adv: AdvancedPolicyEntry | undefined = (rt.config.nsfwPlatformPolicyAdvanced || []).find((p: any) => p.platform === platform)
    if (adv) {
      if (adv.mode) {
        policy.mode = adv.mode
        advancedFull = adv.mode === 'full'
      }
      if (adv.imageAction) policy.imageAction = adv.imageAction
      if (adv.videoAction) policy.videoAction = adv.videoAction
    }
  }
  if (policy.mode === 'full' && getModerationProvider(rt) && !advancedFull) policy.mode = 'smart'
  return policy
}

export interface ImageOutcome {
  /** raw=原图 url；scrambled=混淆 buffer+token；link=仅链接文字；drop=不发送 */
  kind: 'raw' | 'scrambled' | 'link' | 'drop'
  url?: string
  buffer?: Buffer
  token?: string
}

/** 审核判定单图（smart 模式内部使用；含缓存） */
async function moderateImage(rt: ParserRuntime, url: string): Promise<boolean> {
  const provider = getModerationProvider(rt)
  if (!provider) return false
  try {
    const res = await rt.http.get(url, { responseType: 'arraybuffer', timeout: 30000 })
    const result = await provider.check({ url, buffer: Buffer.from(res.data) })
    debugLog('INFO', `内容审核 ${result.nsfw ? '命中' : '通过'}（${result.label || 'clean'}）: ${url.slice(0, 60)}`)
    return result.nsfw
  } catch (e: any) {
    debugLog('WARN', `送审图片下载失败（fail-closed 按命中）: ${e?.message || e}`)
    return true
  }
}

/** 处理单张出站图片 */
export async function processImage(rt: ParserRuntime, platform: string, url: string, kind: MediaKind): Promise<ImageOutcome> {
  if (!url) return { kind: 'drop' }
  const policy = resolvePolicy(rt, platform)
  // 头像/音乐封面默认跳过（scrambleAvatar 仅放开头像）
  if (kind === 'music-cover') return { kind: 'raw', url }
  if (kind === 'avatar' && !rt.config.nsfwPolicy?.scrambleAvatar) return { kind: 'raw', url }

  if (policy.mode === 'off') return { kind: 'raw', url }

  let hit = policy.mode === 'full'
  if (policy.mode === 'smart') hit = await moderateImage(rt, url)
  if (!hit) return { kind: 'raw', url }

  if (policy.imageAction === 'drop') return { kind: 'drop' }
  if (policy.imageAction === 'link') return { kind: 'link', url }
  const s = await scrambleImage(rt, url)
  if (!s.ok) return { kind: 'link', url }
  return { kind: 'scrambled', buffer: s.buffer, token: s.token }
}

export interface VideoOutcome {
  /** raw=照发；card=群内纯文字卡片+token（无封面无视频）；link=文字卡片+原链接；drop=仅文字卡片 */
  kind: 'raw' | 'card' | 'link' | 'drop'
  url?: string
  token?: string
}

/** 处理出站视频（封面送审判定；命中后按 videoAction 处置） */
export async function processVideo(rt: ParserRuntime, platform: string, videoUrl: string, coverUrl: string, meta: { title?: string; author?: string; requesterId: string }): Promise<VideoOutcome> {
  const policy = resolvePolicy(rt, platform)
  if (policy.mode === 'off') return { kind: 'raw', url: videoUrl }

  let hit = policy.mode === 'full'
  if (policy.mode === 'smart' && coverUrl) hit = await moderateImage(rt, coverUrl)

  if (!hit) return { kind: 'raw', url: videoUrl }

  if (policy.videoAction === 'drop') return { kind: 'drop' }
  if (policy.videoAction === 'link') return { kind: 'link', url: videoUrl }

  // redeem：尝试下载缓存（<=maxItemMB），超限/失败降级 link
  try {
    const res = await rt.http.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: (videoVault as any).conf.maxItemMB * 1048576 })
    const buffer = Buffer.from(res.data)
    const token = videoVault.put({
      requesterId: meta.requesterId,
      buffer,
      expiresAt: Date.now() + (videoVault as any).conf.ttlMinutes * 60000,
      meta: { title: meta.title, author: meta.author, platform, sizeMB: +(buffer.length / 1048576).toFixed(1) },
    })
    return { kind: 'card', token }
  } catch (e: any) {
    debugLog('WARN', `受限视频暂存失败（降级发链接文字）: ${e?.message || e}`)
    return { kind: 'link', url: videoUrl }
  }
}

/** 能力状态（供启动日志） */
export function nsfwCapability(rt: ParserRuntime): { ferret: boolean; moderation: string | null } {
  return {
    ferret: !!getFerret(rt),
    moderation: getModerationProvider(rt)?.name || null,
  }
}
