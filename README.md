<p align="center">
  <h1 align="center">opencode-worker-plugin</h1>
  <p align="center">Async multi-agent orchestration for opencode — spawn, control, and coordinate worker subagents</p>
  <p align="center">
    <a href="https://github.com/itheamyvalgulious/opencode-worker-plugin"><img src="https://img.shields.io/badge/GitHub-itheamyvalgulious%2Fopencode--worker--plugin-blue" alt="GitHub"></a>
    <a href="https://github.com/itheamyvalgulious/opencode-worker-plugin/stargazers"><img src="https://img.shields.io/github/stars/itheamyvalgulious/opencode-worker-plugin" alt="Stars"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
    <a href="README_EN.md"><img src="https://img.shields.io/badge/lang-English-blue" alt="English"></a>
  </p>
</p>

---

opencode-worker-plugin 将 opencode 转变为异步多智能体编排器。主 agent (例如你自行定义的 `designer` 编排 agent) 可以将复杂任务拆分为定义清晰的子任务，并发派发给 worker 子 agent 并行执行，同时主 agent 继续工作。当整个反馈组的所有 worker 都完成时，主 agent 会自动被唤醒并获得完成摘要。Timer 也可以触发定时唤醒。

## 特性

- **异步并发** — 主 agent 可以 spawn 多个 worker 并行执行，无需等待
- **反馈组 (feedback groups)** — 将 worker 归入同一组，当组内全部完成时自动通知主 agent
- **Worker 生命周期管理** — spawn, send, read, interrupt, shutdown, list
- **推理档位 (variant)** — `worker_spawn` 必填 `variant` 参数 (low/medium/high/xhigh/max) 直接控制每次 prompt 的推理深度, 无需预注册变体 agent
- **Timer** — 定时唤醒主 agent; 仅用于用户明确要求监控超长任务 (预计 >1h) 时的中途检查，不用于轮询等待
- **notify_parent** — worker 主动上报阻塞或问题
- **双后端** — 内置 OpenCode 子会话 (默认) 和可选的 agy CLI 外部进程
- **自动 agent 注册** — 自动注册 `worker` agent，安装即用; 编排用的 `designer` agent 需自行定义
- **零配置单文件安装** — 即拿即用

## 安装

### 一行命令安装 (全局)

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash
```

wget 版本:

```bash
wget -qO- https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash
```

### 版本锁定

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | WORKER_PLUGIN_REF=v0.2.0 bash
```

### 项目本地安装

需要先下载安装脚本:

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh
bash install.sh --local
```

这会将 `worker-plugin.ts` 安装到 `$PWD/.opencode/plugins/` 中。

### 手动安装

下载 `worker-plugin.ts` 并放入 opencode 的插件目录:

```bash
curl -fsSL -o worker-plugin.ts https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/worker-plugin.ts
mv worker-plugin.ts ~/.config/opencode/plugins/
```

或者直接放置到以下路径:

```
~/.config/opencode/plugins/worker-plugin.ts
```

### 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash -s -- --uninstall
```

项目本地卸载:

```bash
bash install.sh --local --uninstall
```

## 快速开始

