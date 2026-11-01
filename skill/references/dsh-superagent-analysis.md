# DeepSeek Super-agent 架构分析（skill 依据文档）

> 源：DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》，2026-10-31 发布（知乎官方专栏全文 + 开源原型 dsh-superagent-prototype）。本文是本机对其的完整分析与工作流对照，正文结论以 SKILL.md 为准。

## 0. 本机整合现状（2026-11-01 定稿）

| 论文模块 | 本机落地 | 完成度 |
|---|---|---|
| ①双层架构 | 主会话=Router；worker-volc/bailian/go/design 四厂商槽（钉 v4.1-flash+deny push+worktree 强制）；sessionID 续聊=Thread 直通 | Worker 侧完整；Router 未剥夺 Bash（有意保留） |
| ②事件驱动 | **外部 Trigger 已接：飞书 DM**（opencode-feishu-plugin 长连接运行中，owner 白名单=fast path，permissionGate 卡片审批=人工闸，allowedRoots 锁 bmall，话题=会话）；事件流已通（execution.* 运行表、inbox steer/queue） | 基本完整：缺投机执行固化；群消息过滤有意不做（最小权限设计） |
| ③面向人的交互 | queue/steer 多信道投递、系统通知、后台长命令 | 缺 IM/GitHub 入口接入 |
| ④计算/状态/环境分离 | 未做（单机工作流，状态本机 SQLite；跨机靠会话归档） | 有意跳过 |
| ⑤Watchdog | server 插件 watchdog.js：事件驱动运行表+5min sweep+45min 停滞 auto-interrupt | **最完整**，但比论文轻：时间戳判定替代语义判断 |

与论文的三处关键分歧：Watchdog 不用模型会话（零 token，但「方向跑偏」语义检测成空缺）；家族播报比论文细（多主会话并行用 parentID 归族，论文 Router 是单例）；能力剥夺贯彻更狠（worker 层钉模型/deny push/worktree，论文只在 Router 无 Bash）。

待补（按 ROI）：投机执行固化（bug 进对话→自动后台复现）＞ 语义级 Watchdog。外部事件源已定：**飞书 DM**（opencode-feishu-plugin 已运行，appId cli_aa33…，allowedRoots=E:\work\bmall，gatewayLocation 同；非 owner 静默忽略=fast path，写面走 permissionGate 卡片审批；飞书触发会话自动继承全部闸——git 政策/watchdog/worker 策略；插件文档=E:\work\incosmos\opencode-v2-guide\skills\opencode-v2-feishu\）。

## 1. 问题定义

现有 Agent 以单 Session 为基本单位：多任务上下文靠人手动切换（实测一人只能盯 3–5 个活跃 Session）、ReAct Loop 同步阻塞、本地离线即停。单任务上限取决于模型能力，**多任务上限取决于人的注意力**。

## 2. 四特征 → 五模块

四个基础特征：连续、高效、主动、持久。

| 模块 | 支撑特征 | 抄的 OS/系统概念 |
|---|---|---|
| ① Router/Worker 双层 | 连续+高效 | 进程调度/主从 |
| ② 事件驱动 | 主动 | 中断+投机执行 |
| ③ 面向人的交互 | 连续+高效 | 全双工/多信道 I/O |
| ④ 计算、状态、环境分离 | 持久 | 存算分离 |
| ⑤ Watchdog | 持久 | 外部 Control Loop |

## 3. 各层设计要点

- **Router 不配 Bash**：把「不亲自执行」从提示词期望变成能力边界。Worker 挂全量工具+最强模型，上下文隔离，不直接对人说话。订阅机制：Worker 认领某 PR/话题（Thread）后，后续事件直通它，不过 Router。
- **事件驱动四级机制**：两级过滤（fast path 程序规则拦，slow path 模型判）；批处理（积压事件合并决策，单决策摊薄 6.4s→1.6s；事件速率 1→40 条/分钟仅 2.5s→3.9s）；投机执行（「静默复现并修复」，有价值才浮出）；Inline & Spill + 链式召回（窗口按局部性管理，长内容溢出留摘要+对象 ID，翻旧账沿引用图按需检索，不靠摘要压缩）。
- **异步 ReAct Loop**：耗时任务转后台，前台继续收指令，可中途改向/叫停。已在 Harness 实现，未默认开启。
- **存算分离 + BYOM**：云端跑无状态 Agent Loop、状态落数据库；重状态环境（代码仓/凭据/工具链）留本地，本地只装轻量无状态 daemon；离线任务不停。
- **Watchdog**：独立定时驱动的 Agent Session，既查基础设施故障，也用模型判断 Worker 有无实质进展/是否跑偏（Agent 长跑异常多数不是进程崩溃而是无效循环）。本身有完整工具，可用自然语言问故障、在线热改提示词与触发规则。

