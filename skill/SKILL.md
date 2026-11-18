---
name: superagent-ops
description: 会话与子代理运维套路（源自对 DeepSeek Super-agent 架构的分析+本机实证判据）。覆盖：子代理派工与 sessionID 续聊省 token、Router/Worker 模型分档、长任务看门狗（假运行判据与复活流程）、长命令后台化与中间回报、任务状态机读落盘、投机复现、fail-closed 安全禁令。在派子代理、写工单、驱动长任务、发现会话假死/假运行/进度停滞、恢复中断会话、控制 token/配额消耗时使用。
license: MIT
metadata:
  version: "1.0"
  source: DeepSeek Harness《Super-agent 设计探索》(2026-10-31) + 本机 opencode 实证判据
---

# superagent-ops：会话与子代理运维

两条判据级原则：

1. **结构优于提示**：希望模型做出的行为（委派、不越界、必须审查），只要违约代价高，就做成结构约束，不要写进提示词求它。实证：带 Subagent 工具的模型在中性提示下 5 次运行 0 次委派；结构化的双层方案完成时间方差消失。
2. **能力剥夺优于行为承诺**：约束=拿掉能力（不配工具/不给凭据/不放权限）；承诺=口头禁令+事后审计。违约代价不可接受 ⇒ 必须剥夺；软性偏好 ⇒ 才用承诺。

## 1. 看门狗外环（假运行/假死）

判据（本机实证，勿凭 outcome 判断）：
- `outcome=succeeded` 不代表完成也不代表没在跑；只信 `/api/session` 的 `updated` 是否前移。
- prompt 发进 idle 会话只进 inbox（delivery=steer），**不会唤醒**。
- 判定假运行：active 列表有它 + `updated` 停涨 + inbox 滞留。

复活序列：
1. `POST /api/session/{全ID}/interrupt` → 确认 active 不再列出
2. 指令落文件，node spawnSync 读文件传参，`opencode run -s <全ID> --continue --agent build --auto "<指令>"`，输出重定向日志
3. 复核：active 重现该会话 + 消息 `time.created` 前移

API 细节（端点、Basic Auth、分页截断坑）见记忆块 opencode-ops；长跑命令的输出落盘+退出码写文件纪律见 windows-shell-gotchas。

**定稿方案（2026-11-04 更新）：V2 server 插件 `~/.config/opencode/plugins/watchdog.js` v7**——`export default { id, setup }`；**按 location 归属**；每轮 sweep 用 `/api/session/active`（服务自身权威接口，service.json 凭据）刷新运行中会话，**不再依赖事件流/`!outcome` backfill**（v2.2.5 里运行中会话也带 outcome=succeeded/interrupted，旧过滤会捞 0；事件流会静默失效）。5 分钟 sweep：
- **L1 15min 静默 → nudge**（steer ping，每 run 一次）
- **L1b 空转 10min → 通知**（v9）：近 10 分钟有 ≥2 个 assistant 回合、但**没有任何写操作**（write/edit/patch，或写类 shell：New-Item/Copy-Item/Set-Content/Out-File/protoc/go build/git commit 等；纯读取/确认不算）⇒ 子会话通知父会话、根会话自我提醒，冷却 20 分钟。父会话一次"进度检查"steer 往往就能把它踢回写代码
- **L2 循环检测**：同工具同参数连续 ×3 → steer 警告
- **L3 漂移检测**：长跑 ≥30min、每 60min 一次，默认模型判定，**只告警不打断**
- **L4 30min 静默 → 先警告、次轮仍静默才 interrupt**（bmall 90min）+ **自动复活**（detached `opencode run --continue` 报告型指令，上限 2 次/run）——queue 提示不唤醒 idle，必须驱动
- 门控：**子会话按会话级归属**——主会话只管自己派发的子会话（通知永远发给其父会话，绝不跨会话）：子会话 idle ≥60min 通知父会话、≥4h 打断子会话并告知父会话（不要全局 worker 规则，否则面太大）；busy 父会话（有运行中子代理）只 ping 不打断；permission 卡片等待跳过；`session.tool.progress` 续命
- **goal 感知**：原生 `/goal`（v2.2.1+）状态经 RPC `opencode.goal.get({sessionID})` 可读——`status=active` 的会话**全跳过**（nudge/警告/打断/漂移），交给 goal 引擎（idle-hook 续跑 + judge 评审，maxRounds 默认 50、连续 stall 3 次自动 pause）。长任务开工用 `/goal <objective>`（pause/resume/clear）
- **通知投递**（v10）：目标会话 running → steer 进当前执行；**idle → spawn `opencode run -s <id> --continue --auto "<文本>"` 主动唤醒**（否则 prompt 只进 inbox、AI 永远不会读）；每会话唤醒上限 6 次。**长工具保护**：最新 assistant 回合仍有 `state.status` 未完成的工具（go build/protoc/test）⇒ 不打断。通知去重持久化在 `watchdog/notify-state.json`（7 天清理）；同一轮同时命中「空转 + nudge」只发一条（空转优先）
- **救援口诀**：提示词无效（idle 会话不吃 prompt）⇒ interrupt + `opencode run -s <id> --continue`；`tools/` 外也有一键脚本 `revive_session.js`
实测教训：server-plugin console.log 不进 opencode.log（自写 plugin.log）；按 location 多实例加载；backfill 只用「无 outcome」会捞 85 天前老会话。生态调研（GitHub 40 个 watchdog 仓库）：无可替换方案——akane（V2 插件，Ping 先于 interrupt）、superadvisor（独立模型漂移审查）、ertval（nudge 升级）三个机制已吸收进 v3；jev-watch 依赖外部决策模型、chenxuan520/opencode-watchdog 每回合烧 judge、其余平台/依赖不合。

