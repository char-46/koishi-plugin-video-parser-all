# 架构 / 模块依赖图

描述当前（单文件）版本的逻辑分层与依赖关系。源码位置：`src/index.ts`（1238 行）。

## 逻辑分层

```mermaid
flowchart TB
    subgraph Entry["入口层"]
        APPLY["apply()<br/>注册 message 事件 / parse 命令 / dispose"]
    end

    subgraph Orchestration["编排层（apply 闭包内）"]
        FLUSH["flush<br/>并发 + 去重 + 收集 + 发送编排"]
        PSU["processSingleUrl"]
        PU["parseUrl"]
    end

    subgraph Engine["解析引擎层"]
        FA["fetchApi<br/>API 选择 / HTTP 重试 / 缓存"]
        PA["parseApiResponse<br/>统一字段映射（核心）"]
        GFT["generateFormattedText<br/>模板变量替换"]
    end

    subgraph Sender["发送层"]
        SW["sendWithTimeout<br/>超时 + 重试"]
        SM["sendMedia<br/>image/video/audio"]
        BFN["buildForwardNode<br/>合并转发节点"]
    end

    subgraph Platform["平台配置层（apply 闭包内）"]
        GPC["getPlatformConfig"]
        BAH["buildAuthHeaders"]
        BCLR["buildCustomLinkRules"]
    end

    subgraph PlatformData["平台数据（模块级 const）"]
        BLR["BUILTIN_LINK_RULES<br/>60 条正则 / 26 type"]
        DDA["defaultDedicatedApis<br/>14 专属 API"]
        BA["backupAllowed 白名单<br/>douyin/xhs/instagram/jimeng"]
    end

    subgraph Utils["通用工具层（模块级）"]
        URL["linkTypeParser / cleanUrl<br/>extractAllUrlsFromMessage"]
        FMT["formatDuration<br/>formatPublishTime"]
        FM["getNestedValue<br/>parseFieldMapping"]
        CNT["parseCount<br/>pickBestQuality"]
        CACHE["SimpleLRUCache"]
        CONC["ConcurrencyLimiter"]
        LOG["logger / debugLog"]
        COM["delay / getErrorMessage<br/>contentFingerprint / getText"]
    end

    subgraph Types["类型层"]
        T["ParsedData / VideoQuality<br/>LinkMatch / ApiItem<br/>CustomPlatformConfig"]
    end

    subgraph Config["配置层"]
        CFG["Config Schema<br/>10 组 intersect"]
    end

    APPLY --> FLUSH
    APPLY --> URL
    APPLY --> PlatformData
    FLUSH --> PSU
    FLUSH --> GPC
    FLUSH --> SW
    FLUSH --> SM
    FLUSH --> BFN
    FLUSH --> CONC
    FLUSH --> CACHE
    FLUSH --> COM
    PSU --> PU
    PSU --> GFT
    PU --> FA
    FA --> GPC
    FA --> BAH
    FA --> PA
    FA --> CACHE
    FA --> LOG
    GPC --> PlatformData
    GPC --> CFG
    GPC --> FM
    PA --> FM
    PA --> CNT
    PA --> T
    GFT --> FMT
    GFT --> T
    SM --> SW
    URL --> BLR

    style Entry fill:#dbeafe
    style Orchestration fill:#e0e7ff
    style Engine fill:#fef3c7
    style Sender fill:#dcfce7
    style Platform fill:#fce7f3
    style PlatformData fill:#fae8ff
    style Utils fill:#f1f5f9
    style Types fill:#fef9c3
    style Config fill:#fed7aa
```

## 数据流（端到端）

```mermaid
flowchart LR
    Msg["用户消息<br/>(文本/XML卡片/JSON卡片)"]
    Match["LinkMatch[]<br/>{type,url,id}"]
    Conf["PlatformConf<br/>{apiUrl,dedicatedFirst,...}"]
    Raw["API 原始响应<br/>(任意结构)"]
    Parsed["ParsedData<br/>(统一结构)"]
    Text["格式化文字"]
    Send["发送<br/>(文字/图/视频/语音/转发)"]

    Msg -->|extractAllUrlsFromMessage| Match
    Match -->|getPlatformConfig| Conf
    Match -->|flush → processSingleUrl| Raw
    Conf -.->|决定 apiList 顺序| Raw
    Raw -->|parseApiResponse +<br/>fieldMapping| Parsed
    Parsed -->|generateFormattedText| Text
    Parsed -->|sendMedia / 转发| Send
    Text --> Send

    style Parsed fill:#fef3c7
    style Conf fill:#fce7f3
```

## 平台数据的分散现状（待拆分统一）

当前平台信息散落在 6 处，存在不一致（拆分阶段将建立统一注册表）：

```mermaid
flowchart TB
    subgraph "平台信息来源（分散）"
        R1["BUILTIN_LINK_RULES<br/>index.ts:360-420<br/>60 条规则 / 26 type"]
        R2["platformEnabled 默认值<br/>index.ts:61-87<br/>25 项"]
        R3["platformDedicatedFirst 默认值<br/>index.ts:163-189<br/>25 项"]
        R4["customApis.platform 枚举<br/>index.ts:192-212<br/>19 项"]
        R5["defaultDedicatedApis<br/>index.ts:832-847<br/>14 项"]
        R6["backupAllowed 白名单<br/>index.ts:1085<br/>4 项"]
    end

    subgraph "已知不一致"
        I1["jimeng: 在 R1/R5/R6 存在<br/>但缺失于 R2/R3/R4 → 无法 UI 单独开关"]
        I2["toutiao: 仅在 R5 存在<br/>R1 无链接规则 → 永不触发"]
        I3["doubao_image / lishi / quanmin<br/>pipigx / pipixia / zuiyou<br/>缺失于 R4 → 无法配 customApi"]
    end

    R2 -.-> I1
    R3 -.-> I1
    R4 -.-> I1
    R5 -.-> I2
    R1 -.-> I2
    R4 -.-> I3

    style I1 fill:#fecaca
    style I2 fill:#fecaca
    style I3 fill:#fed7aa
```

## 当前文件结构

```
koishi-plugin-video-parser-all/
├── src/
│   └── index.ts          # 全部逻辑（1238 行，apply 占 462 行）
├── package.json
├── tsconfig.json
└── readme.md
```

> 本图为「拆分前」基线。拆分后将更新为多模块结构（见后续提交）。