## 4. 实验数据与可信度

四方案（Super-agent / 去直通版 / 中性提示单Session+Subagent / 提示优先委派版），各 5 次，300 条合成消息约 20 条工作请求：

- Super-agent：p50=12.4min，p95=15.7min；中性提示单 Session：p95=29.5min。
- **关键发现**：中性提示下模型 5 次 0 次委派；强提示 4/5 委派，仍 1 次自判「活小」亲自干形成长尾 ⇒ 委派靠提示词不可靠，必须做成结构。
- 去直通：Router 决策 +30%，读缓存 2323 万→3177 万 token（+37%），完成时间基本不变 ⇒ 直通不损质量、纯省开销。
- 可信度边界（原文自认）：编码用纯耗时工具模拟，测的是调度协作不是编码质量；n=5；合成消息流。

## 5. 批判

亮点：①分工从 prompt 升格为系统结构（Router 无 Bash 与 fail-closed 同源）；②经典系统思想的正确平移，工程密度高；③实验证明「会不会用 subagent」不是模型能力问题，是默认激励机制问题。

风险（原文开放问题）：①安全是最大软肋——外部消息→事件驱动→云端指挥本地 daemon，被注入即直通代码仓与本地凭据，无机制级答案，fail-open 天然土壤；②跨 Worker 上下文边界与 A2A 无定论；③多会话常驻的账本依赖便宜缓存读取；④长期记忆（周/月级状态恢复）只列为难题。

## 6. 与本机工作流的对照改进（六条，详见 SKILL.md）

| 已踩坑 | 机制 | 改进 |
|---|---|---|
| 假运行/僵会话/prompt 不唤醒 idle | Watchdog+事件驱动 | 外部看门狗脚本定时核 updated 增量 |
| 子代理重复投喂全量上下文 | Thread 直通 | 复扫/审查用 sessionID 续聊 |
| 烧配额事故 | Router/Worker 分档 | 协调 flash、执行主力，主会话不跑长命令 |
| 长命令前台阻塞杀会话 | 异步 ReAct | background 默认化+中间回报 |
| 中断后靠记忆重建现场 | 状态外置 | 台账机读状态行（会话ID/分支/下一步/卡点） |
| bug 聊到一半没人跟进 | 投机执行 | 静默复现默认化，无关即弃 |

不照搬：事件全自主（金融仓 fail-open 禁止，自主性只给只读审计）；多 Worker 无边界并行（A2A 边界未解，worktree+热点文件清单继续人工管）。

## 7. fail-closed 原理展开（SKILL.md 原则 2 的论证）

两种保证机制：

| | 行为约束承诺 | 能力缺失保证 |
|---|---|---|
| 手段 | 提示词/规范写「不要做 X」 | 让它没有做 X 的工具 |
| 可靠性 | 概率性（服从度随上下文漂移） | 结构性（不存在另一条路径） |
| 失效 | 静默失效，未必观测得到 | 装配期暴露 |
| 本质 | 信任+纪律 | 权限模型 |

对模型尤其重要：①提示词约束与不可信输入走同一通道（都是文本），注入攻击打的就是这条通道；能力边界在通道之外，注入变不出 Bash。②本机同源案例：CORS fail-closed（未配置即拒绝，不是「默认放行记得配置」）；签名失败必须拒绝不得静默降级；反例——子代理工单「禁 commit/push」是承诺（靠纪律+审计兜底），父会话集中持凭据才是能力剥夺。

选用判据：**违约代价不可接受 ⇒ 能力剥夺；软性偏好 ⇒ 承诺。** 代价：能力剥夺粗粒度、牺牲灵活性（Router 连 grep 都做不了，小事也要走派发），故只用于边界清晰、违约代价高处。
