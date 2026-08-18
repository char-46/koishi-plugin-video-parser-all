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
 * - 不支持的平台/缺失/损坏 → 立即报精确错误（不等 20s 超时）
 * - 非 Windows 缺执行位 → 自动 chmod 755
 * - exec 探针：同步拉起二进制 1.5s，环境拒绝执行（EPERM/EACCES）或秒退时
 *   干净报错。关键作用：cycletls 内部对 spawn 失败是在事件回调里 throw
 * （未捕获异常，会击溃宿主进程），先探后用可完全绕开该缺陷。
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
  // exec 探针：随机端口拉起后由 timeout 收割。出错/秒退在这里同步暴露。
  const probePort = 20000 + Math.floor(Math.random() * 40000)
  const r = spawnSync(info.path, [], { env: { WS_PORT: String(probePort) }, timeout: 1500, windowsHide: true })
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code || r.error.message
    throw new Error(`cycletls 二进制无法执行（${code}）：${info.path}。${explainSpawnError(String(code), info.path)}`)
  }
  if (r.status !== null) {
    throw new Error(
      `cycletls 二进制启动即退（exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}）：${info.path}。` +
      '可能被安全策略击杀或 CPU 不支持其指令集，请改用第三方解析 API 或更换运行环境。'
    )
  }
  // r.status === null 且无 error：被 timeout 正常收割，说明二进制能存活 → 放行
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

/**
 * 解析 ELF 的 PT_INTERP（动态链接解释器）：
 * 文件存在但 exec 返回 ENOENT 时，几乎总是 glibc 二进制跑在 musl/Alpine 上
 * （解释器 /lib64/ld-linux-x86-64.so.2 不存在）。纯 JS 读 ELF 头确证。
 */
