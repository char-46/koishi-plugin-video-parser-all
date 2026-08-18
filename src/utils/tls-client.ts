/**
 * TLS 指纹模拟 HTTP 客户端（惰性）。
 *
 * X/Twitter 的 GraphQL 受 Cloudflare TLS 指纹校验保护：普通 Node/axios 的
 * TLS 握手(JA3/JA4)与 Chrome 不同，会被 CF 直接 403。此模块用 cycletls
 * （基于 utls 的 Go 二进制，模拟 Chrome 指纹）发起请求，从而通过 CF。
 *
 * cycletls 为 optionalDependency（原生二进制），仅在需要时惰性加载；
 * 未安装时抛出明确错误，调用方据此降级。
 */

const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface TlsGetOptions {
  headers?: Record<string, string>
  cookies?: Record<string, string>
  timeout?: number
}

export interface TlsResponse {
  status: number
  data: any
}

let clientPromise: Promise<any> | null = null

async function getClient(): Promise<any> {
  if (!clientPromise) {
    clientPromise = (async () => {
      let init: any
      try {
        const mod = await import('cycletls')
        init = (mod as any).default || mod
      } catch (e) {
        // 未安装：不缓存失败，装好后无需重启即可生效
        clientPromise = null
        throw new Error('TLS 指纹模拟库 cycletls 未安装（可选依赖）。解析需登录的 X 推文需要它：npm i cycletls')
      }
      try {
        return await init()
      } catch (e: any) {
        // 初始化失败同样不缓存，下次解析时自动重试
        clientPromise = null
        // cycletls 内部 reject 的是字符串（无 .message），外层包装后 message 变成 "undefined"
        const raw = typeof e === 'string' ? e : String(e?.message || e)
        if (/Failed to initialize CycleTLS|Could not connect to the CycleTLS instance/i.test(raw)) {
          throw new Error(
            'CycleTLS 子进程初始化失败（20 秒内无法连接 ws://localhost:9119）。' +
            '常见原因：① 杀毒软件拦截/隔离了 node_modules/cycletls/dist/index.exe（请加白名单后重装依赖）；' +
            '② 端口 9119 被其他进程占用（netstat -ano | findstr 9119）；' +
            '③ 运行环境禁止 spawn 子进程。'
          )
        }
        throw new Error(`CycleTLS 初始化失败：${raw}`)
      }
    })()
  }
  return clientPromise
}

export async function tlsGet(url: string, opts: TlsGetOptions = {}): Promise<TlsResponse> {
  const c = await getClient()
  const r = await c(url, {
    method: 'GET',
    ja3: CHROME_JA3,
    userAgent: CHROME_UA,
    headers: opts.headers || {},
    cookies: opts.cookies || {},
    timeout: Math.max(1, Math.floor((opts.timeout || 30000) / 1000)),
  })
  return { status: r.status, data: r.data }
}

/** 测试/无 cycletls 环境可注入替换（见 twitter.test.ts） */
export async function shutdownTlsClient(): Promise<void> {
  if (clientPromise) {
    try {
      const c = await clientPromise
      if (c && typeof c.exit === 'function') await c.exit()
    } catch {}
    clientPromise = null
  }
}
