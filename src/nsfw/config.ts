/**
 * 「内容安全与图片混淆」配置组。
 *
 * 依赖：koishi-plugin-ferret-transform-image >= 0.0.4（提供 ferret-transform
 * 服务，可选依赖——未安装时本组功能自动停用）。
 */
import { Schema } from 'koishi'

const ALL_PLATFORMS = [
  'bilibili', 'douyin', 'kuaishou', 'xiaohongshu', 'weibo', 'xigua', 'youtube',
  'tiktok', 'acfun', 'zhihu', 'weishi', 'huya', 'haokan', 'meipai', 'twitter',
  'instagram', 'doubao', 'doubao_image', 'jimeng', 'oasis', 'wechat_channel',
  'lishi', 'quanmin', 'pipigx', 'pipixia', 'zuiyou', 'toutiao',
] as const

const platformSchema = (item: any) => item

const modeUnion = Schema.union([
  Schema.const('off' as const).description('关闭'),
  Schema.const('full' as const).description('全量处理（配置审核后自动等效 smart）'),
  Schema.const('smart' as const).description('内容审核判定'),
])

function platformModeObject() {
  const shape: Record<string, any> = {}
  for (const p of ALL_PLATFORMS) shape[p] = modeUnion.default('off').description(p)
  return Schema.object(shape).description('平台处理模式（默认全部关闭）')
}

export const NsfwConfig = Schema.object({
  nsfwPolicy: Schema.object({
    imageAction: Schema.union([
      Schema.const('scramble' as const).description('混淆图片 + 还原 token'),
      Schema.const('link' as const).description('仅发送图片链接文字'),
      Schema.const('drop' as const).description('不发送'),
    ]).default('scramble').description('图片命中后的动作'),
    videoAction: Schema.union([
      Schema.const('redeem' as const).description('暂存视频 + 请求者私聊凭 token 取回'),
      Schema.const('link' as const).description('仅发送视频原链接文字'),
      Schema.const('drop' as const).description('不发送'),
    ]).default('redeem').description('视频命中后的动作（封面送审判定）'),
    scrambleAvatar: Schema.boolean().default(false).description('作者头像也参与混淆（默认跳过）'),
    tokenHintText: Schema.string().role('textarea').default('检测到可能不适宜的内容，图片已混淆。可回复该图片并私聊发送「解混淆 <token>」还原。').description('图片混淆提示文案（占位 ${token}）'),
    videoCardHint: Schema.string().role('textarea').default('检测到受限视频，未在群内发送。原视频已暂存 ${ttl} 分钟，私聊发送「取视频 <token>」领取。').description('受限视频卡片提示文案（占位 ${token} ${ttl}）'),
  }).description('处理策略'),

  nsfwPlatformMode: platformModeObject(),

  nsfwAdvancedPolicy: Schema.boolean().default(false).description('启用平台级高级策略覆盖'),
  nsfwPlatformPolicyAdvanced: Schema.array(
    Schema.object({
      platform: Schema.union(ALL_PLATFORMS.map((p) => Schema.const(p)) as any).required().description('平台'),
      mode: modeUnion.default('smart').description('处理模式'),
      imageAction: Schema.union([
        Schema.const('scramble' as const), Schema.const('link' as const), Schema.const('drop' as const),
      ]).description('图片动作（默认继承全局）'),
      videoAction: Schema.union([
        Schema.const('redeem' as const), Schema.const('link' as const), Schema.const('drop' as const),
      ]).description('视频动作（默认继承全局）'),
    })
  ).default([]).description('平台高级策略（覆盖全局）'),

  nsfwModeration: Schema.object({
    provider: Schema.union([
      Schema.const('baidu' as const).description('百度智能云'),
      Schema.const('yidun' as const).description('网易易盾'),
      Schema.const('aliyun' as const).description('阿里云'),
      Schema.const('tencent' as const).description('腾讯云'),
      Schema.const('custom' as const).description('自定义 REST 模板'),
    ]).default('baidu').description('内容安全平台（配置有效凭证后启用；启用后平台全量模式自动转为审核判定）'),
    baidu: Schema.object({
      apiKey: Schema.string().role('secret').default('').description('API Key'),
      secretKey: Schema.string().role('secret').default('').description('Secret Key'),
    }).description('百度智能云凭证'),
    yidun: Schema.object({
      secretId: Schema.string().role('secret').default('').description('secretId'),
      secretKey: Schema.string().role('secret').default('').description('secretKey'),
    }).description('网易易盾凭证'),
    aliyun: Schema.object({
      accessKeyId: Schema.string().role('secret').default('').description('AccessKeyId'),
      accessKeySecret: Schema.string().role('secret').default('').description('AccessKeySecret'),
    }).description('阿里云凭证'),
    tencent: Schema.object({
      secretId: Schema.string().role('secret').default('').description('SecretId'),
      secretKey: Schema.string().role('secret').default('').description('SecretKey'),
    }).description('腾讯云凭证'),
    custom: Schema.object({
      endpoint: Schema.string().default('').description('审核接口地址'),
      method: Schema.union([Schema.const('GET' as const), Schema.const('POST' as const)]).default('POST').description('请求方法'),
      headersJson: Schema.string().role('textarea').default('{}').description('请求头 JSON（可选）'),
      bodyTemplate: Schema.string().role('textarea').default('{\"image\":\"${base64}\"}').description('请求体模板（占位 ${url} ${base64}）'),
      verdictJsonPath: Schema.string().default('data.nsfw').description('判定字段路径，如 data.results[0].nsfw'),
      nsfwValues: Schema.array(Schema.string()).default(['true', 'block', 'nsfw', '1']).description('判定字段命中值集合'),
    }).description('自定义 REST 模板'),
  }).description('内容安全审核'),

  nsfwVault: Schema.object({
    ttlMinutes: Schema.number().min(1).default(30).description('受限视频暂存时长（分钟）'),
    maxItems: Schema.number().min(1).default(20).description('暂存条数上限'),
    maxItemMB: Schema.number().min(1).default(200).description('单条视频体积上限（MB，超限改发链接）'),
    budgetMB: Schema.number().min(1).default(600).description('暂存总预算（MB，LRU 驱逐）'),
  }).description('受限视频暂存'),
}).description('内容安全与图片混淆')

export const SendStrategyConfig = Schema.object({
  sendStrategy: Schema.union([
    Schema.const('single' as const).description('单条整合（默认；图片过多/含视频自动回退合并转发）'),
    Schema.const('split' as const).description('逐条分开发送（旧版行为）'),
  ]).default('single').description('发送策略'),
  singleSendMaxImages: Schema.number().min(1).default(10).description('单条消息最大图片数（超出回退合并转发）'),
}).description('发送策略')

export { platformSchema }
