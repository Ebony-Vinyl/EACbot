# EAC 官方插件包（plugins/eac）

这些是随本仓库源码分发的官方插件包。全部为 process 插件（stdio JSON-RPC），由宿主 supervisor 启动（需 `EAC_PLUGIN_PROCESS=1`）。安装方式见 [扩展中心](../../docs/plugins/README.md)：本地包路径指向各包目录（含 `eac-plugin.json`），或经签名渠道分发。

## 能力矩阵（2026-11-08，如实标注）

| 插件 | 已实现（状态） | 明确未实现 |
| --- | --- | --- |
| `eac.health` | 记录/查询/趋势/摘要/删除（production，全本地） | 手环/手机自动导入 |
| `eac.home-assistant` | HA REST 实体读取、服务调用（production） | WebSocket 实时订阅 |
| `eac.bilibili` | 搜索/视频信息/热门榜（production）；点赞/评论（experimental，需 Cookie+grant） | 弹幕/投币/收藏/关注、字幕抓取总结 |
| `eac.muse` | 酷狗公开搜索（production）；队列与播放状态机（production）；控制请求（production，回执需播放端） | 登录账号/歌单/收藏、真实出声（需 KugouMusic.NET 桥或面板） |
| `eac.tieba` | 回帖草稿（production，本地）；帖子列表/摘要（experimental，HTML 解析）；回帖（experimental，需 Cookie+TBS+grant） | 无 |
| `eac.xianyu` | 知识库/自动回复规则（production，本地）；商品搜索（experimental，需 Cookie） | 消息收发（需独立桥）、发布/改价/订单 |
| `eac.douyin` | 选题/素材/草稿/计划（production，本地） | 发布/互动/数据回捞 |
| `eac.xiaohongshu` | 选题/素材/笔记草稿/计划（production，本地） | 发布/互动/账号数据 |

原则：失败如实报错（`risk-control`、`session-expired`、`parse-failed` 等），不做验证码/风控绕过；Cookie 只存本机插件工作目录；高影响操作（写/发/控/删）默认无授权，需要主人在插件权限页发 grant。

## 与 Bot 的联动

所有插件工具在 Bot 启动回合时自动挂载进 `eac-plugins` MCP 服务器（`contributes.tools`），`read`/`draft` 效果按回合自动授权；更强效果需要 grant。平台账户（QQ/B站/闲鱼/抖音/小红书/贴吧）经 `POST /api/platforms/inbound` 进入绑定 Bot 的会话，Bot 回复进入 `GET /api/platforms/accounts/<id>/outbox` 由桥取走。

## 测试

`pnpm exec vitest run server/plugins/bundled.test.ts` 会逐包校验 manifest 并真实启动进程，对本地工具与本地 fake HTTP 服务做 `tools/call`。
