import { Context, h } from 'koishi'
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import { name, Config } from './config'
import type { ParsedData, LinkMatch, ApiItem, CustomPlatformConfig } from './types'
import { SimpleLRUCache } from './utils/cache'
import { ConcurrencyLimiter } from './utils/concurrency'
import { logger, debugLog, setDebugEnabled } from './utils/logger'
import { delay, getErrorMessage, contentFingerprint } from './utils/common'
import { parseFieldMapping } from './utils/field-mapping'
import { generateFormattedText } from './utils/format'
import { linkTypeParser, extractAllUrlsFromMessage } from './utils/url'
import { parseApiResponse } from './engine/parser'
import { buildForwardNode } from './sender/forward'
import { BUILTIN_LINK_RULES } from './platforms/rules'
import { defaultDedicatedApis } from './platforms/dedicated-apis'
import { buildCustomLinkRules, buildAuthHeaders } from './platforms/custom'

export { name, Config }

export function apply(ctx: Context, config: any) {
  setDebugEnabled(config.debug || false)
  debugLog('INFO', 'plugin start')

  const dedupCache = new SimpleLRUCache<number>(1000, config.deduplicationInterval * 1000)
  const cacheTTL = (config.cacheTTL || 600) * 1000
  const urlCacheLocal = new SimpleLRUCache<{ data: ParsedData; expire: number }>(500, cacheTTL)
  const contentDedupCache = new SimpleLRUCache<number>(1000, config.deduplicationInterval * 1000)

  function getText(key: string): string {
    const defaults: Record<string, string> = {
      waitingTipText: '正在解析视频，请稍候...',
      unsupportedPlatformText: '不支持该平台链接',
      invalidLinkText: '无效的视频链接',
      parseErrorPrefix: '❌ 解析失败：',
      parseErrorItemFormat: '【${url}】: ${msg}',
      deduplicationTipText: '链接 ${url} 在最近 ${interval} 秒内已解析过，已跳过。',
    }
    return config[key] || defaults[key] || ''
  }

  const proxyConfig = config.proxy || {}
  const customPlatforms: CustomPlatformConfig[] = (config.customPlatforms || []).map((p: any) => ({
    name: p.name,
    apiUrl: p.apiUrl,
    apiKey: p.apiKey || '',
    authHeaderType: p.authHeaderType || 'Bearer',
    customHeaderName: p.customHeaderName || 'X-API-Key',
    fieldMapping: parseFieldMapping(p.fieldMapping),
    proxy: p.proxy || null
  }))

  function getPlatformConfig(type: string): { apiUrl: string | null; dedicatedFirst: boolean; apiKey: string; authHeaderType: string; customHeaderName: string; fieldMapping?: Record<string, string>; customProxy?: any } {
    if (type.startsWith('custom_')) {
      const name = type.slice(7)
      const custom = customPlatforms.find(p => p.name === name)
      if (custom) {
        return {
          apiUrl: custom.apiUrl,
          dedicatedFirst: true,
          apiKey: custom.apiKey || '',
          authHeaderType: custom.authHeaderType,
          customHeaderName: custom.customHeaderName,
          fieldMapping: custom.fieldMapping,
          customProxy: custom.proxy
        }
      }
      return { apiUrl: null, dedicatedFirst: false, apiKey: '', authHeaderType: 'Bearer', customHeaderName: 'X-API-Key' }
    }

    const custom = config.customApis?.find((item: any) => item.platform === type)
    let apiUrl = defaultDedicatedApis[type] || null
    let apiKey = ''
    let authHeaderType = 'Bearer'
    let customHeaderName = 'X-API-Key'
    let fieldMapping: Record<string, string> | undefined = undefined
    if (custom && custom.apiUrl) {
      apiUrl = custom.apiUrl
      apiKey = custom.apiKey || ''
      authHeaderType = custom.authHeaderType || 'Bearer'
      customHeaderName = custom.customHeaderName || 'X-API-Key'
      fieldMapping = parseFieldMapping(custom.fieldMapping)
    } else {
      apiKey = ''
    }
    const dedicatedFirst = config.platformDedicatedFirst?.[type] ?? false
    if (!fieldMapping) {
      fieldMapping = parseFieldMapping(config.globalFieldMapping)
    }
    return { apiUrl, dedicatedFirst, apiKey, authHeaderType, customHeaderName, fieldMapping }
  }

  async function sendWithTimeout(session: any, content: any, customRetries?: number): Promise<any> {
    const maxRetries = customRetries ?? config.retryTimes ?? 3
    const retryDelay = config.retryInterval || 1000
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let sendPromise = session.send(content)
        if (config.videoSendTimeout > 0) {
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('发送超时')), config.videoSendTimeout))
          return await Promise.race([sendPromise, timeoutPromise])
        } else {
          return await sendPromise
        }
      } catch (err) {
        const errMsg = getErrorMessage(err)
        debugLog('ERROR', `发送失败尝试 ${attempt+1}: ${errMsg}`)
        if (attempt < maxRetries) await delay(retryDelay)
        else if (!config.ignoreSendError) throw err
      }
    }
    return null
  }

  async function sendMedia(
    session: any,
    url: string,
    type: 'image' | 'video' | 'audio',
    showFile: boolean
  ) {
    if (!url) return
    if (!showFile) {
      await sendWithTimeout(session, `${type === 'audio' ? '音乐' : type === 'video' ? '视频' : '图片'}链接：${url}`).catch(() => {})
      return
    }
    try {
      await sendWithTimeout(session, type === 'audio' ? h.audio(url) : type === 'video' ? h.video(url) : h.image(url))
    } catch {
      await sendWithTimeout(session, `${type === 'audio' ? '音乐' : type === 'video' ? '视频' : '图片'}链接：${url}`).catch(() => {})
    }
  }

  async function flush(session: any, matches: LinkMatch[]) {
    debugLog('INFO', `开始解析 ${matches.length} 个链接`)
    const items: { text: string; parsed: ParsedData }[] = []
    const errors: string[] = []
    const limiter = new ConcurrencyLimiter(config.maxConcurrent || 3)
    const promises = matches.map(async (match) => {
      await limiter.acquire()
      try {
        const platformEnabled = config.platformEnabled?.[match.type] ?? true
        if (!platformEnabled && !match.type.startsWith('custom_')) {
          debugLog('INFO', `平台 ${match.type} 已禁用，跳过链接: ${match.url}`)
          return
        }
        if (config.enableDeduplication !== false && config.deduplicationInterval > 0) {
          const lastTime = dedupCache.get(match.url)
          if (lastTime && (Date.now() - lastTime < config.deduplicationInterval * 1000)) {
            debugLog('INFO', `跳过重复链接: ${match.url}`)
            const shortUrl = match.url.length > 80 ? match.url.slice(0, 80) + '...' : match.url
            const tip = getText('deduplicationTipText').replace(/\$\{url\}/g, shortUrl).replace(/\$\{interval\}/g, String(config.deduplicationInterval))
            await sendWithTimeout(session, tip).catch(() => {})
            return
          }
        }
        debugLog('INFO', `解析链接: ${match.url} (${match.type})`)
        const platformConf = getPlatformConfig(match.type)
        const fieldMapping = platformConf.fieldMapping
        const result = await processSingleUrl(match.url, match.type, fieldMapping, platformConf)
        if (result.success) {
          if (config.enableDeduplication !== false && config.deduplicationInterval > 0) {
            const fp = contentFingerprint(result.data.parsed)
            const lastDedup = contentDedupCache.get(fp)
            if (lastDedup && (Date.now() - lastDedup < config.deduplicationInterval * 1000)) {
              debugLog('INFO', `跳过重复内容: ${match.url}`)
              return
            }
            contentDedupCache.set(fp, Date.now())
            dedupCache.set(match.url, Date.now())
          }
          items.push(result.data)
        } else {
          const displayUrl = match.url.length > 80 ? match.url.slice(0, 80) + '...' : match.url
          const item = getText('parseErrorItemFormat').replace(/\$\{url\}/g, displayUrl).replace(/\$\{msg\}/g, result.msg)
          errors.push(item)
        }
      } finally {
        limiter.release()
      }
    })
    await Promise.all(promises)

    if (errors.length) await sendWithTimeout(session, `${getText('parseErrorPrefix')}\n${errors.join('\n')}`)
    if (!items.length) return

    const totalItems = items.length
    const enableForward = config.enableForward && (session.platform === 'onebot' || session.platform === 'satori')
    const botName = config.botName || '视频解析机器人'
    if (enableForward) {
      const forwardMessages: any[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const p = item.parsed
        const textWithIndex = (totalItems > 1) ? `【${i + 1}/${totalItems}】\n${item.text}` : item.text
        let text = textWithIndex
        if (config.showAuthorAvatar && p.avatar && config.showAuthorAvatarText) {
          text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
        }
        if (text && config.showImageText) {
          forwardMessages.push(buildForwardNode(session, text, botName))
        }
        if (config.showAuthorAvatar && p.avatar) {
          forwardMessages.push(buildForwardNode(session, h.image(p.avatar), botName))
        }
        if (p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
          if (config.showCoverText) {
            forwardMessages.push(buildForwardNode(session, config.coverText || '封面：', botName))
          }
          forwardMessages.push(buildForwardNode(session, h.image(p.cover), botName))
        }
        if (config.showMusicCover && p.music.cover) {
          forwardMessages.push(buildForwardNode(session, h.image(p.music.cover), botName))
        }
        if (p.type === 'live_photo' && p.live_photo?.length) {
          for (const lp of p.live_photo) {
            forwardMessages.push(buildForwardNode(session, h.image(lp.image), botName))
          }
        } else if (p.type === 'image' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? [])
          for (const imgUrl of imageUrls) {
            forwardMessages.push(buildForwardNode(session, h.image(imgUrl), botName))
          }
        }
        if (p.video && p.type !== 'live' && p.type !== 'live_photo') {
          forwardMessages.push(buildForwardNode(session, h.video(p.video), botName))
        }
        if (config.showMusicVoice && p.music.url) {
          forwardMessages.push(buildForwardNode(session, h.audio(p.music.url), botName))
        }
      }

      const MAX_NODES = 50
      for (let i = 0; i < forwardMessages.length; i += MAX_NODES) {
        const batch = forwardMessages.slice(i, i + MAX_NODES)
        try {
          await sendWithTimeout(session, h('message', { forward: true }, batch), config.retryTimes)
        } catch (err) {
          debugLog('ERROR', '合并转发失败，降级逐条发送:', err)
          for (const node of batch) {
            await sendWithTimeout(session, node.data.content).catch(() => {})
            await delay(300)
          }
        }
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const p = item.parsed
        const textWithIndex = (totalItems > 1) ? `【${i + 1}/${totalItems}】\n${item.text}` : item.text
        let text = textWithIndex
        if (config.showAuthorAvatar && p.avatar && config.showAuthorAvatarText) {
          text = text ? text + '\n' + (config.authorAvatarText || '作者头像：') : (config.authorAvatarText || '作者头像：')
        }
        if (text && config.showImageText) { await sendWithTimeout(session, text); await delay(300) }
        if (config.showAuthorAvatar && p.avatar) {
          await sendMedia(session, p.avatar, 'image', config.showAuthorAvatarFile).catch(() => {})
          await delay(300)
        }
        if (p.cover && config.showCoverImage && p.type !== 'live_photo' && p.type !== 'image' && p.type !== 'live') {
          if (config.showCoverText) await sendWithTimeout(session, config.coverText || '封面：')
          await sendMedia(session, p.cover, 'image', config.showCoverFile).catch(() => {})
          await delay(300)
        }
        if (config.showMusicCover && p.music.cover) {
          await sendMedia(session, p.music.cover, 'image', true).catch(() => {})
          await delay(300)
        }
        if (p.type === 'live_photo' && p.live_photo?.length) {
          for (const lp of p.live_photo) {
            await sendMedia(session, lp.image, 'image', config.showImageFileNew).catch(() => {})
            await delay(500)
          }
        } else if (p.type === 'image' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? [])
          for (let j = 0; j < imageUrls.length; j++) {
            logger.info(`[发送] 图片 ${j+1}/${imageUrls.length}`)
            await sendMedia(session, imageUrls[j], 'image', config.showImageFileNew).catch(() => {})
            await delay(1000)
          }
        }
        if (p.type === 'live' && config.sendLiveMessage) {
          await sendWithTimeout(session, '直播进行中，无法发送视频流。').catch(() => {})
        }
        if (config.showMusicVoice && p.music.url) {
          await sendMedia(session, p.music.url, 'audio', config.showMusicVoiceFile).catch(() => {})
          await delay(300)
        }
      }
    }
    debugLog('INFO', '处理完成')
  }

  async function fetchApi(url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<ParsedData> {
    const cacheKey = url
    const cached = urlCacheLocal.get(cacheKey)
    if (cached && cached.expire > Date.now()) return cached.data

    const { apiUrl: dedicatedUrl, dedicatedFirst, apiKey, authHeaderType, customHeaderName, customProxy } = platformConf || getPlatformConfig(type)
    const primaryApi = config.primaryApiUrl || 'https://api.bugpk.com/api/short_videos'
    const backupApi = config.backupApiUrl || 'https://api.bugpk.com/api/svparse'
    const backupAllowed = new Set(['douyin', 'xiaohongshu', 'instagram', 'jimeng']).has(type)

    const apiList: ApiItem[] = []
    if (dedicatedFirst && dedicatedUrl) {
      apiList.push({ url: dedicatedUrl, label: `专属API(${type})`, apiKey, authHeaderType, customHeaderName, fieldMapping })
      apiList.push({ url: primaryApi, label: '默认主API', fieldMapping })
      if (backupAllowed) apiList.push({ url: backupApi, label: '备用主API', fieldMapping })
    } else {
      apiList.push({ url: primaryApi, label: '默认主API', fieldMapping })
      if (backupAllowed) apiList.push({ url: backupApi, label: '备用主API', fieldMapping })
      if (dedicatedUrl) apiList.push({ url: dedicatedUrl, label: `专属API(${type})`, apiKey, authHeaderType, customHeaderName, fieldMapping })
    }

    if (type.startsWith('custom_') && apiList.length === 0 && dedicatedUrl) {
      apiList.push({ url: dedicatedUrl, label: `自定义API(${type})`, apiKey, authHeaderType, customHeaderName, fieldMapping })
    }

    const customHeaders = config.customHeaders || []
    let lastError: Error | null = null
    for (const api of apiList) {
      for (let attempt = 0; attempt <= config.retryTimes; attempt++) {
        try {
          const headers: any = {
            'User-Agent': config.userAgent,
            'Referer': 'https://www.baidu.com/',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
          for (const h of customHeaders) {
            if (h.name && h.value) headers[h.name] = h.value
          }
          if (api.apiKey) {
            const authHeaders = buildAuthHeaders(api.apiKey, api.authHeaderType || 'Bearer', api.customHeaderName || 'X-API-Key')
            Object.assign(headers, authHeaders)
          }
          const proxyToUse = customProxy && customProxy.enabled ? customProxy : (proxyConfig.enabled ? proxyConfig : undefined)
          const axiosConfigLocal: AxiosRequestConfig = {
            params: { url },
            timeout: config.timeout,
            headers,
            proxy: proxyToUse && proxyToUse.host ? {
              protocol: proxyToUse.protocol || 'http',
              host: proxyToUse.host,
              port: proxyToUse.port || 7890,
              auth: proxyToUse.auth?.username ? { username: proxyToUse.auth.username, password: proxyToUse.auth.password || '' } : undefined
            } : undefined
          }
          const res = await http.get(api.url, axiosConfigLocal)
          if (res.data && (res.data.code === 200 || res.data.code === 0)) {
            const parsed = parseApiResponse(res.data, config.maxDescLength, api.fieldMapping)
            urlCacheLocal.set(cacheKey, { data: parsed, expire: Date.now() + cacheTTL })
            return parsed
          }
          throw new Error(res.data?.msg || `API返回错误码: ${res.data?.code}`)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          debugLog('ERROR', `${api.label} attempt ${attempt+1} failed: ${lastError.message}`)
          if (axios.isAxiosError(error)) {
            if (!error.response) {
              if (attempt < config.retryTimes) { await delay(config.retryInterval); continue }
            }
            const status = error.response?.status
            if (status && (status >= 500 || status === 429)) {
              if (attempt < config.retryTimes) { await delay(config.retryInterval); continue }
            }
          }
          break
        }
      }
      debugLog('WARN', `${api.label} all retries failed`)
    }
    throw lastError || new Error('所有API请求全部失败')
  }

  async function parseUrl(url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<{ success: true; data: ParsedData } | { success: false; msg: string }> {
    try {
      const info = await fetchApi(url, type, fieldMapping, platformConf)
      if (info.video || info.images.length > 0 || info.live_photo.length > 0) return { success: true, data: info }
      debugLog('WARN', `解析成功但无内容: ${url}`)
      return { success: false, msg: '解析接口返回空内容' }
    } catch (error) {
      debugLog('ERROR', `解析失败: ${url}`, getErrorMessage(error))
      return { success: false, msg: getErrorMessage(error) }
    }
  }

  async function processSingleUrl(url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<{ success: true; data: { text: string; parsed: ParsedData } } | { success: false; msg: string; url: string }> {
    const result = await parseUrl(url, type, fieldMapping, platformConf)
    if (!result.success) return { success: false, msg: result.msg, url }
    const text = generateFormattedText(result.data, config.unifiedMessageFormat)
    return { success: true, data: { text, parsed: result.data } }
  }

  const customRules = buildCustomLinkRules(config.customPlatforms || [])
  const allRules = [...BUILTIN_LINK_RULES, ...customRules]

  const axiosConfig: AxiosRequestConfig = {
    timeout: config.timeout,
    headers: {
      'User-Agent': config.userAgent,
      'Referer': 'https://www.baidu.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }
  if (proxyConfig.enabled && proxyConfig.host) {
    axiosConfig.proxy = {
      protocol: proxyConfig.protocol || 'http',
      host: proxyConfig.host,
      port: proxyConfig.port || 7890,
      auth: proxyConfig.auth?.username ? {
        username: proxyConfig.auth.username,
        password: proxyConfig.auth.password || ''
      } : undefined
    }
  }
  const http: AxiosInstance = axios.create(axiosConfig)

  ctx.on('message', async (session) => {
    if (!config.enable) return
    if (/^\s*parse\b/i.test(session.content || '')) return
    if (session.subtype === 'file_upload') return
    if (session.elements?.some(elem => elem.type === 'file' || elem.type === 'folder')) return
    if (session.selfId === session.userId) return
    const matches = extractAllUrlsFromMessage(session, allRules)
    if (!matches.length) return
    debugLog('INFO', `检测到 ${matches.length} 个链接`)
    if (config.showWaitingTip) {
      try {
        await sendWithTimeout(session, h.quote(session.messageId) + getText('waitingTipText'))
      } catch(e) {
        debugLog('WARN', '等待提示发送失败:', e)
      }
    }
    await flush(session, matches)
  })

  ctx.command('parse <url>', '手动解析视频').action(async ({ session }, url) => {
    if (!url) { await sendWithTimeout(session, getText('invalidLinkText')); return }
    const matches = linkTypeParser(url, allRules)
    if (!matches.length) { await sendWithTimeout(session, getText('invalidLinkText')); return }
    if (config.showWaitingTip) {
      try {
        await sendWithTimeout(session, h.quote(session?.messageId) + getText('waitingTipText'))
      } catch {}
    }
    await flush(session, matches)
  })

  ctx.on('dispose', () => {
    urlCacheLocal.clear()
    dedupCache.clear()
    debugLog('INFO', '插件已卸载')
  })

  debugLog('INFO', '插件初始化完成')
}
