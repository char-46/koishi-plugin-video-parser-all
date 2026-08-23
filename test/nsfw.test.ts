import { describe, it, expect, beforeEach } from 'vitest'
import { resolvePolicy, processImage, processVideo, getModerationProvider } from '../src/services/nsfw/gate'
import { VideoVault } from '../src/services/nsfw/vault'
import { makeScrambleToken, getFerret } from '../src/services/nsfw/scramble'
import { makeRuntime } from './helpers'
import { randomBytes } from 'crypto'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** ferret 服务 stub（与 0.0.4 服务接口对齐） */
function stubFerret(rt: any) {
  rt.ctx['ferret-transform'] = {
    scramble: async (buf: Buffer) => Buffer.concat([Buffer.from('SCR|'), buf.slice(0, 4)]),
    descramble: async () => Buffer.alloc(0),
    encodeToken: (v: string) => Buffer.from(v, 'utf8').toString('base64url'),
    decodeToken: (t: string) => Buffer.from(t, 'base64url').toString('utf8'),
    seedFrom: (v: string) => 12345,
  }
}

function rtWith(overrides: any = {}, opts: { ferret?: boolean; moderation?: any } = {}) {
  const rt = makeRuntime({
    config: {
      nsfwPolicy: { imageAction: 'scramble', videoAction: 'redeem', ...overrides.nsfwPolicy },
      nsfwPlatformMode: overrides.nsfwPlatformMode || {},
      nsfwAdvancedPolicy: overrides.nsfwAdvancedPolicy || false,
      nsfwPlatformPolicyAdvanced: overrides.nsfwPlatformPolicyAdvanced || [],
      nsfwModeration: overrides.nsfwModeration,
      nsfwVault: { ttlMinutes: 30, maxItems: 20, maxItemMB: 200, budgetMB: 600 },
      ...overrides.raw,
    },
  })
  if (opts.ferret !== false) stubFerret(rt)
  rt.http = {
    get: async (url: string) => {
      if (url.endsWith('.mp4')) return { data: PNG } // 小体积视频字节
      return { data: PNG }
    },
  } as any
  return rt
}

describe('nsfw/gate — 策略解析', () => {
  it('默认：全局 off（一刀切默认关闭）', () => {
    const rt = rtWith()
    expect(resolvePolicy(rt, 'douyin').mode).toBe('off')
    expect(resolvePolicy(rt, 'twitter').mode).toBe('off')
  })

  it('全局一刀切：nsfwGlobalMode=full 对所有平台生效；平台显式配置可覆盖', () => {
    const rt = rtWith({ raw: { nsfwGlobalMode: 'full' } })
    expect(resolvePolicy(rt, 'douyin').mode).toBe('full')
    expect(resolvePolicy(rt, 'twitter').mode).toBe('full')
    expect(resolvePolicy(rt, 'weibo').mode).toBe('full')
    // 平台显式 off 覆盖全局
    const rt2 = rtWith({ nsfwPlatformMode: { douyin: 'off' }, raw: { nsfwGlobalMode: 'full' } })
    expect(resolvePolicy(rt2, 'douyin').mode).toBe('off')
    expect(resolvePolicy(rt2, 'weibo').mode).toBe('full')
  })

  it('全局 full + 配置审核 → 全部自动转 smart', () => {
    const rt = rtWith({
      raw: { nsfwGlobalMode: 'full' },
      nsfwModeration: { provider: 'custom', custom: { endpoint: 'https://m.x' } },
    })
    expect(resolvePolicy(rt, 'douyin').mode).toBe('smart')
  })

  it('高级模式显式 full：配了审核也保留一刀切（专家意图）', () => {
    const rt = rtWith({
      nsfwAdvancedPolicy: true,
      nsfwPlatformPolicyAdvanced: [{ platform: 'douyin', mode: 'full' }],
      nsfwModeration: { provider: 'custom', custom: { endpoint: 'https://m.x' } },
    })
    expect(resolvePolicy(rt, 'douyin').mode).toBe('full')
    // 其他平台仍遵循 自动转 smart 规则
    const rt2 = rtWith({
      nsfwPlatformMode: { weibo: 'full' },
      nsfwAdvancedPolicy: true,
      nsfwPlatformPolicyAdvanced: [{ platform: 'douyin', mode: 'full' }],
      nsfwModeration: { provider: 'custom', custom: { endpoint: 'https://m.x' } },
    })
    expect(resolvePolicy(rt2, 'weibo').mode).toBe('smart')
  })

  it('简洁模式：平台 full；配置审核后自动转 smart', () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' } })
    expect(resolvePolicy(rt, 'douyin').mode).toBe('full')
    expect(getModerationProvider(rt)).toBeNull()

    const rt2 = rtWith(
      { nsfwPlatformMode: { douyin: 'full' }, nsfwModeration: { provider: 'custom', custom: { endpoint: 'https://m.x' } } },
    )
    expect(resolvePolicy(rt2, 'douyin').mode).toBe('smart') // 有 provider → smart 优先
    expect(getModerationProvider(rt2)?.name).toBe('custom')
  })

  it('高级模式：平台覆盖优先于简洁表与全局动作', () => {
    const rt = rtWith({
      nsfwPlatformMode: { douyin: 'off', bilibili: 'full' },
      nsfwAdvancedPolicy: true,
      nsfwPlatformPolicyAdvanced: [
        { platform: 'douyin', mode: 'full', imageAction: 'drop' },
        { platform: 'kuaishou', mode: 'smart' },
      ],
    })
    expect(resolvePolicy(rt, 'douyin')).toMatchObject({ mode: 'full', imageAction: 'drop' })
    expect(resolvePolicy(rt, 'kuaishou').mode).toBe('smart')
    expect(resolvePolicy(rt, 'bilibili').mode).toBe('full') // 无高级覆盖 → 简洁表
    expect(resolvePolicy(rt, 'weibo').mode).toBe('off')
  })
})

