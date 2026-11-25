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
- **策略门禁**：`bash tools/check-watchdog-policy.sh`（断言所有 `send()` 只能发给父会话；带变异自检，根会话监督回流必红）
- 日志：`~/.local/state/opencode/watchdog/plugin.log`

## 同类插件与优化候选（2026-11-25 复核）

### 直接同类

| 插件 | V2 | 许可 | 与本插件的关系 | 可借鉴点 |
|---|---|---|---|---|
| [Mte90/opencode-auto-resume](https://github.com/Mte90/opencode-auto-resume) | ✅ V1/V2 | GPL-3.0 | 功能最全，但会自动恢复根会话，和 v11「根会话由人负责」冲突；**不能并存** | token 增长算活动、子会话空回复/错误恢复、交替循环指纹、重试预算 |
| [joeyism/opencode-keepalive](https://github.com/joeyism/opencode-keepalive) | 声称支持；V2 options 示例仍用 tuple，需实测 | MIT | 最小的心跳+子会话恢复插件，可参考但不宜直接叠加 | 按工具分类的 stall budget、quick/long/unknown bash 分类、NDJSON 心跳 |
| [hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) | ✅ | MIT | 完整多代理团队编排，不是 watchdog；会引入 SQLite、worktree、自动合并 | token/step 进度判定、超时与 stall 分离、通知去重、崩溃恢复 |
| [Dqz00116/opencode-agents-monitor](https://github.com/Dqz00116/opencode-agents-monitor/tree/feat/v2) | ✅ beta | MIT | TUI 只读面板，不告警不恢复；可作人工观察面 | 子会话状态/当前工具/耗时/上下文可视化 |
| [mohak34/opencode-notifier](https://github.com/mohak34/opencode-notifier) | ✅ | MIT | 桌面通知，不解决 AI 是否读取；可作补充渠道 | 事件分组、最短时长、子会话完成延迟、敏感 token 只走 argv |
| [ByBrawe/opencode-loop](https://github.com/ByBrawe/opencode-loop) | ✅ | MIT | idle 自动续跑/调度，不是 stall watchdog | due 与 safe-to-dispatch 分离、busy/child 时不叠加 prompt、Goal 占用检查 |

结论：**没有发现能直接替换 v11 的同款插件**。auto-resume 最接近但会恢复根会话；keepalive 最轻但 V2 配置需验证；其余都是编排、UI 或通知层。多个 watchdog 不要同时装，否则会互相唤醒/打断。

### 优化 backlog（按价值排序）

1. **P0 子会话「结束即死」检测**：当前只监督 active 会话；`execution.succeeded/failed` 后立即删状态，idle 子会话若以 provider error 或空回复结束，父会话可能永远等不到结果。应在终态事件做一次只读检查：最新 assistant 无文本、无工具、或带可分类错误 ⇒ 立即通知父会话（只带脱敏错误类别，不带原文）。参考 auto-resume 的 subagent dead response / silent dead-stream。
2. **P0 通知按父会话合并 + wake 预算重置**：同一 sweep 多个子会话报警时合成一条；wake 上限改为「真实用户新回合」重置，而不是插件生命周期内永久累计或热重载归零。参考 notifier grouping、auto-resume episode budget、ensemble undeliverable-nudge 抑制。
3. **P0 按工具设置 stall budget**：当前「有未完成工具就永不打断」会永久保护卡死的 grep/build。改为 quick 工具 1–2min、build/test 10–30min、unknown fail-safe 到 long；超时才通知/打断。参考 keepalive strictest fuse + bash 分类、auto-resume `stuckToolAgeMs`。
4. **P1 进度语义**：把 token 增长和 block-boundary 事件算作活动，避免长推理流被误判 idle；重复内容但 token 不涨仍算卡死。参考 auto-resume token-flow liveness。
5. **P1 循环指纹升级**：当前只抓连续 3 次完全相同；改为 `tool name + 归一化 args`，并识别长度 2–5 的交替循环。参考 auto-resume live loop detector。
6. **P1 通知带证据且入库前脱敏**：带上最后工具名、最后写入时间、idle 时长、错误分类；标题/错误做控制字符清理、截断和密钥掩码后再写日志/发 prompt。
7. **P1 状态文件原子写**：`notify-state.json` 改同目录临时文件 + rename；多实例写入前 merge，避免并发丢更新或半文件。
8. **P2 最小可观测面**：先做 `watchdog status` 文本快照，不急着引入 TUI/仪表盘；需要时再参考 agents-monitor。
9. **P2 配额/鉴权错误早报**：子会话遇 429/401 时通知父会话并带 `retry-after`，不自动换模型、不烧配额。参考 auto-resume rate-limit cooldown。

## 安装

1. 插件：`plugin/watchdog.js` → `~/.config/opencode/plugins/watchdog.js`，保存即热重载（或 `opencode reload`）
2. Skill：整个 `skill/` → `~/.agents/skills/superagent-ops/`（或 `~/.config/opencode/skills/`）
3. 级联看门狗（可选，Windows）：`skill/tools/meta_watchdog.ps1 -Install`（静默定时任务，15 分钟查一次插件心跳；op 关闭时静默跳过）

## 依据

`skill/references/dsh-superagent-analysis.md`：Super-agent 五模块与工程映射、生态调研裁决（40 个 watchdog 仓库）、本机落地经验清单。

MIT