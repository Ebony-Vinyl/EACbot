# EAC Bilibili

让 Bot 能刷 B 站：搜索、视频信息、热门榜，以及（默认关闭、单独授权的）点赞与评论。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 搜索视频 / 视频信息 / 热门榜 | production | B 站公开 Web 接口；频率过高会收到 risk-control 错误，属正常保护 |
| 点赞 / 评论 | experimental | 需 config.json 配置登录 Cookie（SESSDATA+bili_jct），且需主人对相应 effect 发 grant；接口无官方文档，被风控时如实报错 |
| 弹幕/投币/收藏/关注 | unavailable | 未实现，不假装可用 |
| 视频字幕抓取与总结 | unavailable | 等字幕接口核实后加入 |

## 安全边界

- Cookie 只保存在本机插件工作目录，绝不发给任何第三方；出现 `risk-control`/验证码类错误时插件停止并如实上报，不做任何绕过。
- 写操作默认无 grant 时拒绝；未配置 Cookie 时同样拒绝并说明缺什么。
- 接口非官方公开合同，B 站改版可能导致失败；失败如实返回，不重试风暴。
