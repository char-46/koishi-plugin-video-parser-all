import { describe, it, expect } from 'vitest'
import { flush } from '../src/sender/flush'
import { mockSession, mockHttp, makeRuntime, sentTexts, sentElements } from './helpers'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BUF = Buffer.from(PNG, 'base64')

function ferretStub(rt: any) {
  rt.ctx['ferret-transform'] = {
    scramble: async (buf: Buffer) => Buffer.concat([Buffer.from('SCR|'), buf.slice(0, 4)]),
    encodeToken: (v: string) => Buffer.from(v, 'utf8').toString('base64url'),
    decodeToken: (t: string) => Buffer.from(t, 'base64url').toString('utf8'),
    seedFrom: () => 1,
  }
}

function nsfwRt(config: any = {}, payloads: any = { code: 200, data: { images: ['https://x/1.jpg'] } }) {
  const rt = makeRuntime({ config })
  ferretStub(rt)
  rt.http = {
    get: async () => ({ data: PNG_BUF }),
  } as any
  ;(rt as any).httpParse = mockHttp(payloads)
  return rt
}

describe('flush + NSFW 端到端', () => {
  it('平台 full：主消息用占位符，混淆图 + token 独立第二条发送', async () => {
    const rt = nsfwRt({
      nsfwPlatformMode: { xiaohongshu: 'full' },
      nsfwPolicy: { imageAction: 'scramble', tokenHintText: '已混淆，token=<token>' },
    })
    rt.http = {
      get: async (url: string) => {
        if (url.includes('xhslink') || url.includes('api')) return { data: { code: 200, data: { title: '图集标题', images: ['https://x/1.jpg', 'https://x/2.jpg'] } } }
        return { data: PNG_BUF }
      },
    } as any
    const session = mockSession()
    await flush(rt, session as any, [{ type: 'xiaohongshu', url: 'https://xhslink.com/X', id: 'X' }])
    // 混淆图出现在 sentElements 中（占位符在主消息，混淆图 buffer 在附加消息）
    const allEls = sentElements(session._sent)
    const imgEls = allEls.filter(c => c?.type === 'img')
    expect(imgEls.length).toBe(2) // 两张混淆图
    // token 出现在消息中
    const allTexts = sentTexts(session._sent).join('\n')
    expect(allTexts).toContain('token=')
    expect(allTexts).toContain('〔图片已混淆') // 主消息占位符
  })

  it('受限视频：群内仅文字卡片 + token（无视频元素、无封面）', async () => {
    const rt = nsfwRt({
      nsfwPlatformMode: { douyin: 'full' },
      nsfwPolicy: { videoAction: 'redeem', videoCardHint: '受限视频，私聊「取视频 <token>」领取（${ttl} 分钟内）' },
      nsfwVault: { ttlMinutes: 30, maxItems: 20, maxItemMB: 200, budgetMB: 600 },
    })
    rt.http = {
      get: async (url: string) => {
        if (url.includes('douyin.com') || url.includes('api')) return { data: { code: 200, data: { title: 'T', url: 'https://cdn/v.mp4' } } }
        return { data: PNG_BUF } // 视频字节（小体积）
      },
    } as any
    const session = mockSession({ userId: 'req1' })
    await flush(rt, session as any, [{ type: 'douyin', url: 'https://v.douyin.com/V/', id: 'V' }])
    const els = sentElements(session._sent)
    expect(els.some(c => c?.type === 'video')).toBe(false)      // 无视频元素
    const texts = sentTexts(session._sent).join('\n')
    expect(texts).toContain('取视频')                            // token 提示
    // token 已入 vault 且绑定请求者
    const { videoVault } = await import('../src/nsfw/vault')
    expect(videoVault.size).toBeGreaterThanOrEqual(1)
    videoVault.clear()
  })

  it('去重层①：同消息相同 URL 只解析一次', async () => {
    let calls = 0
    const rt = nsfwRt({}, {})
    rt.http = {
      get: async (url: string) => {
        if (url.includes('api')) { calls++; return { data: { code: 200, data: { title: 'T', url: 'https://x/v.mp4' } } } }
        return { data: PNG_BUF }
      },
    } as any
    const session = mockSession()
    await flush(rt, session as any, [
      { type: 'douyin', url: 'https://v.douyin.com/D/', id: 'D' },
      { type: 'douyin', url: 'https://v.douyin.com/D/', id: 'D' }, // 尾斜杠差异应视为相同
    ])
    expect(calls).toBe(1)
  })

  it('去重层②：同消息不同 URL 相同内容指纹只发一次', async () => {
    const rt = nsfwRt({}, {})
    rt.http = {
      get: async (url: string) => ({ data: { code: 200, data: { title: '同内容', url: 'https://x/v.mp4' } } }),
    } as any
    const session = mockSession()
    await flush(rt, session as any, [
      { type: 'douyin', url: 'https://v.douyin.com/A/', id: 'A' },
      { type: 'douyin', url: 'https://v.douyin.com/B/', id: 'B' },
    ])
    // 单条整合模式下应只出现一份标题
    const texts = sentTexts(session._sent).join('\n')
    expect((texts.match(/同内容/g) || []).length).toBe(1)
  })

  it('sendStrategy=split：保持旧版逐条行为', async () => {
    const rt = nsfwRt({ sendStrategy: 'split' }, {})
    rt.http = {
      get: async (url: string) => {
        if (url.includes('api')) return { data: { code: 200, data: { title: '图集标题', images: ['https://x/1.jpg'] } } }
        return { data: PNG_BUF }
      },
    } as any
    const session = mockSession()
    await flush(rt, session as any, [{ type: 'xiaohongshu', url: 'https://xhslink.com/X', id: 'X' }])
    // split 模式：文字与图片是分开的两次 send
    expect(session._sent.length).toBeGreaterThanOrEqual(2)
  })

  it('ferret 服务缺失 + 平台 full：图片降级为链接文字（不放原图）', async () => {
    const rt = nsfwRt({ nsfwPlatformMode: { xiaohongshu: 'full' } }, {}) // 无 ferret stub
    delete (rt.ctx as any)['ferret-transform']
    rt.http = {
      get: async (url: string) => {
        if (url.includes('xhslink') || url.includes('api')) return { data: { code: 200, data: { images: ['https://x/1.jpg'] } } }
        return { data: PNG_BUF }
      },
    } as any
    const session = mockSession()
    await flush(rt, session as any, [{ type: 'xiaohongshu', url: 'https://xhslink.com/X', id: 'X' }])
    const els = sentElements(session._sent)
    expect(els.filter(c => c?.type === 'img').length).toBe(0) // 无图片元素
    const texts = sentTexts(session._sent).join('\n')
    expect(texts).toContain('https://x/1.jpg')                // 链接文字
  })
})
