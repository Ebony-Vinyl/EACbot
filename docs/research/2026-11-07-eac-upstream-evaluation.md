# EAC 插件平台参考项目评估

日期：2026-11-07。此文件记录规划阶段对公开资料的研究结论，不是第三方代码审计、许可证法律意见或实际账号联调报告。未使用生产凭据或访问用户部署服务。上游持续变化，实施复用前必须记录实际 revision、文件路径、许可证和验证结果。

## 1. 证据分级

- **公开依据**：仓库/文档可支持相应产品或代码结构描述，不等于该功能已在 EAC 实现。
- **设计选择**：EAC 为满足需求作出的决定，不能冒称上游已提供相同合同。
- **待验证**：接口、账号资质、实际模态、平台运行或许可适用性未经过当前环境验证，发行前有明确 gate。

不使用 star 数量作为成熟/安全证据；不把 agent 调研中的推断写成实测。本文不记录非必要的逆向鉴权、客户端伪装或安全限制规避细节。

## 2. 架构与产品参考

| 项目 | 公开依据与可借鉴点 | EAC 采用方式 | 限制/复核 |
| --- | --- | --- | --- |
| [Magpie](https://github.com/yetone/magpie) | 多类插件、目录、页面/面板、模型路由与用量界面 | 参考信息组织和插件类别，允许范围内复用 | 不能把宿主权限进程称安全沙箱；固定 MIT 文件/署名 |
| [magpie-community/plugins](https://github.com/magpie-community/plugins) | 独立社区仓库、registry、PR 与包发布 | 建立独立 EAC 扩展仓库，增加安全审核和签名 | PR CI 通过不等于安全审计；重新设计可信发布链 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Cordis 服务依赖、可撤销 effect、typed slots、工具守卫、第三方索引 | 学习解耦合同，不整体替换 EAC runtime | 注册隔离不等于 OS 隔离；EAC 的签名/隔离需自行实现 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 持久化 Kanban、租约/任务工具、dashboard、固定 revision 插件目录 | 将任务产品能力映射到 EAC 既有 runtime/routines | 不复制第二套调度器；所有 HTTP/WS 必须 fail closed，逐路由复核 |
| [Hark](https://hark.com/using-hark) | 自然语言创建 Panels、Projects、动作卡的产品体验 | 原创 PanelSpec 与交互，参考用户给定截图 | 闭源，无可复用内部 API/实现证据，不复制素材/代码 |
| [Ondra](https://github.com/ntars/Ondra) | Tauri/host/kernel 分离、服务发现、配置驱动 UI | 借鉴思路，保留 EAC 核心 | 上游 AGPL 等义务需按文件分析；不直接混入实现 |

辅助资料：
- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Hermes 插件目录](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog)
- [Hermes Kanban](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md)
- [Hark 公开条款](https://hark.com/terms)

EAC 的声明式 schema 面板、统一能力 broker 和带密钥轮换的签名渠道是本项目设计选择；不能仅因看过参考产品就宣称它们提供了同样实现。

## 3. 模型、语音与音乐

| 项目 | 已有公开依据 | 采用 | 待验证 |
| --- | --- | --- | --- |
| [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | 兼容模型网关、文本/视觉与本地密钥处理 | `eac.provider.ofm` 连接用户有权使用的网关，复用已有 compatible driver | 用户服务器 New API/NVIDIA 的 TTS/STT/video 端点、模型与编码独立核实 |
| [Pipecat](https://github.com/pipecat-ai/pipecat) | 实时音视频 pipeline、多 transport/provider | 可选语音 sidecar，保留原 TTS 和 EAC Agent | 流式/打断随 provider 不同；BSD-2-Clause 及选用依赖逐项复核 |
| [KugouMusic.NET](https://github.com/Linsxyx/KugouMusic.NET) | .NET/Avalonia 客户端、登录、搜索、歌单、歌词与播放 | 按用户要求直接复用改造，薄桥接到 EAC，不替换后端 | 文件级许可、使用声明、登录/播放接口、目标平台与运行时，浏览器播放映射 |

OFM 公开资料未验证用户部署的全部多模态能力，这不表示服务器一定不支持；表示当前不能下结论。免费渠道也可能限频/记录请求，数据出口和隐私策略仍需用户明确选择。音乐代码许可不授予音乐内容再分发或 VIP 绕过权。

## 4. QQ 与外部 Bot 框架

| 项目 | 角色 | EAC 路线 | 门槛 |
| --- | --- | --- | --- |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | OneBot v11 协议端/服务 | 用户自部署服务 + EAC 适配，不默认随产品打包 | 公开许可有非商业/再分发限制，固定实际文本与用途确认 |
| [MaiBot](https://github.com/Mai-with-u/MaiBot) | 外部 Bot 框架 | 可选桥接/委派，与 EAC 主处理模式互斥 | GPL 及依赖义务、实际消息和身份接口 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | 多平台 Bot 框架 | 保留用户要求的可选桥接 | AGPL 等适用义务按实际组合分析；网络服务并非自动一律禁止 |
| [QQ 开放平台](https://bot.q.qq.com/) | 官方账户/机器人通道 | 单独适配并标注能力范围 | 资质、回调、发送范围、限频以实际账号文档验证 |

独立进程或用户自装不会自动免除许可证义务；技术上选外部服务是为了运行和权限边界，不是规避许可。不得把非官方协议端标成官方授权。

## 5. B站与国内平台

| 项目 | 参考价值 | 采用边界 |
| --- | --- | --- |
| [dsh-bili-humanism](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism) | 字幕/内容研究、时间点来源、配额、受控写与回读 | 保留可解释报告与默认关写操作；固定许可和接口依赖 |
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | 内容发现、日报、定时阅读和互动思路 | 适配到 EAC 任务，不复制 headless DSH 作为第二个核心 |
| [xyxyxy](https://github.com/chinamonarchs/xyxyxy) | 用户指定的闲鱼生态参考 | 调研未建立可复用许可证；不采用涉及验证码/风控规避的实现 |
| [xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply) | 消息、回复、商品/运营功能拆分 | 学习可用协议/交互；AGPL 与 README 用途声明需确认，接口逐项测试 |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 多平台内容采集能力 | 不能据此承诺发帖、私信、交易；有非商业学习限制，不能默认打包 |
| [dsh-tieba-dive](https://github.com/Nekomeow114/dsh-tieba-dive) | 帖子阅读、摘要、限频/熔断/默认关写 | 复用允许的思路/代码，遇验证暂停，不绕过安全措施 |
| [aiotieba](https://github.com/Starry-OvO/aiotieba) | 贴吧库的成熟接口候选 | 仅候选，版本、许可、接口实际可用性需验证 |
| [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | 公开内容读取/下载候选 | 不当作完整账号运营通道 |
| [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | 小红书内容读取候选 | 许可/内容权利核实，不当作发布接口 |

[闲鱼三方平台](https://open.goofish.com/)与[B站开放平台](https://open.bilibili.com/)可作为官方接口核对入口，当前没有完成实际资质/API 合同验证。爬虫、浏览器自动化、开放 API 三者能力和风险不同；不能将一个库可采集推导为所有账号可全自动运营。

合法、有限、已授权自动回复/运营仍是设计目标。未知或不允许的写能力标 unavailable/人工交接，不用安全限制泛化为永久取消用户需求。

## 6. 健康、家居与多端

- [Today.ai](https://today.ai/articles/zh-Hans)：参考长期记忆、跨应用主动助理的产品行为；不假定其提供开放健康 API。
- [灵光](https://www.lingguang.com/)：用户确认的官网；仅参考能核实的全模态助手产品方向，具体健康/开发者 API 尚未核实。
- [Home Assistant](https://github.com/home-assistant/core)及[MCP 集成](https://www.home-assistant.io/integrations/mcp_server/)：优先家居适配，授权实体/动作和账号仍需实测。
- [Homebridge](https://github.com/homebridge/homebridge)：HomeKit 生态补充候选，按需要接，不先引入。
- [Android Health Connect](https://developer.android.com/health-and-fitness/guides/health-connect)、[Apple HealthKit](https://developer.apple.com/health-fitness/)：未来原生客户端合法数据源，需系统级授权和平台隐私要求。
- [Gadgetbridge](https://gadgetbridge.org/)：穿戴数据导入候选，需具体格式和许可确认；不作为本轮直接交付手表 App。

本轮健康先手工/文件输入和提醒，设备先协议/模拟器。医疗决策、自动诊断与治疗不在范围。

## 7. 复用前的证据记录

每份实际采用的上游记录 repository、revision、路径、LICENSE/NOTICE、依赖与资产许可、使用/分发形式、修改内容、对应合同和测试。公开页面变化或旧引用失效时保留事实差异并重查，不把这份日期快照当永久授权。

当前未获取真实 QQ/酷狗/国内平台账号验证证据；没有对用户 OFM 服务器进行模态探测。相应验收必须在获授权的实施阶段完成。
