# 项目文档与设计图

本目录存放 `koishi-plugin-video-parser-all` 的设计文档与 UML 图表（Mermaid 格式）。

## 目录结构

```
docs/
├── README.md              # 本文件（索引）
├── diagrams/              # 通用设计图
│   ├── 01-sequence-general.md   # 通用时序图（完整解析流程）
│   ├── 02-class-general.md      # 通用类图（核心类型与依赖）
│   └── 03-architecture.md       # 架构 / 模块依赖图
└── platforms/             # 各平台数据卡（每平台 1 个 .md）
    └── README.md          # 27 平台总览
```

## 图表说明

| 图表 | 类型 | 内容 |
|------|------|------|
| [通用时序图](diagrams/01-sequence-general.md) | Sequence | 从消息接收到结果发送的完整流程，含并发/去重/缓存/重试/转发分支 |
| [通用类图](diagrams/02-class-general.md) | Class | `SimpleLRUCache`、`ConcurrencyLimiter`、5 个核心 interface、`Config`、`apply` 内部依赖 |
| [架构图](diagrams/03-architecture.md) | Flowchart | 逻辑分层与模块依赖关系 |
| [平台总览](platforms/README.md) | 表格 + 数据卡 | 27 个平台的链接规则、专属 API、解析能力、字段映射来源 |

## 阅读顺序建议

1. 先看 [架构图](diagrams/03-architecture.md) 建立整体认知
2. 再看 [通用时序图](diagrams/01-sequence-general.md) 理解运行流程
3. 参考 [通用类图](diagrams/02-class-general.md) 理解数据契约
4. 按需查阅 [平台数据卡](platforms/README.md) 了解各平台差异

> 所有图表均使用 [Mermaid](https://mermaid.js.org/) 语法，可在 GitHub / VS Code（Mermaid 插件）中直接渲染。