describe('nsfw/gate — processImage', () => {
  it('off → 原样放行', async () => {
    const rt = rtWith()
    const r = await processImage(rt, 'douyin', 'https://x/1.jpg', 'image')
    expect(r.kind).toBe('raw')
  })

  it('full → 混淆 buffer + token；token 每次随机', async () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' } })
    const a = await processImage(rt, 'douyin', 'https://x/1.jpg', 'image')
    const b = await processImage(rt, 'douyin', 'https://x/1.jpg', 'image')
    expect(a.kind).toBe('scrambled')
    expect(a.buffer!.slice(0, 4).toString()).toBe('SCR|')
    expect(a.token).toBeTruthy()
    expect(a.token).not.toBe(b.token) // 每消息随机（不同调用不同 token）
  })

  it('smart：审核未命中 → 原图；命中 → 混淆', async () => {
    let verdict = false
    const mk = () => {
      const rt = rtWith({
        nsfwPlatformMode: { douyin: 'smart' },
        nsfwModeration: { provider: 'custom', custom: { endpoint: 'https://m.x', method: 'GET', verdictJsonPath: 'nsfw', nsfwValues: ['true'] } },
      })
      rt.http = {
        get: async (url: string) => {
          if (url === 'https://m.x') return { data: { nsfw: verdict ? 'true' : 'false' } }
          return { data: PNG }
        },
      } as any
      return rt
    }
    verdict = false
    const pass = await processImage(mk(), 'douyin', 'https://x/clean.jpg', 'image')
    expect(pass.kind).toBe('raw')
    verdict = true
    const hit = await processImage(mk(), 'douyin', 'https://x/dirty.jpg', 'image')
    expect(hit.kind).toBe('scrambled')
  })

  it('头像/音乐封面默认跳过（full 也不混淆）', async () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' } })
    expect((await processImage(rt, 'douyin', 'https://x/a.jpg', 'avatar')).kind).toBe('raw')
    expect((await processImage(rt, 'douyin', 'https://x/m.jpg', 'music-cover')).kind).toBe('raw')
  })

  it('imageAction=link → 只发链接；服务缺失 → 降级 link（不放原图）', async () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' }, nsfwPolicy: { imageAction: 'link' } })
    expect((await processImage(rt, 'douyin', 'https://x/1.jpg', 'image')).kind).toBe('link')

    const rtNoFerret = rtWith({ nsfwPlatformMode: { douyin: 'full' } }, { ferret: false })
    expect((await processImage(rtNoFerret, 'douyin', 'https://x/1.jpg', 'image')).kind).toBe('link')
  })
})

