# EAC 贴吧助手

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 吧内帖子列表 / 帖子摘要 | experimental | 无官方开放读接口，解析 HTML 页面；贴吧改版会 `parse-failed` 如实报错 |
| 回帖草稿（本地） | production | 保存于本机 `tieba-drafts.json` |
| 回帖 | experimental | 需 Cookie+TBS、主人单独授权；遇验证/风控即停并如实上报，绝不绕过 |

HTML 解析不是稳定合同：百度改版即失效，失败时不猜测内容。发帖频率请克制，验证码出现意味着应该停下交给用户处理。
