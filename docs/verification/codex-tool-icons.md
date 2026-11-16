# Codex 工具活动图标

本次改动影响范围是 Herdr 工具图标与展示分类模块。

## 来源与范围

图形版权归原应用权利人。本地来源：/Applications/ChatGPT.app/Contents/Resources/app.asar。
SVG 路径从已安装应用的工具活动模块提取；没有修改或执行 Codex 安装包。
分类依据活动模块 hFwT 与 dI55：读取、搜索、目录、编辑、命令、网页、浏览器、Computer Use、图片及多 Agent 活动。
工具活动的 Computer Use 图标是 desktop-light-16；Resources/computer-use.svg 是另一处指针资源，不混用。

| 分类 | 原资源名称 | 模块 |
| --- | --- | --- |
| computer | desktop-light-16 | rj04 |
| command | terminal-light-16 | wepB |
| edit | pencil-light-16 | QxwI |
| browser | web-browser-cursor-light-16 | kuP6 |
| folder | folder-light-16 | RkfJ |
| web | globe-light-16 | KjMy |
| search | magnifying-glass-md-light-16 | Cj22 |
| image | photo-on-tilted-square-light-16 | sADh |
| read | book-open | bZHk |
| agents | robot-light-16 | zhow |

## 静态证据

选定模块经过 REA 静态分析，Evidence: ev_18c4d60d800095ee30ea99427b47724a68f8ce312e65bbf91d88289dc2197001。
分析对象是从安装包抽出的 hFwT/dI55 两个模块，不代表对整个 Codex 应用做过运行时验证。
整包 REA 校验遇到无关的 unpacked native 模块完整性差异；随后仅分析选定 JS。下列 JS 逐个核对了 ASAR 声明的 SHA-256。

| 原始文件 | SHA-256 |
| --- | --- |
| 461952.bb4069593d.js | fdcb916cece3b6bbd2e59c4981910c6089502d1aaed347960607c50f5b179db6 |
| 98815.42a3b2f915.js | f904246c7d831a4de09e80549b6a306ee9e7e33d10508578763aeeb78cf763aa |
| 956370.aff5cce818.js | 84c3881d294dc4ac2892d9a58f7f60bed97cb061bde375a4fe2f1a768ea22379 |
| 273893.14f4cb4d29.js | 05a2b15e544822e232f95a19ef25822856042ce1dd87ddb8e8dccc094f59ef14 |
| 29761.a7d2c6d06a.js | b37341e9b32aa4eeafab17d3036a50b11f618df145d67e52d93617e891d67528 |

## 适配边界

原 SVG 几何直接复用；React 组件、JSONL 工具名称到活动类型的映射为本项目适配代码，并非复制整套 Codex 前端。
Codex 使用 parsedCmd/source.kind 等结构化数据，本项目的原生记录未总是提供这些字段，因此只识别明确的工具名、参数和脚本内工具调用。
Computer Use 与 browser use 分开；未知工具保留原名与通用图标。结果按 call_id 归并，同一组保留各次调用，不把反复操作电脑压成一次。
没有可靠成功状态时使用中性动作描述，不把失败的图片调用写成“已查看”。

## 验证

13 项定向测试、前端类型检查、相关源码 lint、diff 检查通过。
隔离 Electron 渲染 10 类合成工具活动，检查默认收起、条目数量、图标和摘要。
[图标截图](evidence/herdr-design/codex-tool-icons.png)。
