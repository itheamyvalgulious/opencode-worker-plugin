<p align="center">
  <h1 align="center">opencode-worker-plugin</h1>
  <p align="center">Async multi-agent orchestration for opencode — spawn, control, and coordinate worker subagents</p>
  <p align="center">
    <a href="https://github.com/itheamyvalgulious/opencode-worker-plugin"><img src="https://img.shields.io/badge/GitHub-itheamyvalgulious%2Fopencode--worker--plugin-blue" alt="GitHub"></a>
    <a href="https://github.com/itheamyvalgulious/opencode-worker-plugin/stargazers"><img src="https://img.shields.io/github/stars/itheamyvalgulious/opencode-worker-plugin" alt="Stars"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
    <a href="README.md"><img src="https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-green" alt="中文"></a>
  </p>
</p>

---

opencode-worker-plugin turns opencode into an async multi-agent orchestrator. The main agent (e.g. your own `designer` orchestrator) can decompose complex tasks into well-defined subtasks, dispatch them to parallel worker subagents, and continue working while they run. The main agent is automatically woken when an entire feedback group completes or a timer fires.

## Features

- **Async concurrency** — Spawn multiple workers in parallel without blocking the main agent
- **Feedback groups** — Group workers together; the parent is woken once when all group members finish
- **Worker lifecycle management** — Spawn, send, read, interrupt, shutdown, list
- **Variants** — The required `worker_spawn` `variant` parameter (low/medium/high/xhigh/max) controls reasoning depth on every prompt — no pre-registered tier agents
- **Timers** — Schedule wake-up notifications; only for user-requested mid-flight checks on very long tasks (>1h), not for polling
- **notify_parent** — Workers proactively report blockers to their parent
- **Dual backend** — Built-in OpenCode sessions (default) and optional external agy CLI processes
- **Auto agent registration** — The `worker` agent is registered automatically; the `designer` orchestrator must be defined by you
- **Zero-config single-file install** — One command, done

## Install

### One-liner (global)

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash
```

wget variant:

```bash
wget -qO- https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash
```

### Pin a version

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | WORKER_PLUGIN_REF=v0.2.0 bash
```

### Project-local install

Download the script first:

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh
bash install.sh --local
```

This installs `worker-plugin.ts` into `$PWD/.opencode/plugins/`.

### Manual install

Download `worker-plugin.ts` and place it into opencode's plugin directory:

```bash
curl -fsSL -o worker-plugin.ts https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/worker-plugin.ts
mv worker-plugin.ts ~/.config/opencode/plugins/
```

Or simply put the file at:

```
~/.config/opencode/plugins/worker-plugin.ts
```

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash -s -- --uninstall
```

Uninstall a local install:

```bash
bash install.sh --local --uninstall
```

## Quick start

