import { describe, it, expect } from 'vitest'
import { buildCustomLinkRules, buildAuthHeaders, getPlatformConfig } from '../src/platforms/custom'
import { makeRuntime } from './helpers'

describe('buildCustomLinkRules', () => {
  it('由 keywords 生成正则规则，type 为 custom_ 前缀', () => {
    const rules = buildCustomLinkRules([{ name: 'mypt', keywords: 'example.com, foo.bar' }])
    expect(rules).toHaveLength(1)
    expect(rules[0].type).toBe('custom_mypt')
    const re = rules[0].pattern
    re.lastIndex = 0
    expect(re.test('https://www.example.com/path/')).toBe(true)
    re.lastIndex = 0
    expect(re.test('https://foo.bar/x')).toBe(true)
  })
  it('空或无 keywords 返回空数组', () => {
    expect(buildCustomLinkRules([])).toEqual([])
    expect(buildCustomLinkRules([{ name: 'x' }])).toEqual([])
  })
})

describe('buildAuthHeaders', () => {
  it('Bearer', () => {
    expect(buildAuthHeaders('k1', 'Bearer', '')).toEqual({ Authorization: 'Bearer k1' })
  })
  it('X-API-Key', () => {
    expect(buildAuthHeaders('k2', 'X-API-Key', '')).toEqual({ 'X-API-Key': 'k2' })
  })
  it('Custom 使用 customHeaderName', () => {
    expect(buildAuthHeaders('k3', 'Custom', 'X-Token')).toEqual({ 'X-Token': 'k3' })
  })
  it('无 key → 空', () => {
    expect(buildAuthHeaders('', 'Bearer', '')).toEqual({})
  })
})

describe('getPlatformConfig', () => {
  it('内置平台返回专属 API + globalFieldMapping', () => {
    const rt = makeRuntime({ config: { globalFieldMapping: '{"title":"data.title"}' } })
    const c = getPlatformConfig(rt, 'douyin')
    expect(c.apiUrl).toBe('https://api.bugpk.com/api/douyin') // 主/备/专属顺序由 dedicatedFirst 决定
    expect(c.dedicatedFirst).toBe(false)
    expect(c.fieldMapping?.title).toBe('data.title')
  })

  it('customApis 覆盖内置专属 API', () => {
    const rt = makeRuntime({ config: {
      customApis: [{ platform: 'douyin', apiUrl: 'https://my.api/douyin', apiKey: 'sek' }],
      globalFieldMapping: '{}',
    } })
    const c = getPlatformConfig(rt, 'douyin')
    expect(c.apiUrl).toBe('https://my.api/douyin')
    expect(c.apiKey).toBe('sek')
  })

  it('custom_ 平台强制 dedicatedFirst=true 并带 customProxy', () => {
    const rt = makeRuntime({ config: {
      customPlatforms: [{ name: 'mypt', apiUrl: 'https://my.api/x', proxy: { enabled: true, host: '1.2.3.4' } }],
    } })
    const c = getPlatformConfig(rt, 'custom_mypt')
    expect(c.apiUrl).toBe('https://my.api/x')
    expect(c.dedicatedFirst).toBe(true)
    expect(c.customProxy?.host).toBe('1.2.3.4')
  })

  it('toutiao 专属 API 存在（修正后）', () => {
    const rt = makeRuntime()
    expect(getPlatformConfig(rt, 'toutiao').apiUrl).toBe('https://api.bugpk.com/api/toutiao')
  })
})
