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

## 看门狗设计（plugin/watchdog.js，v11）

- **根会话由人负责**：不 ping、不空转提醒、不漂移告警、不打断、不自动复活；只写低频 `root idle, no action` 日志（每小时一次）
- **只监督子会话（会话级归属）**：通知永远发给子会话自己的父会话，不跨会话：
  - 10min 有回合但无写操作 → 通知父会话（空转，冷却 20min）
  - 同工具同参数 ×3 → 通知父会话（子会话疑似循环）
  - idle ≥60min → 通知父会话
  - idle ≥4h → 打断该子会话并通知父会话（最新回合有未完成工具时不打断）
- **5 分钟 sweep**：按 location 只看自己目录下的会话；`session.tool.progress` 续命
- **通知投递**：目标 running → steer；目标 idle → `opencode run --continue` 真唤醒（上限 6 次/会话）
- **去重**：`watchdog/notify-state.json` 跨热重载去重，7 天自动清理
- 日志：`~/.local/state/opencode/watchdog/plugin.log`

## 安装

1. 插件：`plugin/watchdog.js` → `~/.config/opencode/plugins/watchdog.js`，保存即热重载（或 `opencode reload`）
2. Skill：整个 `skill/` → `~/.agents/skills/superagent-ops/`（或 `~/.config/opencode/skills/`）
3. 级联看门狗（可选，Windows）：`skill/tools/meta_watchdog.ps1 -Install`（静默定时任务，15 分钟查一次插件心跳；op 关闭时静默跳过）

## 依据

`skill/references/dsh-superagent-analysis.md`：Super-agent 五模块与工程映射、生态调研裁决（40 个 watchdog 仓库）、本机落地经验清单。

MIT