function checkElfInterp(binPath: string): { ok: boolean; interp: string | null; staticLinked: boolean } {
  try {
    const fd = fs.openSync(binPath, 'r')
    try {
      const header = Buffer.alloc(64)
      if (fs.readSync(fd, header, 0, 64, 0) < 64) return { ok: true, interp: null, staticLinked: false }
      if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return { ok: true, interp: null, staticLinked: false }
      const is64 = header[4] === 2
      const phoff = is64 ? Number(header.readBigUInt64LE(0x20)) : header.readUInt32LE(0x1c)
      const phentsize = header.readUInt16LE(is64 ? 0x36 : 0x2a)
      const phnum = header.readUInt16LE(is64 ? 0x38 : 0x2c)
      const ph = Buffer.alloc(phentsize * phnum)
      if (fs.readSync(fd, ph, 0, ph.length, phoff) < ph.length) return { ok: true, interp: null, staticLinked: false }
      for (let i = 0; i < phnum; i++) {
        const off = i * phentsize
        if (ph.readUInt32LE(off) !== 3) continue // PT_INTERP
        const p_offset = is64 ? Number(ph.readBigUInt64LE(off + 0x08)) : ph.readUInt32LE(off + 0x04)
        const p_filesz = is64 ? Number(ph.readBigUInt64LE(off + 0x20)) : ph.readUInt32LE(off + 0x10)
        const buf = Buffer.alloc(p_filesz)
        fs.readSync(fd, buf, 0, p_filesz, p_offset)
        const interp = buf.toString('utf8', 0, buf.indexOf(0)).trim()
        return { ok: fs.existsSync(interp), interp, staticLinked: false }
      }
      return { ok: true, interp: null, staticLinked: true } // 无 PT_INTERP = 静态链接
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { ok: true, interp: null, staticLinked: false }
  }
}

/** 探测当前 Linux 运行时 libc：读 Node 自身 ELF 解释器 + Alpine 标志 */
function detectRuntimeLibc(): { libc: 'glibc' | 'musl' | 'unknown'; alpine: boolean; nodeInterp: string | null } {
  if (process.platform !== 'linux') return { libc: 'unknown', alpine: false, nodeInterp: null }
  const alpine = fs.existsSync('/etc/alpine-release')
  let interp: string | null = null
  try { interp = checkElfInterp(process.execPath).interp } catch {}
  if (interp?.includes('musl')) return { libc: 'musl', alpine, nodeInterp: interp }
  if (interp?.includes('ld-linux')) return { libc: 'glibc', alpine, nodeInterp: interp }
  if (fs.existsSync('/lib/ld-musl-x86_64.so.1')) return { libc: 'musl', alpine, nodeInterp: interp }
  return { libc: 'unknown', alpine, nodeInterp: interp }
}

/** 把 spawn/exec 错误码翻译成精确原因与对策 */
function explainSpawnError(code: string, binPath: string): string {
  if (code === 'EPERM' || code === 'EACCES') {
    return '环境安全策略阻止执行该二进制（容器 seccomp/AppArmor/noexec 挂载/沙箱），cycletls 在此环境不可用，请改用第三方解析 API 或更换运行环境。'
  }
  if (code === 'ENOENT') {
    const ei = checkElfInterp(binPath)
    if (!ei.ok) {
      const rt = detectRuntimeLibc()
      const verdict = rt.libc === 'musl'
        ? `已实锤：运行时是 musl${rt.alpine ? '（Alpine）' : ''}（Node 解释器 ${rt.nodeInterp || '/lib/ld-musl-x86_64.so.1'}），而二进制需要 glibc 解释器 ${ei.interp}。`
        : `二进制需要 glibc 解释器 ${ei.interp}，此环境没有（运行时 libc 探测：${rt.libc}${rt.alpine ? '，Alpine' : ''}）。`
      return (
        `动态链接解释器缺失：${verdict}` +
        '解决：① 容器内安装 glibc 兼容层（apk add gcompat libc6-compat）后重启 Koishi；' +
        '② 或改用 glibc（Debian 版 Node）镜像部署。'
      )
    }
    return '文件在检查后被删除或路径失效，请重装依赖（npm i cycletls --force）。'
  }
  return `请检查文件完整性与权限（${code}）。`
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
 *
 * 全程挂临时 uncaughtException/unhandledRejection 兜底：cycletls 内部会在
 * 事件回调里 throw（其 spawn 失败处理有缺陷），不兜底会击溃宿主 Koishi 进程。
 */
export async function diagnoseTls(): Promise<string[]> {
  const captured: string[] = []
  const onUncaught = (e: any) => { captured.push(`未捕获异常：${e?.message || e}`) }
  const onRejection = (r: any) => { captured.push(`未处理拒绝：${r?.message || r}`) }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  let lines: string[] = []
  try {
    lines = await doDiagnose()
  } catch (e: any) {
    lines.push(`诊断流程异常：${e?.message || e}`)
  } finally {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
  }
  for (const c of captured) lines.push(`[!] ${c}`)
  if (captured.length) lines.push('结论：cycletls 内部抛出了未捕获异常（其 spawn 失败处理的缺陷），以上异常信息即根因。')
  return lines
}

async function doDiagnose(): Promise<string[]> {
  const lines: string[] = []
  {
    const rt = detectRuntimeLibc()
    const libcInfo = process.platform === 'linux'
      ? `，libc：${rt.libc}${rt.alpine ? '（Alpine）' : ''}`
      : ''
    lines.push(`[0] 平台 ${process.platform}/${process.arch}，Node ${process.versions.node}${libcInfo}`)
  }

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
  if (process.platform !== 'win32') {
    const ei = checkElfInterp(bin.path)
    if (ei.staticLinked) lines.push('[1] ✓ 静态链接（无外部运行时依赖）')
    else if (ei.interp) lines.push(ei.ok
      ? `[1] ✓ 动态链接，解释器 ${ei.interp} 存在`
      : `[1] ✗ 动态链接，解释器 ${ei.interp} 缺失（Alpine/musl 环境跑 glibc 二进制会 exec 报 ENOENT）`)
  }

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
  let spawnErr: any = null
  try {
    child = spawn(bin.path, [], {
      env: { WS_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // 必须监听 error：spawn 异步失败（fork 成功、execve 被拒）以事件送达，
    // 无监听器的 'error' 事件会直接击溃宿主进程（即"diag 重启 koishi"的元凶）
    child.on('error', (e) => { spawnErr = e })
    child.stdout?.on('data', () => {}) // 消费 stdout，防止管道写满阻塞子进程
    child.stderr?.on('data', (d) => { if (stderr.length < 500) stderr += String(d) })
    await new Promise((r) => setTimeout(r, 2000))
    if (spawnErr) {
      const code = spawnErr.code || spawnErr.message
      lines.push(`[3] ✗ 二进制无法执行（${code}）。${explainSpawnError(String(code), bin.path)}`)
      return lines
    }
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
