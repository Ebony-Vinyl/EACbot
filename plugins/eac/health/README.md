# EAC Health

个人健康记录助手（本地存储，无网络访问）。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 记录/查询/趋势/摘要/删除 | production | 全部在本机 `health-records.json` |
| 自动从手环/手机导入 | unavailable | 等设备协议接入（Health Connect/HealthKit 属后续） |

## 安装后使用

无需配置。数据保存在宿主数据目录 `plugins/runtime/<installationId>/health-records.json`。

指标命名：`steps`、`weight_kg`、`sleep_hours`、`heart_rate`、`water_ml`、`mood` 或自定义 `a-z0-9_`。
