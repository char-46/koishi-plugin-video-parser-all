import { spawn, spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'

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
const DEFAULT_PORT = 9119

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
// cycletls 2.0.5 的 InstanceManager 在 initialize() 前就把实例按端口写入缓存，
// 初始化失败后该端口留下"坏实例"，同端口重试不会再 spawn。轮换端口绕开。
let nextPort = DEFAULT_PORT

/** 与 cycletls 内部 PLATFORM_BINARIES 一致的二进制映射 */
const PLATFORM_BINARIES: Record<string, Record<string, string>> = {
  win32: { x64: 'index.exe' },
  linux: { arm: 'index-arm', arm64: 'index-arm64', x64: 'index' },
  darwin: { x64: 'index-mac', arm: 'index-mac-arm', arm64: 'index-mac-arm64' },
  freebsd: { x64: 'index-freebsd' },
}

/** 定位 cycletls 二进制；返回 null 表示模块未安装（由调用方报"未安装"） */
function locateBinary(): { path: string; exists: boolean; size: number; mode: number } | null {
  const bin = PLATFORM_BINARIES[process.platform]?.[process.arch]
  if (!bin) return null
  let distDir: string
  try {
    distDir = path.dirname(require.resolve('cycletls'))
  } catch {
    return null
  }
  const p = path.join(distDir, bin)
  try {
    const st = fs.statSync(p)
    return { path: p, exists: true, size: st.size, mode: st.mode }
  } catch {
    return { path: p, exists: false, size: 0, mode: 0 }
  }
}

/**
 * 预检并自愈 cycletls 二进制：
 * - 不支持的平台/缺失二进制 → 立即报精确错误（不等 20s 超时）
 * - 非 Windows 缺执行位 → 自动 chmod 755（复制/同步丢权限是最常见的 Linux 故障）
 */
function preflightBinary(): void {
  const bin = PLATFORM_BINARIES[process.platform]?.[process.arch]
  if (!bin) {
    throw new Error(`cycletls 不支持当前平台 ${process.platform}/${process.arch}，无法解析需登录的 X 推文`)
  }
  const info = locateBinary()
  if (!info) return // 模块未安装，走 getClient 的"未安装"分支
  if (!info.exists) {
    throw new Error(`cycletls 二进制缺失：${info.path}。请在 Koishi 应用目录重装依赖：npm i cycletls --force`)
  }
  if (info.size < 1024 * 1024) {
    throw new Error(`cycletls 二进制疑似损坏（仅 ${info.size} 字节）：${info.path}。请重装依赖：npm i cycletls --force`)
  }
  if (process.platform !== 'win32') {
    const executable = !!(info.mode & 0o111)
    if (!executable) {
      try {
        fs.chmodSync(info.path, 0o755)
      } catch {
        throw new Error(
          `cycletls 二进制无执行权限且自动修复失败：${info.path}。` +
          `请手动执行：chmod +x "${info.path}" 后重试`
        )
      }
    }
  }
}

/** 按平台给出对症的排查提示 */
function platformHints(): string {
  if (process.platform === 'win32') {
    return '常见原因：① 杀毒软件拦截/隔离了 node_modules/cycletls/dist/index.exe（加白名单后重装依赖）；' +
      '② 端口 9119 被占用（netstat -ano | findstr 9119）；③ 运行环境禁止 spawn 子进程。'
  }
  if (process.platform === 'linux') {
    return '常见原因：① 二进制被拦截或启动即崩（手动验证：WS_PORT=9119 node_modules/cycletls/dist/index，观察是否存活）；' +
      '② 端口被占用（ss -tlnp | grep 9119）；③ 容器禁止 spawn 子进程（检查 seccomp/AppArmor/gVisor）。'
  }
  return '常见原因：① 二进制缺执行权限（chmod +x）；② 端口 9119 被占用（lsof -i :9119）；③ 运行环境禁止 spawn 子进程。'
}

/**
 * 运行时探针：用 node 自身派生一个无害子进程，判定环境是否允许 spawn。
 * Koishi 框架本身不限制子进程；被禁止只可能来自宿主环境（容器 seccomp/
 * AppArmor/gVisor、云函数、AppLocker、杀软）。返回 null 表示 spawn 可用。
 */
function probeSpawn(): string | null {
  try {
    const r = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 })
    if (r.error) return `Node 自探测失败（${(r.error as NodeJS.ErrnoException).code || r.error.message}）`
    return null
  } catch (e: any) {
    return `Node 自探测异常（${e?.message || e}）`
  }
}

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
      preflightBinary()
      try {
        const c = await init({ port: nextPort })
        nextPort = DEFAULT_PORT
        return c
      } catch (e: any) {
        // 初始化失败不缓存，且换端口重试（绕开 cycletls 毒化的共享实例缓存）
        clientPromise = null
        nextPort = 20000 + Math.floor(Math.random() * 40000)
        // cycletls 内部 reject 的是字符串（无 .message），外层包装后 message 变成 "undefined"
        const raw = typeof e === 'string' ? e : String(e?.message || e)
        if (/Failed to initialize CycleTLS|Could not connect to the CycleTLS instance/i.test(raw)) {
          const probe = probeSpawn()
          const probeMsg = probe === null
            ? '自检：本环境可正常 spawn 子进程，问题应出在 cycletls 二进制本身（被拦截/崩溃）。'
            : `自检：${probe}，此环境禁止派生子进程，cycletls 无法使用，请改用第三方解析 API 或更换运行环境。`
          const bin = locateBinary()
          const binMsg = bin
            ? `二进制：${bin.path}（${bin.exists ? `${(bin.size / 1048576).toFixed(1)}MB，权限 ${(bin.mode & 0o777).toString(8)}` : '缺失'}）。`
            : ''
          throw new Error(
            `CycleTLS 子进程初始化失败（20 秒内无法连接 ws://localhost:${DEFAULT_PORT}，平台 ${process.platform}/${process.arch}）。` +
            probeMsg + binMsg + platformHints()
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

/** 检查端口占用（与 cycletls 相同的探测方式） */
function checkPortFree(port: number): Promise<'free' | 'occupied'> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve('occupied'))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve('free')))
  })
}

