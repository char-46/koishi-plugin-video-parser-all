import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import type { Context } from 'koishi'
import type { ParsedData, CustomPlatformConfig } from './types'
import { SimpleLRUCache } from './utils/cache'
import { parseFieldMapping } from './utils/field-mapping'
import { BUILTIN_LINK_RULES } from './platforms/rules'
import { buildCustomLinkRules } from './platforms/custom'

export interface ParserRuntime {
  ctx: Context
  config: any
  http: AxiosInstance
  proxyConfig: any
  cacheTTL: number
  dedupCache: SimpleLRUCache<number>
  urlCacheLocal: SimpleLRUCache<{ data: ParsedData; expire: number }>
  contentDedupCache: SimpleLRUCache<number>
  customPlatforms: CustomPlatformConfig[]
  allRules: { pattern: RegExp; type: string }[]
}

export function createRuntime(ctx: Context, config: any): ParserRuntime {
  const dedupCache = new SimpleLRUCache<number>(1000, config.deduplicationInterval * 1000)
  const cacheTTL = (config.cacheTTL || 600) * 1000
  const urlCacheLocal = new SimpleLRUCache<{ data: ParsedData; expire: number }>(500, cacheTTL)
  const contentDedupCache = new SimpleLRUCache<number>(1000, config.deduplicationInterval * 1000)

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

  return {
    ctx,
    config,
    http,
    proxyConfig,
    cacheTTL,
    dedupCache,
    urlCacheLocal,
    contentDedupCache,
    customPlatforms,
    allRules,
  }
}