## 2. 派工：直通优先

- 复扫/续批/规格审查类任务：**用上次子代理的 sessionID 续聊**，不要开新工单让它重新考古。省的就是重复投喂的上下文（对应消融实验直通省 37% 读缓存）。
- 全新任务仍按 subagent-dispatch 契约写工单（背景/已确证事实/worktree/禁令/验收）；「续做」一律走 sessionID。
- **worktree 强制**（11-01，四个 worker-* agent 已内置）：写面 Worker 一律在 Router 预建的 worktree 内干活——工单必须含 worktree 绝对路径；Worker 开工自证 `git rev-parse --show-toplevel` == 工单路径；**无 worktree 路径 = 拒绝开工**（fail-closed，负例已实测会拒）。只读审计类豁免。建 worktree 前先 Set-Location 目标仓（归属仓 = 当前 shell 上下文，错位会建出幽灵 worktree）；**Go 构建缓存默认共享**（dot-source `tools/go-env.ps1` / `source tools/go-env.sh`；Go 官方声明 build cache 并发安全），仅当并发 `go test` 出现跨 worktree 假红时再设 `GOCACHE_PRIVATE=1` 隔离。

## 3. Router/Worker 模型分档

- 分派、汇总、审查、探索类子代理：flash 档；实现、修复类：主力模型。协调用的模型本来就不该和执行同档。
- 主会话=Router：只做分派与验收，**不亲自跑长命令**（前台阻塞会杀会话，是你踩过的高发点）。
- 厂商并行槽位（2026-11-04 实测更新；`~/.config/opencode/agents/`，frontmatter 钉模型 + 权限层 deny `git push*`）：
  - `worker-bailian` → alibaba-token-plan-cn/deepseek-v4.1-flash（百炼① magiclight；**单账号实测 3 路并发 200**）
  - `worker-bailian2` → alibaba-token-plan-cn-2/deepseek-v4.1-flash（百炼② 鑫小汇，独立 key）
  - `worker-go` → opencode-go/deepseek-v4.1-flash（op 主号）
  - `worker-go2` → opencode-go-2/deepseek-v4.1-flash（op neurondev 号；**Default 号无订阅，403 不可用**）
  - `worker-design` → open-design/deepseek-v4.1-flash（design 号）
  - `worker-ds` → deepseek/deepseek-flash（官方 API 补位槽）
- 选型口径（用户裁定）：**各厂商 deepseek-v4.1-flash 优先、glm-5.3-flash 次选，其它不选**；同模型跨账号并行即可，不必换模型。
- 并行容量（实测）：百炼 2 号 × ≥3 并发、opencode-go 2 号、design 1 号；**5 个 worker 槽同时派工**。
- **派工门槛**：预计 <15 分钟的小任务**主会话直接做**（子代理的冷启动+worktree+重新读上下文比直接做慢）；只有 >30min、独立、可验证的任务才派。工单必须塞满「已确证事实 + 文件清单」，否则子代理重新考古的时间比干活还长。
- **派工前自查配额**：`node tools/provider-health.js`（探 4 个号，429 会打印 retry-after）。2026-11-18 实测：magiclight 月配额耗尽（11-20 16:00 UTC 重置），鑫小汇正常 ⇒ 派工前先看，别把任务丢进重试黑洞。

## 4. 异步与全双工

- 超过 1 分钟的命令一律 background，输出落盘、退出码写进文件再读。
- 工单固定加一句：长门禁后台跑、先回报中间结论、保持稳定输出不要长时间静默（防空闲超时中断）。

## 5. 状态外置（可恢复）

- 每个在途批次在台账落一行**机读**状态：`会话ID | 分支/worktree | 下一步 | 卡点`（学 sync-boundary 机读标记的思路）。
- 收尾交接四步照旧（见 subagent-dispatch），但有了状态行，新会话恢复现场的成本=读一行。

## 6. 投机复现

- bug 反馈/失败日志一进对话 ⇒ 立即 background 一个子代理在 worktree 里静默复现，主对话继续；确认相关再浮出结果，无关直接丢弃。复现便宜，丢弃无代价。

## 安全禁令（fail-closed，工单不得豁免）

- 事件驱动的自主性只给**只读审计**类子代理。
- 写面、git push、DDL、重启网关、删文件：必须人工闸，任何工单都不能放行。
- bmall/生产库方向禁止无人触发的自动动作。

## 依据与展开

架构全文考据、消融数据、与本机工作流逐条对照、fail-closed 原理展开：见 `references/dsh-superagent-analysis.md`。
