# EAC Muse

音乐模块：酷狗公开接口搜歌 + 本机播放状态机（队列、revision 防冲突、回执）。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 搜索（酷狗公开接口） | production | 非官方合同；地区/频控失败会如实报 `risk-control` |
| 队列与播放状态 | production | 本机 `muse-state.json`，所有写操作带 expectedRevision |
| 播放控制请求 | production | 记录请求并返回 `playbackConfirmed:false`——没有播放端回执绝不谎称已播放 |
| 真实出声/回执 | 需要播放端 | KugouMusic.NET 桥或面板调用 `muse-report-playback`；未接入时控制只是请求 |
| 登录酷狗账号/歌单/收藏 | unavailable | 等许可与接口核实，不绕过 VIP |

## 与 Bot 的联动

- “这首”“刚才那首”绑定 `revision`/`hash`，不靠模型猜：Bot 先 `muse-now-playing` 拿快照，再带 `expectedRevision` 下控制。
- 过期请求返回 `stale-revision`，Bot 应重新取快照。
- TTS/桌宠联动（音频焦点 lease）属宿主后续能力，本插件只暴露状态与控制。
