import axios, { AxiosRequestConfig } from 'axios'
import type { ParserRuntime } from '../runtime'
import type { ParsedData, ApiItem } from '../types'
import { debugLog } from '../utils/logger'
import { delay, getErrorMessage } from '../utils/common'
import { generateFormattedText } from '../utils/format'
import { parseApiResponse } from './parser'
import { getPlatformConfig, buildAuthHeaders } from '../platforms/custom'
import { parseTwitter } from '../platforms/twitter'

export async function fetchApi(rt: ParserRuntime, url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<ParsedData> {
  const { config, http, urlCacheLocal, proxyConfig, cacheTTL } = rt
  const cacheKey = url
  const cached = urlCacheLocal.get(cacheKey)
  if (cached && cached.expire > Date.now()) return cached.data

  const { apiUrl: dedicatedUrl, dedicatedFirst, apiKey, authHeaderType, customHeaderName, customProxy } = platformConf || getPlatformConfig(rt, type)

  // X / Twitter：bugpk 统一 API 不支持，走原生 syndication 解析（除非用户自定义了 API）
  if (type === 'twitter' && !dedicatedUrl) {
    debugLog('INFO', 'twitter 走原生 syndication 解析:', url)
    const twCreds = (config.twitterAuthToken && config.twitterCt0)
      ? { authToken: String(config.twitterAuthToken), ct0: String(config.twitterCt0) }
      : undefined
    const parsed = await parseTwitter(url, http, twCreds)
    urlCacheLocal.set(cacheKey, { data: parsed, expire: Date.now() + cacheTTL })
    return parsed
  }

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

export async function parseUrl(rt: ParserRuntime, url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<{ success: true; data: ParsedData } | { success: false; msg: string }> {
  try {
    const info = await fetchApi(rt, url, type, fieldMapping, platformConf)
    if (info.video || info.images.length > 0 || info.live_photo.length > 0) return { success: true, data: info }
    debugLog('WARN', `解析成功但无内容: ${url}`)
    return { success: false, msg: '解析接口返回空内容' }
  } catch (error) {
    debugLog('ERROR', `解析失败: ${url}`, getErrorMessage(error))
    return { success: false, msg: getErrorMessage(error) }
  }
}

export async function processSingleUrl(rt: ParserRuntime, url: string, type: string, fieldMapping?: Record<string, string>, platformConf?: any): Promise<{ success: true; data: { text: string; parsed: ParsedData } } | { success: false; msg: string; url: string }> {
  const { config } = rt
  const result = await parseUrl(rt, url, type, fieldMapping, platformConf)
  if (!result.success) return { success: false, msg: result.msg, url }
  const text = generateFormattedText(result.data, config.unifiedMessageFormat)
  return { success: true, data: { text, parsed: result.data } }
}
