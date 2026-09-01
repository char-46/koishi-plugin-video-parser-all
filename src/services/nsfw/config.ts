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

const inheritableModeUnion = Schema.union([
  Schema.const('inherit' as const).description('跟随全局（默认）'),
  Schema.const('off' as const).description('强制关闭'),
  Schema.const('full' as const).description('全量处理（配置审核后自动等效 smart）'),
  Schema.const('smart' as const).description('内容审核判定'),
])

function platformModeObject() {
  const shape: Record<string, any> = {}
  for (const p of ALL_PLATFORMS) shape[p] = inheritableModeUnion.default('inherit').description(p)
  return Schema.object(shape).description('平台处理模式（inherit=跟随全局；显式设置可覆盖全局一刀切）')
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
    tokenHintText: Schema.string().role('textarea').default('检测到可能不适宜的内容，已混淆 ${count} 张图片。如需查看：将图片转发到与机器人的私聊，随消息发送「解混淆 + 取件码」即可还原（取件码见各混淆图消息，群里直接发取件码无效）。').description('图片混淆提示文案（占位 ${count}）'),
    videoCardHint: Schema.string().role('textarea').default('检测到受限视频，未在群内发送。原视频暂存至 ${until}，私聊发送「取视频 + 取件码」领取（取件码见下条消息）。').description('受限视频提示文案（占位 ${until} ${ttl}）'),
  }).description('处理策略'),

  nsfwGlobalMode: modeUnion.default('off').description('全平台默认处理模式（平台级可覆盖）'),

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
      Schema.const('azure' as const).description('Azure Content Safety'),
      Schema.const('custom' as const).description('自定义 REST 模板'),
    ]).default('baidu').description('审核服务商（配置有效凭证后生效）'),
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
    azure: Schema.object({
      endpoint: Schema.string().default('').description('资源地址 https://<resource>.cognitiveservices.azure.com'),
      apiKey: Schema.string().role('secret').default('').description('Ocp-Apim-Subscription-Key'),
      categories: Schema.array(Schema.union([
        Schema.const('Sexual' as const).description('性内容'),
        Schema.const('Violence' as const).description('暴力'),
        Schema.const('Hate' as const).description('仇恨'),
        Schema.const('SelfHarm' as const).description('自残'),
      ])).default(['Sexual', 'Violence']).description('送审类别'),
      severityThreshold: Schema.number().min(0).max(6).step(1).default(2).description('命中阈值（severity ≥ 此值判命中，0 最严 6 最松）'),
      blocklistNames: Schema.array(Schema.string()).default([]).description('阻止列表名称（需在 Azure 门户预先创建）'),
    }).description('Azure Content Safety'),
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
    ttlMinutes: Schema.number().min(1).default(30).description('暂存时长（分钟）'),
    maxItems: Schema.number().min(1).default(20).description('暂存条数上限'),
    maxItemMB: Schema.number().min(1).default(200).description('单条体积上限（MB，超限改发链接）'),
    budgetMB: Schema.number().min(1).default(600).description('暂存总预算（MB，LRU 驱逐）'),
    tokenShare: Schema.boolean().default(true).description('取件码共享：任何持有者可领取（关闭则仅限原请求者）'),
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
