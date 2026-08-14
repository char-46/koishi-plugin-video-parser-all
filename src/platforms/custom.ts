import type { ParserRuntime } from '../runtime'
import { defaultDedicatedApis } from './dedicated-apis'
import { parseFieldMapping } from '../utils/field-mapping'

export function buildCustomLinkRules(customPlatforms: any[]): { pattern: RegExp; type: string }[] {
  if (!Array.isArray(customPlatforms) || customPlatforms.length === 0) return []
  return customPlatforms
    .filter(p => p.keywords)
    .map(p => {
      const keywords = p.keywords.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (keywords.length === 0) return null
      const escaped = keywords.map((k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp(`https?://[^/\\s"'“”‘’]*(${escaped.join('|')})[^\\s"'“”‘’]*`, 'gi')
      return { pattern, type: `custom_${p.name}` }
    })
    .filter(Boolean) as { pattern: RegExp; type: string }[]
}

export function buildAuthHeaders(apiKey: string, authHeaderType: string, customHeaderName: string): Record<string, string> {
  if (!apiKey) return {}
  if (authHeaderType === 'Bearer') return { 'Authorization': `Bearer ${apiKey}` }
  if (authHeaderType === 'X-API-Key') return { 'X-API-Key': apiKey }
  if (authHeaderType === 'Custom' && customHeaderName) return { [customHeaderName]: apiKey }
  return {}
}

export function getPlatformConfig(rt: ParserRuntime, type: string): { apiUrl: string | null; dedicatedFirst: boolean; apiKey: string; authHeaderType: string; customHeaderName: string; fieldMapping?: Record<string, string>; customProxy?: any } {
  const { config, customPlatforms } = rt
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
