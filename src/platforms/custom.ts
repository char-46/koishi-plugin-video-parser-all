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
