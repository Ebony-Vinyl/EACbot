# Plugin Manifest v1

状态：设计合同；`shared/plugins/manifest.ts` 已有运行时解析器和固定测试，本地包安装器会校验声明入口；SDK 发布物和插件市场尚未实现。权限语义以[权限规范](permissions.md)为准。Manifest 描述插件希望做什么，不代表宿主已经授予权限或审核信任。

## 1. 文件与字段

包根目录使用 `eac-plugin.json`，UTF-8 JSON，拒绝重复 key。第一版不接受 YAML 或可执行配置；元数据上限 256 KiB。

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 整数，v1 固定为 1；未知版本拒绝 |
| `pluginId` | 小写命名空间 ID，2–4 段，每段为字母开头的字母/数字/连字符；总长不超过 100 |
| `version` | 精确 SemVer；不使用 latest 或范围 |
| `apiVersion` | 宿主插件 API 的 SemVer 范围，与包版本分开 |
| `name` / `description` | 默认可读文案；可由包内 locale 覆盖 |
| `publisher` | 展示身份；所有权由渠道审核，不据此建立信任 |
| `license` | SPDX 表达式或随包 LicenseRef；无法核实不能进默认渠道 |
| `source` | 仓库地址与精确 revision；发行摘要位于外部索引，避免包自哈希循环 |
| `compatibility` | 最低宿主版本、支持宿主类型与 OS/arch |
| `runtime` | `declarative`、`process` 或 `external`；入口及隔离要求 |
| `activation` | `manual`、`on-demand`；后台激活需显式授权，不因安装自动执行 |
| `provides` | 稳定服务名到服务协议版本 |
| `requires` / `optionalRequires` | 服务名到可接受版本范围 |
| `permissions` | 有界、可解释的权限申请数组；见下文 |
| `contributes` | 工具、面板、主题、布局、模型等可同时存在，不用互斥 kind |
| `configSchema` / `locales` | 包内相对路径；配置 schema 不含秘密默认值 |
| `stateVersion` | 插件数据格式整数；迁移由宿主事务调用 |

未识别的顶层字段拒绝以避免拼写失效，扩展信息只允许放入 `extensions` 的命名空间键，且不得改变安全语义。贡献和权限描述均限制数量与文本长度，具体 schema 测试固定这些预算。

## 2. 示例：EAC Muse

下面是目标 manifest 样例，不意味着所列路径或 SDK 已存在：

```json
{
  "schemaVersion": 1,
  "pluginId": "eac.muse",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "name": "EAC Muse",
  "description": "酷狗音乐与 Bot、TTS、桌宠和任务联动",
  "publisher": "EAC Community",
  "license": "Apache-2.0 AND MIT",
  "source": {
    "repository": "https://github.com/example/eac-muse",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "compatibility": {
    "hostVersion": ">=1.0.0 <2.0.0",
    "hosts": ["server", "desktop"],
    "platforms": ["win32-x64", "linux-x64"]
  },
  "runtime": {
    "mode": "process",
    "entry": "service/adapter.mjs",
    "isolation": "required"
  },
  "activation": ["manual", "on-demand"],
  "provides": {"music.control": "1.0.0"},
  "requires": {"host.capabilities": "^1.0.0", "host.media": "^1.0.0"},
  "optionalRequires": {"pet.state": "^1.0.0"},
  "permissions": [
    {
      "id": "music-read",
      "capability": "music.library.read",
      "effect": "read",
      "scope": {"accounts": "selected"},
      "reason": "读取你选择的音乐账户歌单和搜索结果"
    },
    {
      "id": "music-control",
      "capability": "media.playback.control",
      "effect": "control",
      "scope": {"devices": "selected"},
      "reason": "控制你选择的客户端播放、暂停和音量"
    }
  ],
  "contributes": {
    "tools": "contracts/tools.json",
    "panels": [{"id": "music", "title": "音乐", "entry": "ui/panel.json", "mode": "declarative"}]
  },
  "configSchema": "config.schema.json",
  "locales": {"zh": "locales/zh.json", "en": "locales/en.json"},
  "stateVersion": 1
}
```

示例地址、revision、兼容版本与许可证组合仅演示格式，不是实际发行信息。正式制品必须用实际源码、支持平台和文件级许可证替换。真实酷狗网络调用还须列明经核实的目标域和权限，不能通过 `music-read` 暗含无限联网或获取密钥；遗漏时验收失败。

## 3. 权限声明结构

每项 `permissions` 必须包含唯一 `id`、`capability`、`effect`、`scope`、非空 `reason`。

- effect：`read | draft | control | write | send | delete | financial | security`，不是简单数字风险排序。
- scope：按能力接受 `accounts/devices/memorySpaces/resources/domains/paths` 等字段，不能任意扩展。
- `selected` 表示安装/配置时由用户选择；没有选择等于空集合，不等于所有。
- 网络目标必须明确协议、主机和必要端口；文件路径由宿主映射命名句柄，不能由 manifest 任意挂载用户 HOME。
- 数据敏感等级、受众和审计由宿主策略控制；effect=read 不代表公开数据。
- plugin 自报的审批提示可供解释，但不能降低宿主风险等级。

`official`、`verified`、`approved`、签名状态和授权令牌不属于 manifest；这些由渠道验证和宿主安装状态生成。

## 4. 入口与贡献

- 所有相对路径规范化后必须留在包根内；禁止绝对路径、`..`、符号链接逃逸、Windows ADS 和设备路径。
- `process` 入口只能使用宿主认可的 runtime launcher，不能把任意 shell 字符串当启动命令。
- `external` 记录协议与连接设置 schema，不随安装启动第三方服务；URL 运行时授权，不在包中藏凭据。
- `declarative` 不包含后端入口；纯主题不得申请 process、network 或 secret 能力。
- UI 贡献使用 `<pluginId>:<contributionId>` 防止命名覆盖。插槽必须由宿主声明，未知插槽报错。
- 工具、模型、事件的数据输入输出均有版本化 schema；工具 `effect` 与权限申报相符。
- `contributes.tools` 为包路径或工具数组。只有数组形式可被宿主调用：宿主从数组中解析工具 id、effect 与权限，`entry` 只是包内元数据路径。数组项包含 `id`、`entry`、`effect`，可选 `permission` 指向同 manifest 的权限 id；省略时，该 effect 必须恰好对应一个已声明权限，否则该工具不可调用。`permission` 不存在或 effect 不一致时 manifest 拒绝解析。
- 主题只允许合法 token；布局组合已批准贡献，不能覆盖登录、审批、危险确认与安全恢复。

## 5. 制品与版本约束

制品按 OS/arch 列入渠道索引，带摘要、大小和源码 revision。依赖锁定，构建记录/SBOM 随发行提供；不得在用户安装时自动 npm install、pip install、dotnet restore 或执行 postinstall。

平台兼容必须分别验收；声明支持 Linux server 不等于服务器具备播放器设备。原生服务只能选匹配制品，不静默下载其他架构或请求提权。

强依赖必须满足且无环；可选依赖允许缺失并展示降级。没有必要不依赖具体插件 ID，优先依赖服务合同。安全关键服务不允许第三方替换。

## 6. 解析与安装负面测试

必测：重复 key、未知 schema、错误 SemVer、ID 冲突、权限遗漏、路径逃逸、入口缺失、依赖环、版本冲突、制品架构不符、UI 贡献越权、未知字段、过大描述、伪造审核等级。

schema 检查通过只是安装前置条件；仍需[渠道验证](channels.md)、[生命周期](sdk.md)和[安全验收](security-review.md)。