1. Restart opencode
2. Switch to your orchestrator agent in the agent picker (e.g. your own `designer` — see [Agents](#agents))
3. Send a prompt like:

> "Use the designer agent to decompose this task into parallel subtasks: ..."

All tools (`worker_spawn`, etc.) and the `worker` agent appear automatically — no configuration needed. The `designer` orchestrator must be defined by you (see [Agents](#agents)).

## Tool reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `worker_spawn` | prompt, title, group, model, agent, variant | Create and start a background worker subagent. `title` is a unique name, `group` enables feedback batching, `variant` is required (low/medium/high/xhigh/max) |
| `worker_send` | id, text, model, variant | Send a new instruction to a worker (queued if busy), optionally switching the model. Optional `variant` overrides the worker's reasoning effort (agy backend only effective when restarting) |
| `worker_read` | id, tail, limit | Read a worker's recent conversation history |
| `worker_list` | (none) | List all active workers and their statuses |
| `worker_interrupt` | id | Interrupt a worker's current operation (preserves context) |
| `worker_shutdown` | id, delete | Terminate a worker, optionally deleting session history |
| `models()` | (none) | List available OpenCode and agy models |
| `set_timer` | time, message | Schedule a timer to wake the parent agent after `time` seconds |
| `notify_parent` | message | (used inside a worker) Proactively wake the parent agent with information |

## Concepts

### Variant

The required `worker_spawn` `variant` parameter (low/medium/high/xhigh/max) controls reasoning depth on every prompt. If the OpenCode backend model doesn't support the tier, it silently falls back to the model's default. For the agy backend, it maps to `--effort`, with xhigh/max clamped to high.

### Feedback Groups

The `group` parameter of `worker_spawn` assigns workers to a feedback group. When **all** workers in the group reach a finished state, the parent agent is woken once with a completion summary. Sending a new instruction (`worker_send`) to any member of a group automatically re-activates the group's feedback mechanism.

### Worker Statuses

| Status | Description |
|--------|-------------|
| `starting` | Initializing |
| `busy` | Executing current instruction |
| `idle` | Waiting for new instructions |
| `retry` | Provider error, auto-retrying |
| `error` | Requires manual handling |
| `interrupted` | Has been interrupted |

### Timers

`set_timer(time, message)` schedules a wake-up: after `time` seconds, the parent agent receives `message`. Non-blocking, returns a timer id immediately.

The injected rules forbid using sleep or timers to wait for workers: when there is nothing to do, end the turn and wait for the feedback-group completion notification. `set_timer` has exactly one allowed use — mid-flight checks on a worker running a very long task (expected >1 hour) when the user explicitly asks to monitor subagent execution. See [Injected system rules](#injected-system-rules).

### notify_parent

Available only for OpenCode-backend workers. When a worker encounters unclear requirements, blockers, or problems it cannot resolve, it calls `notify_parent(message)` to proactively wake the parent agent and explain the situation.

### Injected system rules

The plugin injects a worker-usage block (`worker-plugin-system`) into every session's system prompt. It covers:

- Interfaces and usage for every tool (`worker_spawn` / `worker_read` / `worker_send` / `worker_interrupt` / `worker_shutdown` / `worker_list` / `models` / `set_timer` / `notify_parent`)
- Feedback-group strategy: wake once when the whole group reaches a terminal state; a new `worker_send` re-activates the group
- Waiting rules: never use sleep or `set_timer` to wait for workers; when idle, end the turn and wait for the group completion notification; never poll `worker_list`
- The only allowed use of `set_timer`: monitoring a worker on a very long task (>1h) when the user explicitly asks for it
- The block only describes how to use workers — it contains no orchestrator-only directives and no model preferences

## Agents

The following agents are registered automatically on install:

| Agent | Description |
|-------|-------------|
| `worker` | Default worker with general execution capability (registered by the plugin) |

Variants are no longer controlled via `worker-xx` agents (removed in v0.2.0); pass the required `variant` parameter to `worker_spawn` instead.

The `designer` orchestrator is no longer registered by the plugin. Define it yourself in `~/.config/opencode/agent/designer.md` or the `agent` field of `opencode.json` (mode: primary).

If the user has already defined a `worker` agent in `opencode.json` or `~/.config/opencode/agent/*.md`, the plugin will not override it.

## Agy Backend (Optional)

The plugin supports an external `agy` CLI as a worker backend. To use it:

1. Install the agy CLI (Antigravity's command line tool)
2. Set `WORKER_PLUGIN_AGY_BINARY` if `agy` is not on your PATH
3. Spawn workers with model refs in the format `agy/<slug>`, e.g. `agy/gemini-3.8-flash-high`
4. Use the `models()` tool to discover available agy model slugs
5. Variant mapping: low/medium/high → `--effort`; xhigh/max clamped to high
6. Permission mode: agy workers start with --dangerously-skip-permissions — all tool permission requests are auto-approved, suited for unattended background execution

## Requirements

- opencode 1.18.x or newer (tested)
- Linux or macOS (WSL works)
- curl or wget
- (Optional) agy CLI for the external worker backend

## FAQ

### How does it work without editing config files?

Opencode automatically loads all `.ts` and `.js` files from `~/.config/opencode/plugins/` (or project `.opencode/plugins/`) at startup. It also auto-installs the `@opencode-ai/plugin` npm dependency in the background. A restart is all you need.

### Is there an npm package?

Planned. For now, install via the script or by copying the file manually.

### Upgrading from an older version?

v0.2.0 removed the `worker-xx` tier agents; use the required `variant` parameter instead (`agent: "worker-max"` → `variant: "max"`).

The plugin no longer auto-registers the `designer` orchestrator; define it yourself (see [Agents](#agents)). If you relied on the auto-registered `designer`, you now need to add one.

### Does it send my data anywhere?

No. Everything runs locally with no telemetry or network requests (except downloading the plugin during install).

## License

MIT License. Copyright (c) 2026 Ithea Valgulious.