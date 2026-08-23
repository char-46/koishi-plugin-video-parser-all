import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { existsSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { createProvider, withFailClosed, yidunSignature, aliyunSignature, percentEncode, tencentTc3Sign, getPath } from '../src/services/nsfw/moderation'
import type { AxiosInstance } from 'axios'

const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 拦截式 mock http（记录请求供断言） */
function mockHttp(handler: (method: string, url: string, cfg?: any) => any): { http: AxiosInstance; calls: any[] } {
  const calls: any[] = []
  const http = {
    get: async (url: string, cfg?: any) => { const c = { method: 'GET', url, ...cfg }; calls.push(c); return handler('GET', url, cfg) },
    post: async (url: string, body?: any, cfg?: any) => { const c = { method: 'POST', url, ...(cfg || {}), body }; calls.push(c); return handler('POST', url, { ...(cfg || {}), body }) },
  } as unknown as AxiosInstance
  return { http, calls }
}

const input = { url: 'https://x/img.jpg', buffer: PNG1x1 }

describe('moderation — 各平台签名与判定', () => {
  it('百度：OAuth 换 token → 送审 base64 → conclusionType>=2 命中', async () => {
    let tokenReq = 0, checkReq = 0
    const { http, calls } = mockHttp((m, url) => {
      if (url.includes('oauth')) { tokenReq++; return { data: { access_token: 'T1' } } }
      checkReq++
      return { data: { conclusionType: 2, conclusion: '违规' } }
    })
    const p = createProvider({ provider: 'baidu', baidu: { apiKey: 'ak', secretKey: 'sk' } }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true)
    expect(r.label).toBe('违规')
    expect(tokenReq).toBe(1); expect(checkReq).toBe(1)
    // base64 送审体
    expect(String(calls[1].body)).toContain('image=')
  })

  it('易盾：签名 = md5(secretId+secretKey+timestamp+nonce)', async () => {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    expect(yidunSignature('sid', 'skey', 1234567890, 'nonce1')).toBe(md5('sidskey1234567890nonce1'))
    const { http, calls } = mockHttp(() => ({ data: { code: 200, result: { images: [{ labels: [{ level: 1, subLabel: '色情' }] }] } } }))
    const p = createProvider({ provider: 'yidun', yidun: { secretId: 'sid', secretKey: 'skey' } }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true); expect(r.label).toBe('色情')
    const body = String(calls[0].body)
    expect(body).toContain('signature=')
  })

  it('易盾：空 labels 合规', async () => {
    const { http } = mockHttp(() => ({ data: { code: 200, result: { images: [{}] } } }))
    const p = createProvider({ provider: 'yidun', yidun: { secretId: 'sid', secretKey: 'skey' } }, http)!
    expect((await p.check(input)).nsfw).toBe(false)
  })

  it('阿里云：RPC 签名 HMAC-SHA1 规范串', async () => {
    // 固定参数验证签名可复现
    const sig = aliyunSignature({ b: '2', a: '1' }, 'secret')
    const sorted = 'a=1&b=2'
    const expectSig = createHmac('sha1', 'secret&').update(`GET&${percentEncode('/')}&${percentEncode(sorted)}`).digest('base64')
    expect(sig).toBe(expectSig)
    // percentEncode RFC3986
    expect(percentEncode('a b+c*d~e')).toBe('a%20b%2Bc%2Ad~e')
    // 判定：深搜 block
    const { http } = mockHttp(() => ({ data: { Data: { Elements: [{ imageResults: [{ results: [{ scene: 'porn', suggestion: 'block', label: 'porn' }] }] }] } } }))
    const p = createProvider({ provider: 'aliyun', aliyun: { accessKeyId: 'id', accessKeySecret: 'sec' } }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true); expect(r.label).toBe('porn')
  })

  it('腾讯云：TC3 签名结构 + 非 Pass 判命中', async () => {
    const headers = tencentTc3Sign('sid', 'skey', JSON.stringify({ FileUrl: 'https://x' }), 1700000000, 'ap-guangzhou')
    expect(headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=sid\/\d{4}-\d{2}-\d{2}\/ims\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/)
    const { http, calls } = mockHttp(() => ({ data: { Response: { Suggestion: 'Block', Label: 'Polity', Score: 99 } } }))
    const p = createProvider({ provider: 'tencent', tencent: { secretId: 'sid', secretKey: 'skey' } }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true); expect(r.label).toBe('Polity')
    expect(calls[0].headers['X-TC-Action']).toBe('ImageModeration')
  })

  it('Azure：subscription key 头 + severity>=2 判命中；类别/阈值/阻止列表可配置', async () => {
    const { http, calls } = mockHttp(() => ({ data: { categoriesAnalysis: [{ category: 'Sexual', severity: 4 }, { category: 'Violence', severity: 0 }] } }))
    const p = createProvider({ provider: 'azure', azure: { endpoint: 'https://res.cognitiveservices.azure.com/', apiKey: 'k1' } }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true)
    expect(r.label).toBe('Sexual')
    expect(r.detail).toBe('Sexual=4, Violence=0') // 各分类 severity 明细
    expect(calls[0].url).toContain('/contentsafety/image:analyze?api-version=2023-10-01')
    expect(calls[0].headers['Ocp-Apim-Subscription-Key']).toBe('k1')
    expect(calls[0].body.categories).toEqual(['Sexual', 'Violence']) // 默认类别
    // 全部低于阈值 → 合规
    const { http: http2 } = mockHttp(() => ({ data: { categoriesAnalysis: [{ category: 'Sexual', severity: 0 }] } }))
    const p2 = createProvider({ provider: 'azure', azure: { endpoint: 'https://res.cognitiveservices.azure.com', apiKey: 'k1' } }, http2)!
    expect((await p2.check(input)).nsfw).toBe(false)
    // 自定义类别 + 自定义阈值（Hate severity 3，阈值 4 → 不命中）
    const { http: http3, calls: calls3 } = mockHttp(() => ({ data: { categoriesAnalysis: [{ category: 'Hate', severity: 3 }] } }))
    const p3 = createProvider({ provider: 'azure', azure: { endpoint: 'https://res.cognitiveservices.azure.com', apiKey: 'k1', categories: ['Hate', 'SelfHarm'], severityThreshold: 4, blocklistNames: ['mylist'] } }, http3)!
    expect((await p3.check(input)).nsfw).toBe(false)
    expect(calls3[0].body.categories).toEqual(['Hate', 'SelfHarm'])
    expect(calls3[0].body.blocklistNames).toEqual(['mylist'])
  })

  it('自定义模板：bodyTemplate 占位替换 + verdictJsonPath 判定', async () => {
    const { http, calls } = mockHttp(() => ({ data: { data: { results: [{ nsfw: 'block' }] } } }))
    const p = createProvider({
      provider: 'custom',
      custom: {
        endpoint: 'https://mod.example/check',
        method: 'POST',
        bodyTemplate: '{"image":"${base64}","url":"${url}"}',
        verdictJsonPath: 'data.results[0].nsfw',
        nsfwValues: ['block', 'true'],
      },
    }, http)!
    const r = await p.check(input)
    expect(r.nsfw).toBe(true)
    expect(String(calls[0].body)).toContain('"url":"https://x/img.jpg"')
  })

  it('getPath：点路径与数组下标', () => {
    expect(getPath({ a: { b: [{ c: 42 }] } }, 'a.b[0].c')).toBe(42)
    expect(getPath({ a: 1 }, 'x.y')).toBeUndefined()
  })

  it('fail-closed：Provider 异常一律按命中', async () => {
    const { http } = mockHttp(() => { throw new Error('网络炸了') })
    const p = withFailClosed(createProvider({ provider: 'baidu', baidu: { apiKey: 'ak', secretKey: 'sk' } }, http)!)
    const r = await p.check(input)
    expect(r.nsfw).toBe(true)
    expect(r.label).toBe('审核服务异常')
  })

  it('凭证缺失 → createProvider 返回 null（审核未启用）', () => {
    const { http } = mockHttp(() => ({}))
    expect(createProvider({ provider: 'baidu', baidu: { apiKey: '', secretKey: '' } }, http)).toBeNull()
  })
})

describe('moderation cache — 内容寻址 + 持久化', () => {
  const PNG2x2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACZgbYnAAAAF0lEQVR42mNk+M+ACzDhVQ4CAAvwATkP0c0AAAAASUVORK5CYII=', 'base64')
  const tmp = resolve(process.cwd(), 'node_modules', '.moderation-cache-test')
  const file = join(tmp, 'data', 'video-parser-all', 'moderation-cache.json')

  it('键与 URL 无关：查询参数/短链/域名不同但字节相同 → 命中', async () => {
    const { getCached, setCached, initModerationCache, clearModerationCache } = await import('../src/services/nsfw/moderation/cache')
    initModerationCache(undefined, 'sig-test') // 纯内存
    const buf = PNG2x2
    setCached({ url: 'https://a.com/x.jpg?format=small', buffer: buf }, { nsfw: true, label: 'Sexual' })
    // 同字节不同 URL 形态（查询参数 / 短链域名 / 镜像 CDN）全部命中
    expect(getCached({ url: 'https://a.com/x.jpg?format=large&name=orig', buffer: buf })?.nsfw).toBe(true)
    expect(getCached({ url: 'https://t.cn/AbCdE', buffer: buf })?.nsfw).toBe(true)
    expect(getCached({ url: 'https://mirror-cdn.net/img/999.webp', buffer: buf })?.nsfw).toBe(true)
    // 字节不同 → 不命中
    expect(getCached({ url: 'https://a.com/x.jpg', buffer: PNG1x1 })).toBeUndefined()
    clearModerationCache()
  })

  it('持久化：落盘后重 init 可读回；配置签名变更作废', async () => {
    const { getCached, setCached, initModerationCache, flushModerationCache } = await import('../src/services/nsfw/moderation/cache')
    rmSync(tmp, { recursive: true, force: true })
    initModerationCache(tmp, 'sigA')
    setCached({ url: 'https://x/1.jpg', buffer: PNG1x1 }, { nsfw: false, label: '' })
    flushModerationCache()
    expect(existsSync(file)).toBe(true)
    // 模拟重启：重新 init 同签名 → 读回
    initModerationCache(tmp, 'sigA')
    expect(getCached({ url: 'https://whatever', buffer: PNG1x1 })?.nsfw).toBe(false)
    // 签名变更（provider 配置变化）→ 旧条目作废
    initModerationCache(tmp, 'sigB')
    expect(getCached({ url: 'https://whatever', buffer: PNG1x1 })).toBeUndefined()
    rmSync(tmp, { recursive: true, force: true })
  })
})
