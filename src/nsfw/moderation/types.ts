/**
 * 内容安全 Provider 契约与各平台凭证类型。
 */
import type { AxiosInstance } from 'axios'

export interface CheckInput {
  /** 原始图片 URL（部分平台接受 URL 送审） */
  url: string
  /** 下载后的图片字节（部分平台要求 base64 送审） */
  buffer: Buffer
}

export interface CheckResult {
  nsfw: boolean
  label: string
  score?: number
}

export interface ModerationProvider {
  readonly name: string
  check(input: CheckInput): Promise<CheckResult>
}

/** 各平台凭证/模板配置（由 nsfw/config.ts 的 Schema 生成） */
export interface BaiduConf { apiKey: string; secretKey: string }
export interface YidunConf { secretId: string; secretKey: string }
export interface AliyunConf { accessKeyId: string; accessKeySecret: string; region?: string }
export interface TencentConf { secretId: string; secretKey: string; region?: string }
export interface AzureConf { endpoint: string; apiKey: string }
export interface CustomConf {
  endpoint: string
  method?: 'GET' | 'POST'
  headersJson?: string
  bodyTemplate?: string
  verdictJsonPath: string
  nsfwValues?: string[]
}
export type ProviderConf =
  | { provider: 'baidu'; baidu: BaiduConf }
  | { provider: 'yidun'; yidun: YidunConf }
  | { provider: 'aliyun'; aliyun: AliyunConf }
  | { provider: 'tencent'; tencent: TencentConf }
  | { provider: 'azure'; azure: AzureConf }
  | { provider: 'custom'; custom: CustomConf }

export type ProviderFactory = (conf: ProviderConf, http: AxiosInstance) => ModerationProvider