/**
 * 无 shell 环境的完整自检（供 parse/diag 命令调用）：
 * 逐项输出 cycletls 依赖链每一环的状态，失败环节即根因。
 */
export async function diagnoseTls(): Promise<string[]> {
  const lines: string[] = []
  lines.push(`[0] 平台 ${process.platform}/${process.arch}，Node ${process.versions.node}`)

  const bin = locateBinary()
  if (!bin) {
    lines.push('[1] ✗ cycletls 模块未安装（npm i cycletls）')
    return lines
  }
  if (!bin.exists) {
    lines.push(`[1] ✗ 二进制缺失：${bin.path}（npm i cycletls --force 重装）`)
    return lines
  }
  lines.push(`[1] ✓ 二进制存在：${bin.path}（${(bin.size / 1048576).toFixed(1)}MB，权限 ${(bin.mode & 0o777).toString(8)}）`)
  if (bin.size < 1024 * 1024) lines.push('[1] ⚠ 体积异常偏小，疑似损坏，建议重装')

  const probe = probeSpawn()
  if (probe) {
    lines.push(`[2] ✗ spawn 探针失败：${probe}（环境禁止派生子进程）`)
    return lines
  }
  lines.push('[2] ✓ spawn 探针：可派生子进程')

  // 直接拉起二进制（随机端口），验证其能否存活并监听
  const port = 20000 + Math.floor(Math.random() * 40000)
  let child: ChildProcess | null = null
  let stderr = ''
  try {
    child = spawn(bin.path, [], {
      env: { WS_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stderr?.on('data', (d) => { if (stderr.length < 500) stderr += String(d) })
    await new Promise((r) => setTimeout(r, 2000))
    if (child.exitCode !== null) {
      lines.push(`[3] ✗ 二进制启动即退（exit=${child.exitCode}${child.signalCode ? ' signal=' + child.signalCode : ''}）` +
        (stderr.trim() ? `，stderr：${stderr.trim().slice(0, 300)}` : '（无输出，可能被安全策略静默击杀或 CPU 不支持指令集）'))
      return lines
    }
    const listening = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1', timeout: 3000 })
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      s.once('timeout', () => { s.destroy(); resolve(false) })
    })
    lines.push(listening
      ? `[3] ✓ 二进制可存活并监听 127.0.0.1:${port}`
      : `[3] ✗ 二进制存活但未监听端口（环境禁止绑定端口）${stderr.trim() ? '，stderr：' + stderr.trim().slice(0, 300) : ''}`)
  } finally {
    try { child?.kill('SIGKILL') } catch {}
  }

  // 默认端口 9119 占用情况
  lines.push(`[4] 端口 9119：${await checkPortFree(9119) === 'free' ? '空闲 ✓' : '已被占用 ⚠（若是其他实例的 cycletls 属正常共享；否则会抢答握手导致初始化超时）'}`)

  // 完整初始化（随机端口，避开可能被污染的 9119）
  try {
    const mod = await import('cycletls')
    const init = (mod as any).default || mod
    const c = await init({ port: 30000 + Math.floor(Math.random() * 20000), timeout: 15000 })
    lines.push('[5] ✓ initCycleTLS 完整初始化成功')
    try { await c.exit() } catch {}
    lines.push('结论：环境正常。若解析仍报初始化失败，多半是 9119 被非 cycletls 进程占用（见 [4]）。')
  } catch (e: any) {
    const raw = typeof e === 'string' ? e : String(e?.message || e)
    lines.push(`[5] ✗ initCycleTLS 完整初始化失败：${raw}`)
    lines.push('结论：二进制可 spawn 但 JS 侧连不上，请把以上全部输出发给维护者。')
  }
  return lines
}