describe('nsfw/gate — processVideo', () => {
  it('off/合规 → raw 照发', async () => {
    const rt = rtWith()
    expect((await processVideo(rt, 'douyin', 'https://x/v.mp4', 'https://x/c.jpg', { requesterId: 'u1' })).kind).toBe('raw')
  })

  it('full → 暂存 + card + token（绑定请求者）', async () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' } })
    const r = await processVideo(rt, 'douyin', 'https://x/v.mp4', '', { requesterId: 'u1', title: 'T' })
    expect(r.kind).toBe('card')
    expect(r.token).toBeTruthy()
    // token 绑定请求者
    const { videoVault } = await import('../src/services/nsfw/vault')
    expect(videoVault.redeem(r.token!, 'u1').ok).toBe(true)
    expect(videoVault.redeem(r.token!, 'u2').ok).toBe(false)
    videoVault.clear()
  })

  it('超限/下载失败 → 降级 link（发原链接文字）', async () => {
    const rt = rtWith({ nsfwPlatformMode: { douyin: 'full' }, nsfwPolicy: { videoAction: 'redeem' } })
    rt.http = { get: async () => { throw new Error('下载失败') } } as any
    const r = await processVideo(rt, 'douyin', 'https://x/v.mp4', '', { requesterId: 'u1' })
    expect(r.kind).toBe('link')
    expect(r.url).toBe('https://x/v.mp4')
  })
})

describe('nsfw/vault', () => {
  it('TTL 过期与 LRU 驱逐', () => {
    const v = new VideoVault({ ttlMinutes: 1, maxItems: 2, maxItemMB: 200, budgetMB: 600 })
    const t1 = v.put({ requesterId: 'u', buffer: Buffer.alloc(10), expiresAt: Date.now() + 60000, meta: {} })
    const t2 = v.put({ requesterId: 'u', buffer: Buffer.alloc(10), expiresAt: Date.now() + 60000, meta: {} })
    const t3 = v.put({ requesterId: 'u', buffer: Buffer.alloc(10), expiresAt: Date.now() + 60000, meta: {} })
    expect(v.size).toBe(2)                      // maxItems=2 驱逐 t1
    expect(v.redeem(t1, 'u').ok).toBe(false)
    expect(v.redeem(t2, 'u').ok).toBe(true)
    const expired = new VideoVault({ ttlMinutes: 1, maxItems: 5, maxItemMB: 200, budgetMB: 600 })
    const te = expired.put({ requesterId: 'u', buffer: Buffer.alloc(1), expiresAt: Date.now() - 1, meta: {} })
    expect(expired.redeem(te, 'u').ok).toBe(false) // 过期条目不可领取（惰性清扫后 not-found）
  })

  it('makeScrambleToken：base64url 且可逆（ferret 协议兼容）', () => {
    const rt = rtWith()
    const service = getFerret(rt)!
    const { token, seed } = makeScrambleToken(service)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(service.decodeToken(token)).toMatch(/^[0-9a-f]{32}$/)
    expect(seed).toBe(12345) // stub seedFrom
    expect(makeScrambleToken(service).token).not.toBe(token) // 随机
  })
})

describe('compose — 提示文案', () => {
  it('videoCardHint 支持 ${until} 绝对时间与 ${ttl} 分钟（不含取件码）', async () => {
    const { buildVideoHint } = await import('../src/sender/compose')
    const rt = rtWith({
      nsfwPolicy: { videoCardHint: '原视频暂存至 ${until}（${ttl} 分钟），取件码见下条消息' },
    })
    const item = {
      text: '', parsed: {} as any, images: [],
      avatar: { kind: 'raw' as const }, cover: null,
      video: { kind: 'card' as const, token: 'tok123' },
    }
    const hint = buildVideoHint(rt, item as any)
    expect(hint).toContain('暂存至 ')
    expect(hint).toMatch(/\d{2}:\d{2}/)          // 绝对时间 HH:mm
    expect(hint).toContain('30 分钟')            // ttl 占位
    expect(hint).not.toContain('tok123')         // 首条提示不含量子码
  })

  it('tokenHintText：支持 ${count} 数量占位（不含取件码）', async () => {
    const { buildImageHint } = await import('../src/sender/compose')
    const rt = rtWith({
      nsfwPolicy: { tokenHintText: '图片已混淆 ${count} 张，私聊发送「解混淆 + 取件码」还原' },
    })
    const hint = buildImageHint(rt, 3)
    expect(hint).toContain('已混淆 3 张')
    expect(hint).toContain('解混淆 + 取件码')
  })
})
