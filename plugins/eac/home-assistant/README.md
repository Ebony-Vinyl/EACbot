# EAC Home Assistant

通过 Home Assistant 公开 REST API（`/api/states`、`/api/services`）读写你的智能家居。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 实体状态读取 | production | GET /api/states，支持 domain/关键字过滤 |
| 服务调用 | production | POST /api/services/...，effect=control，需主人单独授权（grant） |
| WebSocket 订阅实时事件 | unavailable | 后续按需加入 |
| 门锁/安防等高危域额外确认 | unavailable | 当前与普通服务同样走 grant，请勿给不可信 Bot 授权 |

## 安装后配置

在宿主数据目录创建 `plugins/runtime/<installationId>/config.json`：

```json
{ "baseUrl": "http://homeassistant.local:8123", "token": "<HA 长期访问令牌>" }
```

令牌在 HA 个人资料页底部“长期访问令牌”创建。改完 config.json 后在扩展中心停用再启用本插件即可生效。令牌只保存在本机，不经模型转发。
