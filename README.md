# superagent-ops

OpenCode V2 会话与子代理运维套件：一个 server 插件（看门狗）+ 一个 Agent Skill（派工/看门狗/救援操作手册）。源自对 DeepSeek Harness《Super-agent 设计探索》的工程实践。

## 包含什么

```
plugin/watchdog.js          OpenCode V2 server 插件：会话看门狗
skill/SKILL.md              Agent Skill：派工契约、看门狗判据、会话救援
skill/references/           架构依据文档（DS Super-agent 分析 + 本机整合现状）
skill/tools/                运维脚本
  watchdog.ps1 / .sh        （旧版，手动排障备用）看门狗 + 按家族播报
  meta_watchdog.ps1         级联看门狗：外部进程监督插件心跳（WDT of WDT）
  children_check.js         子任务舰队状态表
  revive_session.js         卡死会话救援（interrupt + run --continue）
  resume_runner.js          续跑器（被 ps1/sh 复用）
```

## 看门狗设计（plugin/watchdog.js）

- **按 location 归属**：每个位置的实例只看门自己目录下的会话，互不干扰
- **5 分钟 sweep 分层**：
  - 15min 静默 → nudge（steer 一条 ping，每 run 一次）
  - 同工具同参数 ×3 → 循环告警
  - 长跑 ≥30min、每 60min → 漂移判定（flash 档模型，只告警不打断）
  - 30min 静默 → interrupt（可按目录覆写阈值）+ **自动复活**（`opencode run --continue`，上限 2 次/run）
- **门控**：worker 子会话豁免（归主会话管）；权限卡片等待跳过；长工具调用由 `session.tool.progress` 续命；有运行中子代理的主会话视为 busy
- **自愈**：打断前落现场（post-mortem），打断后驱动会话自行汇报
- 日志：`~/.local/state/opencode/watchdog/plugin.log`

## 安装

1. 插件：`plugin/watchdog.js` → `~/.config/opencode/plugins/watchdog.js`，保存即热重载（或 `opencode reload`）
2. Skill：整个 `skill/` → `~/.agents/skills/superagent-ops/`（或 `~/.config/opencode/skills/`）
3. 级联看门狗（可选，Windows）：`skill/tools/meta_watchdog.ps1 -Install`（静默定时任务，15 分钟查一次插件心跳；op 关闭时静默跳过）

## 依据

`skill/references/dsh-superagent-analysis.md`：Super-agent 五模块与工程映射、生态调研裁决（40 个 watchdog 仓库）、本机落地经验清单。

MIT