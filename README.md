# opencode-watchdog-plugin

OpenCode V2 server 插件：本地会话看门狗（备份仓库）。

- 按 location 归属（每实例只看自己目录）
- 5 分钟 sweep：15min 静默 nudge → 30min interrupt（bmall 90min）
- 循环检测（同参数 ×3）、长跑每 60min 漂移判定（只告警）、权限等待跳过、子代理感知 busy
- 日志：`~/.local/state/opencode/watchdog/plugin.log`

安装：放到 `~/.config/opencode/plugins/watchdog.js` 后 `opencode reload`。