1. 重启 opencode
2. 在 agent 选择器中选择你的编排 agent (例如自行定义的 `designer`，见 [Agents](#agents))
3. 发送类似以下 prompt:

> "用 designer agent 把这个任务拆成子任务并行执行: ..."

所有工具 (`worker_spawn` 等) 和 `worker` agent 会自动出现，无需额外配置; 编排用的 `designer` agent 需自行定义 (见 [Agents](#agents))。

## 工具参考

| 工具 | 参数 | 描述 |
|------|------|------|
| `worker_spawn` | prompt, title, group, model, agent, variant | 创建并启动一个后台 worker 子 agent。`title` 是唯一标识名, `group` 用于反馈组, `variant` 必填 (low/medium/high/xhigh/max) |
| `worker_send` | id, text, model, variant | 向 worker 发送新的指令 (如果 busy 则排队), 可切换模型。可选 `variant` 覆盖该 worker 的推理档位 (agy 后端仅在重启时生效) |
| `worker_read` | id, tail, limit | 读取 worker 最近的对话内容 |
| `worker_list` | (无参数) | 列出所有活跃 worker 及其状态 |
| `worker_interrupt` | id | 中断 worker 当前操作 (保留上下文) |
| `worker_shutdown` | id, delete | 终止 worker，可选删除会话历史 |
| `models()` | (无参数) | 列出可用的 OpenCode 和 agy 模型 |
| `set_timer` | time, message | 设置定时器: 在 `time` 秒后唤醒主 agent |
| `notify_parent` | message | (worker 内使用) 主动唤醒父 agent 并上报信息 |

## 概念

### Variant

`worker_spawn` 的必填参数 `variant` 取值 low/medium/high/xhigh/max, 在每次 prompt 上直接施加推理深度。OpenCode 后端模型不支持该档位时静默回落模型默认; agy 后端映射为 `--effort`, xhigh/max 钳位为 high。

### 反馈组 (Feedback Groups)

`worker_spawn` 的 `group` 参数将多个 worker 归入同一反馈组。当该组 **所有** worker 都完成时，父 agent 被唤醒一次并收到完成列表。之后向组内任一 worker 发送新指令 (`worker_send`) 会自动重新激活整个组的反馈机制。

### Worker 状态

| 状态 | 描述 |
|------|------|
| `starting` | 正在初始化 |
| `busy` | 正在执行当前指令 |
| `idle` | 空闲，等待新指令 |
| `retry` | 遇到提供方错误，自动重试 |
| `error` | 需要人工处理 |
| `interrupted` | 已被中断 |

### Timer

`set_timer(time, message)` 设置一个定时器，在 `time` 秒后将 `message` 投递给主 agent。非阻塞执行，立即返回 timer ID。

注入给 agent 的规则禁止用 sleep 或 timer 等待 worker 完成: 没有可做的事时应直接结束本轮动作，等待反馈组完成通知。`set_timer` 仅允许一种用途 —— 某个 worker 正在执行超长任务 (预计超过 1 小时) 且用户明确要求监控 subagent 执行时，用它在中途查看 worker 是否跑偏。见 [注入的系统规则](#注入的系统规则)。

### notify_parent

仅 OpenCode 后端 worker 可用。当 worker 遇到不明确的需求、阻塞或无法自行解决的问题时，调用 `notify_parent(message)` 主动唤醒父 agent 并报告情况。

### 注入的系统规则

插件会向每个会话的 system prompt 注入一段 worker 使用说明 (worker-plugin-system)，内容包括:

- 各工具 (`worker_spawn` / `worker_read` / `worker_send` / `worker_interrupt` / `worker_shutdown` / `worker_list` / `models` / `set_timer` / `notify_parent`) 的接口与用法
- 反馈组策略: 同组全部到达终态时唤醒一次; 重新 `worker_send` 会重置组状态
- 等待规则: 禁止用 sleep 或 `set_timer` 等待 worker 完成; 无事可做时直接结束本轮动作，静待组完成通知; 禁止轮询 `worker_list` 检查完成
- `set_timer` 的唯一允许用途: worker 执行超长任务 (预计超过 1 小时) 且用户明确要求监控 subagent 时
- 该说明只讲 worker 如何使用，不含任何编排者专属指令或模型偏好

## Agents

安装后自动注册以下 agents:

| Agent | 说明 |
|-------|------|
| `worker` | 默认 worker，通用执行能力 (插件自动注册) |

变体不再通过 `worker-xx` agent 控制 (v0.2.0 起移除); 统一通过 `worker_spawn` 的 `variant` 参数指定。

编排用的 `designer` agent 不再由插件注册。请在 `~/.config/opencode/agent/designer.md` 或 `opencode.json` 的 `agent` 字段中自行定义 (mode: primary)。

如果用户在 `opencode.json` 或 `~/.config/opencode/agent/*.md` 中已经定义了同名的 `worker` agent，插件不会覆盖用户的定义。

## Agy 后端 (可选)

插件支持外部 `agy` CLI 作为 worker 后端。需要:

1. 安装 agy CLI (Antigravity 的命令行工具, 需自行获取)
2. 如果 agy 不在 PATH 中，设置 `WORKER_PLUGIN_AGY_BINARY` 环境变量
3. 使用 `agy/<slug>` 格式的 model 参数 spawn worker，例如 `agy/gemini-3.8-flash-high`
4. 使用 `models()` 工具发现可用的 agy 模型 slug
5. variant 映射: low/medium/high → `--effort`; xhigh/max 钳位为 high
6. 权限模式: agy worker 以 --dangerously-skip-permissions 启动, 所有工具权限请求自动批准, 适合无人值守的后台执行

## 系统要求

- opencode 1.18.x 或更新版本 (已经过测试)
- Linux 或 macOS (WSL 可用)
- curl 或 wget
- (可选) agy CLI — 用于外部 worker 后端

## 常见问题

### 它是如何工作的？不需要编辑配置文件吗？

opencode 会自动加载 `~/.config/opencode/plugins/` (或项目 `.opencode/plugins/`) 下所有的 `.ts` 和 `.js` 文件。同时 opencode 在启动时会自动安装 `@opencode-ai/plugin` npm 依赖。因此安装后只需重启即可。

### 有 npm 包吗？

计划中。目前推荐通过安装脚本或直接复制文件来安装。

### 从旧版本升级?

v0.2.0 移除了 `worker-xx` 变体 agent; 改为在 `worker_spawn` 传入必填 `variant` 参数。旧的 `agent: "worker-max"` 写法改为 `variant: "max"`。

插件不再自动注册 `designer` 编排 agent; 请自行定义 (见 [Agents](#agents))。若你此前依赖自动注册的 `designer`，升级后需要自己补一个。

### 它会发送我的数据到外部吗？

不会。一切都在本地运行，没有任何遥测或网络请求 (除了安装时的下载)。

## 许可

MIT License. Copyright (c) 2026 Ithea Valgulious.