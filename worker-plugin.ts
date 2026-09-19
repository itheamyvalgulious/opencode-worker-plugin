import { tool, type Plugin } from "@opencode-ai/plugin"
import type { SessionPromptAsyncData } from "@opencode-ai/sdk"
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

// Valid values for the variant parameter (worker_spawn / worker_send)
const VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const
const DEFAULT_AGENT = "worker"
const PRIMARY_BASE = "build"
const PART_LIMIT = 300
const DEFAULT_TAIL = 6
const NAME_LIMIT = 40
const AGY_BINARY = process.env.WORKER_PLUGIN_AGY_BINARY ?? "agy"
const AGY_PREFIX = "agy/"
const AGY_MODELS_TIMEOUT = 15_000
const WORKER_PLUGIN_VERSION = "0.2.1"

type WorkerStatus = "starting" | "busy" | "idle" | "retry" | "error" | "interrupted"

type Backend = "opencode" | "agy"

type ModelRef = {
  providerID: string
  modelID: string
}

type ParentSessionState = {
  agent: string
  model: ModelRef
  variant?: string
}

type MessageInfo = {
  role?: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
  model?: {
    providerID?: string
    modelID?: string
    variant?: string
  }
}

type MessageEnvelope = {
  info?: MessageInfo
}

type AgyTranscriptEntry = {
  role: "user" | "assistant" | "tool" | "error" | "system"
  text: string
  detail?: string
}

type Worker = {
  id: string
  name: string
  group: string
  title: string
  agent: string
  model?: string
  variant?: string
  backend: Backend
  parentID?: string
  parentState: ParentSessionState
  status: WorkerStatus
  error?: string
  retry?: { attempt: number; message: string }
  createdAt: number
  updatedAt: number
  turns: number
  failures: number
  // Agy runtime state (only when backend === "agy")
  agyProcess?: ChildProcess
  agyReadline?: ReturnType<typeof createInterface>
  agyConversationID?: string
  agyTranscript?: AgyTranscriptEntry[]
  agyUsage?: Record<string, unknown>
  agyQueue?: string[]
  agyProcessExited?: boolean
  agyCwd?: string
}

type GroupState = {
  members: Set<string>
  notified: boolean
}

type TimerState = {
  id: string
  sessionID: string
  parentState: ParentSessionState
  message: string
  fireAt: number
  timer: ReturnType<typeof setTimeout>
}

const trunc = (s: unknown, n = PART_LIMIT): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + `…(+${t.length - n} chars)` : t
}

const errMsg = (e: unknown): string => {
  if (!e) return "unknown error"
  if (typeof e === "string") return e
  const obj = e as Record<string, unknown>
  const msg = String(obj.message ?? ((obj.data as Record<string, unknown>)?.message) ?? obj.name ?? "")
  return msg || trunc(JSON.stringify(e), 200)
}

const abortName = (e: unknown): boolean => {
  const n = String((e as Error)?.name ?? (e as Record<string, unknown>)?.type ?? "")
  return n === "MessageAbortedError" || n === "AbortError"
}

const slugify = (name: string): string => {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_LIMIT)
  return s || "worker"
}

const mapAgentToAgyArgs = (agent: string | undefined): string[] => {
  // agent undefined or "worker" (DEFAULT_AGENT) → no special args
  if (!agent || agent === DEFAULT_AGENT) return []
  // Custom agent name — pass as --agent
  return ["--agent", agent]
}

const variantToEffortArgs = (variant: string | undefined): string[] => {
  if (!variant) return []
  // agy only supports low|medium|high; clamp xhigh/max down to high
  const effort = variant === "xhigh" || variant === "max" ? "high" : variant
  return ["--effort", effort]
}

const WORKER_RULES = `<worker-plugin-system>
## Worker Subagent System

You have async worker subagents via the worker-plugin:
- \`models()\` — List all available models from both OpenCode and agy backends. Returns grouped entries in a format directly usable with \`worker_spawn.model\`. OpenCode models use 'provider/model' (e.g. \`epicrouter/deepseek-v4-flash\`); agy models use \`agy/<slug>\` (e.g. \`agy/gemini-3.8-flash-high\`). No API calls or token consumption.
- \`worker_spawn(prompt, title, group, model, variant, agent?)\` — Spawn a writable worker subagent and give it an initial instruction. NON-BLOCKING: returns immediately with the worker's semantic name. \`title\` is a short unique name you choose (semantic, e.g. "auth-refactor"); it is the id you use in all other worker tools. \`group\`, \`model\` and \`variant\` are required.
  - **OpenCode backend (default):** \`model\` format \`provider/model-id\` (e.g. \`epicrouter/deepseek-v4-flash\`), creates an internal sub-session.
  - **External agy backend:** \`model\` starts with \`agy/\` followed by a bare model slug (e.g. \`agy/gemini-3.8-flash-high\`). The worker runs as a local child process via the Antigravity CLI (\`agy\`). \`agent\` selects the worker agent (default "worker").
  - \`variant\` (low / medium / high / xhigh / max) controls the reasoning effort for every prompt of that worker. For agy workers xhigh/max are clamped to high.
- \`worker_read(name)\` / \`worker_send(name, text)\` / \`worker_interrupt(name)\` / \`worker_shutdown(name)\` / \`worker_list()\` — Manage workers. All accept the semantic name or the worker id. Use worker_read to inspect a worker's conversation; worker_send to queue more instructions; worker_interrupt to stop the current turn; worker_shutdown to close it.
- \`set_timer(time, message)\` — Async: after \`time\` seconds, wake this session once with \`message\`.
- Workers can call \`notify_parent(message)\` to proactively wake you (OpenCode workers only; agy workers cannot call this tool).

## Feedback groups

\`worker_spawn\` 的 \`group\` 参数把一批 worker 归入同一反馈组:
- 同组所有 worker 都到达终态 (idle / error / interrupted) 后, 你被唤醒一次, 通知里列出各 worker 的名称与状态.
- 需要等一批独立子任务全部完成后再继续时, 给它们相同的 group.
- 组通知发出后, 对任一成员再次 \`worker_send\` 会重置组状态, 全员再次完成后会再通知一次.
- 单个 worker 出错只静默记录, 不唤醒你; 全组到达终态时统一汇报.

## Waiting rules (强制)

- 禁止用 sleep 或 \`set_timer\` 等待 worker 完成.
- 当前没有可做的事时, 直接结束本轮动作, 静待组完成通知唤醒; 不要空转等待.
- 禁止轮询 \`worker_list\` 来检查完成情况.
- \`set_timer\` 只有一种允许用途: 某个 worker 正在执行超长任务 (预计超过 1 小时), 且用户明确要求监控 subagent 执行时, 用它在中途查看该 worker 是否跑偏. 其他任何场景都不得使用 \`set_timer\`.

## Rules

- Worker messages arrive as synthetic system notifications (\`<worker-notification>\`), not as user messages.
- Batch tasks that should only notify when ALL are done → give them the same \`group\`.
- Workers: if you encounter unclear requirements, blockers, or problems you cannot resolve on your own, use \`notify_parent(message)\` to proactively wake the parent agent and explain the issue. Do not guess or make assumptions when the task is underspecified.
- agy workers: \`model\` must start with \`agy/\` (e.g. \`agy/gemini-3.8-flash-high\`). Do NOT pass OpenCode \`provider/model\` format to agy workers. Use \`models()\` to discover available models for both backends without guessing.
</worker-plugin-system>`

export const WorkerPlugin: Plugin = async ({ client }) => {
  const workers = new Map<string, Worker>()
  const byName = new Map<string, string>()
  const groups = new Map<string, Map<string, GroupState>>()
  const pendingNotifications = new Map<string, string[]>()
  const timers = new Map<string, TimerState>()
  let timerSeq = 0
  const knownAgents = new Set<string>()

  const notify = async (message: string, variant: "info" | "success" | "warning" | "error") => {
    try {
      await client.tui.showToast({ body: { message, variant } })
    } catch { /* ignore */ }
  }

  const logWarn = (message: string) => {
    client.app
      .log({ body: { service: "worker-plugin", level: "warn", message } })
      .catch(() => {})
  }

  const queuePending = (sessionID: string, notification: string) => {
    const pending = pendingNotifications.get(sessionID) ?? []
    pending.push(notification)
    if (pending.length > 20) pending.splice(0, pending.length - 20)
    pendingNotifications.set(sessionID, pending)
  }

  const injectPending = (sessionID: string, output: { parts?: Array<{ type: string; text?: string }> }) => {
    const pending = pendingNotifications.get(sessionID)
    if (!pending || pending.length === 0) return
    pendingNotifications.delete(sessionID)
    const text = pending.join("\n\n")
    const parts = output.parts ?? []
    const first = parts.find((p) => p.type === "text")
    if (first) {
      first.text = `${text}\n\n${first.text ?? ""}`
      return
    }
    output.parts = [{ type: "text", text }, ...parts]
  }

  const parentStateFromMessage = (
    info: MessageInfo | undefined,
    fallbackAgent: string,
  ): ParentSessionState | undefined => {
    if (!info) return undefined
    const providerID = info.providerID ?? info.model?.providerID
    const modelID = info.modelID ?? info.model?.modelID
    if (!providerID || !modelID) return undefined
    const variant = info.variant ?? info.model?.variant
    return {
      agent: info.agent ?? fallbackAgent,
      model: { providerID, modelID },
      ...(variant !== undefined ? { variant } : {}),
    }
  }

  const captureParentState = async (
    sessionID: string,
    messageID: string,
    fallbackAgent: string,
  ): Promise<ParentSessionState | undefined> => {
    try {
      const response = await client.session.message({ path: { id: sessionID, messageID } })
      const state = parentStateFromMessage((response.data as MessageEnvelope | undefined)?.info, fallbackAgent)
      if (state) return state
    } catch (e) {
      logWarn(`failed to read parent message ${messageID}: ${errMsg(e)}`)
    }

    try {
      const response = await client.session.messages({ path: { id: sessionID } })
      const messages = (response.data ?? []) as MessageEnvelope[]
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const state = parentStateFromMessage(messages[i]?.info, fallbackAgent)
        if (state) return state
      }
    } catch (e) {
      logWarn(`failed to read parent session ${sessionID}: ${errMsg(e)}`)
    }

    logWarn(`unable to capture model and variant for parent session ${sessionID}`)
    return undefined
  }

  const pushToParent = async (
    parentID: string,
    parentState: ParentSessionState,
    text: string,
    wake: boolean,
  ): Promise<"sent" | "queued"> => {
    try {
      const body: NonNullable<SessionPromptAsyncData["body"]> & { variant?: string } = {
        agent: parentState.agent,
        model: parentState.model,
        ...(parentState.variant !== undefined ? { variant: parentState.variant } : {}),
        noReply: !wake,
        parts: [{ type: "text", text, synthetic: true }],
      }
      await client.session.promptAsync({
        path: { id: parentID },
        body,
      })
      return "sent"
    } catch (e) {
      queuePending(parentID, text)
      logWarn(`parent notification queued for ${parentID}: ${errMsg(e)}`)
      return "queued"
    }
  }

  const resolveWorker = (idOrName: string): Worker | undefined => {
    const sid = byName.get(idOrName) ?? idOrName
    return workers.get(sid)
  }

  const groupOf = (w: Worker): GroupState | undefined => {
    if (!w.parentID || !w.group) return undefined
    let gmap = groups.get(w.parentID)
    if (!gmap) {
      gmap = new Map()
      groups.set(w.parentID, gmap)
    }
    let g = gmap.get(w.group)
    if (!g) {
      g = { members: new Set(), notified: false }
      gmap.set(w.group, g)
    }
    return g
  }

  const reactivateGroup = (w: Worker) => {
    const g = groups.get(w.parentID ?? "")?.get(w.group)
    if (g) g.notified = false
  }

  const isTerminal = (w: Worker): boolean =>
    w.status === "idle" || w.status === "error" || w.status === "interrupted"

  const checkGroup = (w: Worker) => {
    const g = groups.get(w.parentID ?? "")?.get(w.group)
    if (!g || g.notified) return
    const members = [...g.members].map((id) => workers.get(id)).filter((m): m is Worker => Boolean(m))
    if (members.length === 0) return
    if (!members.every(isTerminal)) return
    g.notified = true
    const lines = members.map(
      (m) => `- ${m.name} (${m.id}): ${m.status}${m.error ? ` — ${m.error}` : ""}`,
    )
    const text = [
      "<worker-notification>",
      "<type>group-complete</type>",
      `<group>${w.group}</group>`,
      `<summary>All ${members.length} workers in group "${w.group}" have finished.</summary>`,
      "<workers>",
      ...lines,
      "</workers>",
      `<retrieval>Use worker_read with each worker's name to inspect its result.</retrieval>`,
      "</worker-notification>",
    ].join("\n")
    void pushToParent(w.parentID!, w.parentState, text, true)
    void notify(`group "${w.group}" complete (${members.length} workers)`, "success")
  }

  const notifyParentError = (w: Worker) => {
    if (!w.parentID) return
    const text = [
      "<worker-notification>",
      "<type>worker-error</type>",
      `<worker>${w.name}</worker>`,
      `<failures>${w.failures}</failures>`,
      `<error>${trunc(w.error, 400)}</error>`,
      "<hint>The worker session is still alive with full context. Inspect it with worker_read, resume or redirect it with worker_send, or close it with worker_shutdown.</hint>",
      "</worker-notification>",
    ].join("\n")
    void pushToParent(w.parentID, w.parentState, text, false)
  }

  const markError = async (id: string, error: unknown) => {
    const w = workers.get(id)
    if (!w) return
    if (abortName(error)) {
      w.status = "interrupted"
      w.error = undefined
      w.updatedAt = Date.now()
      checkGroup(w)
      return
    }
    w.failures += 1
    w.status = "error"
    w.error = errMsg(error)
    w.updatedAt = Date.now()
    notifyParentError(w)
    checkGroup(w)
    await notify(`worker "${w.name}" error #${w.failures}: ${w.error}`, "error")
  }

  // ── OpenCode backend helpers ──────────────────────────────────────────

  const sendOpenCode = (w: Worker, text: string) => {
    const [providerID, modelID] = (w.model ?? "").split("/")
    w.turns += 1
    w.updatedAt = Date.now()
    if (w.status !== "busy" && w.status !== "retry") w.status = "busy"
    w.error = undefined
    w.retry = undefined
    reactivateGroup(w)
    return client.session
      .promptAsync({
        path: { id: w.id },
        body: {
          agent: w.agent,
          ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
          ...(w.variant ? { variant: w.variant } : {}),
          parts: [{ type: "text", text }],
        },
      })
      .catch((e) => markError(w.id, e))
  }

  // ── Agy backend helpers ───────────────────────────────────────────────

  const cleanupAgyProcess = (w: Worker) => {
    const proc = w.agyProcess
    if (proc && !proc.killed) {
      proc.kill("SIGTERM")
    }
    if (w.agyReadline) {
      w.agyReadline.close()
      w.agyReadline = undefined
    }
    w.agyProcess = undefined
  }

  const writeAgyStdin = (w: Worker, text: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = w.agyProcess
      if (!proc || !proc.stdin) {
        reject(new Error("agy process not available"))
        return
      }
      const line = JSON.stringify({ event: "user", message: { content: text } }) + "\n"
      const canContinue = proc.stdin.write(line)
      if (canContinue) {
        resolve()
      } else {
        proc.stdin.once("drain", () => resolve())
      }
    })
  }

  const sendAgyPrompt = async (w: Worker, text: string) => {
    if (w.backend !== "agy") return
    w.turns += 1
    w.updatedAt = Date.now()
    w.status = "busy"
    w.error = undefined
    w.retry = undefined
    reactivateGroup(w)
    // Record in transcript
    if (!w.agyTranscript) w.agyTranscript = []
    w.agyTranscript.push({ role: "user", text })
    try {
      await writeAgyStdin(w, text)
    } catch (e) {
      void markError(w.id, e)
    }
  }

  const agyFlushQueue = (w: Worker) => {
    if (!w.agyQueue || w.agyQueue.length === 0) return
    const next = w.agyQueue.shift()!
    void sendAgyPrompt(w, next)
  }

  const handleAgyResult = (w: Worker, result: Record<string, unknown>) => {
    const status = String(result.status ?? "")
    const responseText = String(result.response ?? "")
    const usage = result.usage as Record<string, unknown> | undefined
    const convID = String(result.conversation_id ?? "")

    if (convID) w.agyConversationID = convID
    if (usage) w.agyUsage = usage

    // Record result in transcript
    if (w.agyTranscript) {
      w.agyTranscript.push({
        role: "assistant",
        text: trunc(responseText, 500),
        detail: responseText.length > 500 ? `full response ${responseText.length} chars` : undefined,
      })
      if (usage) {
        w.agyTranscript.push({
          role: "system",
          text: `usage: ${trunc(JSON.stringify(usage), 200)}`,
        })
      }
    }

    w.updatedAt = Date.now()

    if (status === "SUCCESS") {
      w.status = "idle"
      w.retry = undefined
      // Check queue before checking group
      agyFlushQueue(w)
      if (w.status === "idle") {
        checkGroup(w)
      }
    } else {
      // ERROR, CANCELED, or unknown
      void markError(w.id, `agy result status: ${status}${responseText ? ` — ${trunc(responseText, 200)}` : ""}`)
    }
  }

  const handleAgyStep = (w: Worker, step: Record<string, unknown>) => {
    // Official agy NDJSON: step_update.text_delta (agent_response) / step_update.tool_info (tool)
    // Legacy mock flat shape: step.agent_response.text_delta / step.tool.tool_info
    const textDelta = String(step.text_delta ?? (step.agent_response as Record<string, unknown> | undefined)?.text_delta ?? "")
    const toolInfo = (step.tool_info ?? (step.tool as Record<string, unknown> | undefined)?.tool_info) as Record<string, unknown> | undefined

    if (textDelta) {
      if (w.agyTranscript) {
        const last = w.agyTranscript[w.agyTranscript.length - 1]
        if (last?.role === "assistant") {
          const combined = last.text + textDelta
          last.text = combined.length > 500 ? combined.slice(0, 497) + "…" : combined
        } else {
          w.agyTranscript.push({ role: "assistant", text: trunc(textDelta, 500) })
        }
      }
    }

    if (toolInfo) {
      const info = trunc(JSON.stringify(toolInfo), 200)
      if (w.agyTranscript) {
        w.agyTranscript.push({ role: "tool", text: info })
      }
    }
  }

  const spawnAgyWorker = (w: Worker, modelSlug: string, agent: string | undefined, cwd: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--mode", "accept-edits",
        "--model", modelSlug,
        "--dangerously-skip-permissions", // workers run non-interactively; auto-approve tool permission requests
      ]
      // Map agent to agy flags
      const agentArgs = mapAgentToAgyArgs(agent)
      args.push(...agentArgs)
      // Map variant to agy --effort
      args.push(...variantToEffortArgs(w.variant))

      let proc: ChildProcess
      try {
        proc = spawn(AGY_BINARY, args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd,
          shell: false,
        })
      } catch (e) {
        reject(new Error(`failed to spawn agy: ${errMsg(e)}`))
        return
      }

      w.agyProcess = proc
      w.agyProcessExited = false
      if (!w.agyTranscript) w.agyTranscript = []
      if (!w.agyQueue) w.agyQueue = []

      // Stderr: capture for diagnostics
      let stderrBuf = ""
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8")
        stderrBuf += text
        // Only keep last ~4KB to avoid leaking secrets
        if (stderrBuf.length > 4096) {
          stderrBuf = stderrBuf.slice(-4096)
        }
      })

      // Stdout: NDJSON line-by-line
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
      w.agyReadline = rl

      let initReceived = false
      let resultReceived = false
      let settled = false
      const settleOnce = (ok: boolean, value?: unknown) => {
        if (settled) return
        settled = true
        if (ok) resolve()
        else reject(value)
      }

      rl.on("line", (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          settleOnce(false, new Error(`agy NDJSON parse error on first message: ${trunc(trimmed, 200)}`))
          void markError(w.id, `agy NDJSON parse error on line: ${trunc(trimmed, 200)}`)
          return
        }

        const event = String(parsed.event ?? "")

        if (event === "init" && !initReceived) {
          initReceived = true
          const convID = String(parsed.conversation_id ?? "")
          if (convID) w.agyConversationID = convID
          settleOnce(true)
        } else if (event === "step_update") {
          // Official agy: step_update is nested under parsed.step_update
          // Fall back to flat parsed for backward compat with legacy mock
          const step = (parsed.step_update ?? parsed) as Record<string, unknown>
          handleAgyStep(w, step)
        } else if (event === "result") {
          const result = parsed.result as Record<string, unknown> | undefined
          if (result) {
            resultReceived = true
            handleAgyResult(w, result)
          }
        }
      })

      rl.on("error", (e: Error) => {
        settleOnce(false, new Error(`agy readline error: ${errMsg(e)}`))
        logWarn(`agy readline error for ${w.name}: ${errMsg(e)}`)
      })

      proc.on("close", (code: number | null, signal: string | null) => {
        w.agyProcessExited = true
        // If the process closed before init, reject the promise
        if (!initReceived) {
          const diag = stderrBuf ? ` stderr: ${trunc(stderrBuf, 200)}` : ""
          const reason = signal
            ? `agy process killed by ${signal}${diag}`
            : `agy process exited with code ${code ?? "null"}${diag}`
          settleOnce(false, new Error(reason))
        }
        // If the readline was already cleaned up (interrupt), don't act
        if (w.agyReadline !== rl) return
        rl.close()
        if (w.status === "interrupted") return
        if (code !== 0 && code !== null) {
          const diag = stderrBuf ? ` stderr: ${trunc(stderrBuf, 200)}` : ""
          void markError(w.id, `agy process exited with code ${code}${diag}`)
        } else if (signal && signal !== "SIGTERM") {
          const diag = stderrBuf ? ` stderr: ${trunc(stderrBuf, 200)}` : ""
          void markError(w.id, `agy process killed by ${signal}${diag}`)
        } else if (initReceived && !resultReceived) {
          // Zombie: init came through but process exited without completing any turn
          const diag = stderrBuf ? ` stderr: ${trunc(stderrBuf, 200)}` : ""
          void markError(w.id, `agy process exited without completing a turn${diag}`)
        }
        w.agyProcess = undefined
        w.agyReadline = undefined
      })

      proc.on("error", (e: Error) => {
        settleOnce(false, new Error(`agy spawn error: ${errMsg(e)}`))
        void markError(w.id, `agy process error: ${errMsg(e)}`)
      })
    })
  }

  const uniqueName = (raw: string): string => {
    const base = slugify(raw)
    if (!byName.has(base)) return base
    let n = 2
    while (byName.has(`${base}-${n}`)) n += 1
    return `${base}-${n}`
  }

  // ── Non-agy worker id ────────────────────────────────────────────────
  // Counter-based id for agy workers (no OpenCode session)
  let agyIdCounter = 0

  return {
    dispose: async () => {
      // Kill all agy processes
      for (const w of workers.values()) {
        if (w.backend === "agy") {
          cleanupAgyProcess(w)
        }
      }
      // Clear all timers
      for (const t of timers.values()) {
        clearTimeout(t.timer)
      }
      workers.clear()
      byName.clear()
      groups.clear()
      pendingNotifications.clear()
      timers.clear()
    },

    config: async (cfg) => {
      cfg.agent = cfg.agent ?? {}
      for (const k of Object.keys(cfg.agent)) knownAgents.add(k)

      // Auto-register a base `worker` agent when the user hasn't defined one.
      // Derived from `build` when present (inherits its settings), otherwise minimal.
      if (!cfg.agent[DEFAULT_AGENT]) {
        const fallback = cfg.agent[PRIMARY_BASE]
        const description =
          "General-purpose worker subagent for mechanical task execution (auto-registered by opencode-worker-plugin)."
        cfg.agent[DEFAULT_AGENT] = fallback
          ? { ...fallback, mode: "subagent", description }
          : { mode: "subagent", description }
        knownAgents.add(DEFAULT_AGENT)
      }
    },

    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      output.system.push(WORKER_RULES)
    },

    "chat.message": async (
      input: { sessionID?: string },
      output: { parts?: Array<{ type: string; text?: string }> },
    ) => {
      if (!input.sessionID) return
      injectPending(input.sessionID, output)
    },

    event: async ({ event }) => {
      try {
        const p: Record<string, unknown> = (event as Record<string, unknown>).properties as Record<string, unknown>
        if (event.type === "session.status" && p?.sessionID) {
          const w = workers.get(p.sessionID as string)
          if (!w) return
          const st = (p.status as Record<string, unknown>)?.type
          if (st === "retry") {
            w.status = "retry"
            w.retry = { attempt: (p.status as Record<string, unknown>).attempt as number, message: trunc((p.status as Record<string, unknown>).message as string, 200) }
          } else if (st === "busy") {
            w.status = "busy"
            w.error = undefined
          } else if (st === "idle") {
            w.status = "idle"
            w.retry = undefined
            checkGroup(w)
          }
          w.updatedAt = Date.now()
        }
        if (event.type === "session.idle" && p?.sessionID) {
          const w = workers.get(p.sessionID as string)
          if (w && w.status !== "idle") {
            w.status = "idle"
            w.retry = undefined
            w.updatedAt = Date.now()
            checkGroup(w)
          }
        }
        if (event.type === "session.error" && p?.sessionID) {
          await markError(p.sessionID as string, p.error)
        }
      } catch { /* ignore */ }
    },

    tool: {
      worker_spawn: tool({
        description:
          `Spawn a writable worker subagent and give it an initial instruction. NON-BLOCKING: returns immediately with the worker's semantic name.\n` +
          `'title' is a short unique name you choose yourself (semantic, e.g. 'auth-refactor'); it is the id you use in all other worker tools.\n` +
          `'group' is a required feedback group id: when ALL workers of a group reach a finished state, the parent agent is woken once with a list of which workers completed — use groups for batches that should only notify when the whole batch is done.\n` +
          `'model' determines the backend:\n` +
          `  - Format 'provider/model-id' (e.g. 'epicrouter/deepseek-v4-flash') → OpenCode internal sub-session (default).\n` +
          `  - Format 'agy/<slug>' (e.g. 'agy/gemini-3.8-flash-high') → external agy CLI process.\n` +
          `Use worker_read to inspect the conversation, worker_send to queue more instructions, worker_interrupt to stop the current turn, worker_shutdown to close it.\n` +
          `The required 'variant' parameter (low/medium/high/xhigh/max) controls the reasoning effort for every prompt of this worker (OpenCode backend: passed per-prompt; agy backend: mapped to --effort, xhigh/max clamped to high). 'agent' selects a worker agent (default "worker"; custom names must exist in your config).`,
        args: {
          prompt: tool.schema.string().describe("Initial instruction for the worker"),
          title: tool.schema
            .string()
            .describe(
              `Short unique semantic name for this worker, chosen by you (e.g. 'auth-refactor'). Used as its id in worker_read/send/interrupt/shutdown. Keep it independent from other live workers; duplicates get a numeric suffix.`,
            ),
          group: tool.schema
            .string()
            .describe(
              "Feedback group id (required). All workers with the same group must finish before the parent is woken once with the completion list.",
            ),
          model: tool.schema.string().describe(
            "Model reference.\n" +
            "  - OpenCode: format 'provider/model-id' (e.g. 'epicrouter/deepseek-v4-flash').\n" +
            "  - Agy external: format 'agy/<slug>' (e.g. 'agy/gemini-3.8-flash-high'). Required.",
          ),
          agent: tool.schema.string().optional().describe(`Worker agent name, default "${DEFAULT_AGENT}". Custom names must exist in your opencode config.`),
          variant: tool.schema.string().describe("Required reasoning variant: low | medium | high | xhigh | max. Applied to every prompt of this worker. For agy workers xhigh/max are clamped to high."),
        },
        async execute(args, ctx) {
          if (!args.title || !args.title.trim()) return "failed: 'title' (semantic worker name) is required"
          if (!args.group || !args.group.trim()) return "failed: 'group' (feedback group id) is required"
          if (!args.model || !args.model.trim()) return "failed: 'model' is required"
          if (!args.variant || !VARIANTS.includes(args.variant as any)) return "failed: 'variant' is required and must be one of: low, medium, high, xhigh, max"
          const agent = args.agent ?? DEFAULT_AGENT

          // Detect backend from model prefix
          const isAgy = args.model.startsWith(AGY_PREFIX)
          const bareModel = isAgy ? args.model.slice(AGY_PREFIX.length) : args.model

          if (isAgy && !bareModel) {
            return `failed: model "${args.model}" has empty slug after "${AGY_PREFIX}" prefix`
          }

          const parentState = await captureParentState(ctx.sessionID, ctx.messageID, ctx.agent)
          if (!parentState) return "failed to capture the parent session's model, agent, and reasoning variant"

          const name = uniqueName(args.title)
          const title = args.title.trim()

          if (isAgy) {
            // ── Agy external worker ──────────────────────────────────
            const id = `agy-${++agyIdCounter}`
            const w: Worker = {
              id,
              name,
              group: args.group.trim(),
              title,
              agent,
              model: args.model,
              variant: args.variant,
              backend: "agy",
              parentID: ctx.sessionID,
              parentState,
              status: "starting",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              turns: 0,
              failures: 0,
              agyTranscript: [],
              agyQueue: [],
            }
            workers.set(id, w)
            byName.set(name, id)

            const g = groupOf(w)
            if (!g) {
              workers.delete(id)
              byName.delete(name)
              return "failed to register feedback group for worker"
            }
            g.members.add(id)

            try {
              w.agyCwd = ctx.directory
              await spawnAgyWorker(w, bareModel, agent, ctx.directory)
            } catch (e) {
              // Spawn failed
              g.members.delete(id)
              workers.delete(id)
              byName.delete(name)
              return `failed to start agy worker: ${errMsg(e)}`
            }

            // Send initial prompt
            await sendAgyPrompt(w, args.prompt)
            if (w.status === "error") {
              return `agy worker ${name} (${id}) failed to start: ${w.error}. Inspect with worker_read or retry with worker_send.`
            }
            return `external agy worker started: ${name} (id: ${id}, model=${args.model}, agent=${agent}, variant=${args.variant}, group=${w.group}).`
          }

          // ── OpenCode internal worker (existing path) ────────────────
          const s = await client.session.create({
            body: { title: `${name} [group: ${args.group.trim()}]`, parentID: ctx.sessionID },
          })
          const id = s.data?.id
          if (!id) return "failed to create worker session"
          const w: Worker = {
            id,
            name,
            group: args.group.trim(),
            title,
            agent,
            model: args.model,
            variant: args.variant,
            backend: "opencode",
            parentID: ctx.sessionID,
            parentState,
            status: "starting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            turns: 0,
            failures: 0,
          }
          workers.set(id, w)
          byName.set(name, id)
          const g = groupOf(w)
          if (!g) {
            workers.delete(id)
            byName.delete(name)
            return "failed to register feedback group for worker"
          }
          g.members.add(id)
          await sendOpenCode(w, args.prompt)
          if (w.status === "error") {
            return `worker ${name} (${id}) failed to start: ${w.error}. Inspect with worker_read or retry with worker_send.`
          }
          const warn =
            knownAgents.size > 0 && !knownAgents.has(agent)
              ? ` WARNING: agent "${agent}" is not in config, the server may reject it (check worker_list for status).`
              : ""
          return `worker started: ${name} (session: ${id}, agent=${agent}, model=${args.model}, variant=${args.variant}, group=${w.group}).${warn}`
        },
      }),

      worker_read: tool({
        description:
          `Read a worker's recent conversation: its text output, every tool call with status/input/output/errors, and message-level errors.\n` +
          `Use tail to control how many messages to see (last N).\n` +
          `For agy workers (model starting with "agy/"), returns the in-memory transcript instead of OpenCode session messages.`,
        args: {
          id: tool.schema.string().describe("Worker name (from worker_spawn) or worker id"),
          tail: tool.schema.number().optional().describe(`Last N messages, default ${DEFAULT_TAIL}`),
          limit: tool.schema.number().optional().describe(`Max chars per part, default ${PART_LIMIT}`),
        },
        async execute(args) {
          const w = resolveWorker(args.id)
          if (!w) {
            return { title: `worker ${args.id}`, output: JSON.stringify({ name: args.id, status: "untracked", error: "unknown worker" }, null, 2) }
          }

          if (w.backend === "agy") {
            // Agy path: use stored transcript (no client.session.messages)
            const transcript = w.agyTranscript ?? []
            const tail = transcript.slice(-(args.tail ?? DEFAULT_TAIL))
            const limit = args.limit ?? PART_LIMIT
            const messages = tail.map((e) => {
              let text = trunc(e.text, limit)
              if (e.detail) text += ` (${e.detail})`
              return { role: e.role, text }
            })
            return {
              title: `worker ${w.name}`,
              output: JSON.stringify(
                {
                  name: w.name,
                  id: w.id,
                  status: w.status,
                  backend: w.backend,
                  group: w.group,
                  agent: w.agent,
                  model: w.model,
                  variant: w.variant ?? null,
                  retry: w.retry,
                  error: w.error,
                  turns: w.turns,
                  conversationID: w.agyConversationID,
                  usage: w.agyUsage ?? null,
                  totalMessages: transcript.length,
                  messages,
                },
                null,
                2,
              ),
            }
          }

          // OpenCode path: use client.session.messages
          const target = w.id
          const r = await client.session.messages({ path: { id: target } })
          const msgs: any[] = r.data ?? []
          const tail = msgs.slice(-(args.tail ?? DEFAULT_TAIL))
          const out: { role: string; text: string }[] = []
          for (const m of tail) {
            const parts: string[] = []
            for (const p of m.parts ?? []) {
              if (p.type === "text" && p.text?.trim()) {
                parts.push(trunc(p.text, args.limit))
              } else if (p.type === "tool") {
                const st = p.state ?? {}
                if (st.status === "completed") parts.push(`[tool ${p.tool}] ok → ${trunc(st.output, args.limit)}`)
                else if (st.status === "error") parts.push(`[tool ${p.tool}] ERROR: ${trunc(st.error, args.limit)}`)
                else if (st.status === "running")
                  parts.push(`[tool ${p.tool}] running ${trunc(st.title ?? st.input, 120)}`)
                else parts.push(`[tool ${p.tool}] ${st.status ?? "pending"}`)
              }
            }
            if (parts.length === 0) continue
            out.push({ role: m.info?.role ?? "?", text: parts.join("\n") })
            if (m.info?.role === "assistant" && m.info.error) {
              out.push({ role: "error", text: errMsg(m.info.error) })
            }
          }
          return {
            title: `worker ${w?.name ?? args.id}`,
            output: JSON.stringify(
              {
                name: w.name,
                id: w.id,
                status: w.status,
                backend: w.backend,
                group: w.group,
                agent: w.agent,
                model: w.model,
                variant: w.variant ?? null,
                retry: w.retry,
                error: w.error,
                turns: w.turns,
                totalMessages: msgs.length,
                messages: out,
              },
              null,
              2,
            ),
          }
        },
      }),

      worker_send: tool({
        description:
          `Send a new instruction to a worker. If it is busy the message is queued and runs after the current turn; if it errored this resumes it with full context; if it was interrupted this redirects it.\n` +
          `Re-activates the worker's feedback group (a new group completion notification will fire once all members finish again).\n` +
          `For agy workers: model must start with "agy/" (e.g. "agy/gemini-3.8-flash-high") to match the worker's backend.\n` +
          `The optional 'variant' parameter (low/medium/high/xhigh/max) overrides the worker's reasoning variant for this and future turns (agy workers: only when restarting an errored/interrupted worker).`,
        args: {
          id: tool.schema.string().describe("Worker name or worker id"),
          text: tool.schema.string().describe("Instruction to send"),
          model: tool.schema.string().optional().describe(
            "Model override for this and future turns.\n" +
            "  - For OpenCode workers: format 'provider/model-id'.\n" +
            "  - For agy workers: format 'agy/<slug>'. Must match the worker's backend prefix.",
          ),
          variant: tool.schema.string().optional().describe("Optional reasoning variant override for this and future turns (low/medium/high/xhigh/max). For OpenCode workers it applies immediately to the next prompt; for agy workers it requires a process restart, so it only takes effect when resuming an errored/interrupted worker."),
        },
        async execute(args) {
          const w = resolveWorker(args.id)
          if (!w) return `unknown worker: ${args.id}`

          if (args.variant && !VARIANTS.includes(args.variant as any)) return "failed: 'variant' must be one of: low, medium, high, xhigh, max"

          // Validate model prefix compatibility
          if (args.model) {
            if (w.backend === "agy" && !args.model.startsWith(AGY_PREFIX)) {
              return `invalid model for agy worker: must start with "${AGY_PREFIX}" prefix (e.g. "${AGY_PREFIX}gemini-3.8-flash-high")`
            }
            if (w.backend === "opencode" && args.model.startsWith(AGY_PREFIX)) {
              return `invalid model for OpenCode worker: "${AGY_PREFIX}" prefix is only valid for agy workers`
            }
          }

          if (w.backend === "agy") {
            // Agy path
            const wasBusy = w.status === "busy" || w.status === "retry"
            const wasError = w.status === "error"
            const wasInterrupted = w.status === "interrupted"

            // Model override for agy: only allowed when restarting (error/interrupted)
            if (args.model && !wasError && !wasInterrupted) {
              if (args.model !== w.model) {
                return `cannot change model for running agy worker. The current process (${w.model}) is already running. Stop it first (worker_interrupt) or wait until idle, then use worker_send with a different model to restart.`
              }
              // Same model — harmless, apply
              w.model = args.model
            }

            if (wasInterrupted || wasError) {
              // Apply model override if provided
              if (args.model) w.model = args.model
              // Apply variant override if provided
              if (args.variant) w.variant = args.variant
              // Need to restart agy process
              if (!w.model) return "agy worker has no model configured"
              const bareModel = w.model.startsWith(AGY_PREFIX) ? w.model.slice(AGY_PREFIX.length) : w.model
              const cwd = w.agyCwd ?? process.cwd()

              // Clean up old process if any
              cleanupAgyProcess(w)
              w.agyTranscript = w.agyTranscript ?? []
              w.agyQueue = w.agyQueue ?? []
              w.agyProcessExited = false
              w.status = "starting"

              try {
                await spawnAgyWorker(w, bareModel, w.agent, cwd)
              } catch (e) {
                w.status = "error"
                w.error = errMsg(e)
                w.updatedAt = Date.now()
                checkGroup(w)
                return `failed to restart agy worker: ${w.error}`
              }

              // Resume conversation if agy CLI supports --conversation.
              // This flag is not re-passed on restart; the user gets a fresh conversation.
              if (w.agyConversationID) {
                void notify(`agy worker "${w.name}" restarted (fresh conversation, previous ID: ${w.agyConversationID})`, "info")
              }

              await sendAgyPrompt(w, args.text)
              return "sent; agy worker restarted from error/interrupted state"
            }

            if (wasBusy) {
              // Variant override: reject if differs (no restart possible while running)
              if (args.variant && args.variant !== w.variant) {
                return `cannot change variant for a running agy worker (current: ${w.variant}). Use worker_interrupt first, then worker_send with the new variant to restart it.`
              }
              // Queue: store for later
              if (!w.agyQueue) w.agyQueue = []
              w.agyQueue.push(args.text)
              return "queued; runs after the current turn finishes"
            }

            // Idle: send directly
            // Variant override: reject if differs (no restart possible without process restart)
            if (args.variant && args.variant !== w.variant) {
              return `cannot change variant for a running agy worker (current: ${w.variant}). Use worker_interrupt first, then worker_send with the new variant to restart it.`
            }
            await sendAgyPrompt(w, args.text)
            return "sent; agy worker is running"
          }

          // OpenCode path (existing)
          const wasBusy = w.status === "busy" || w.status === "retry"
          if (args.model) w.model = args.model
          if (args.variant) w.variant = args.variant
          await sendOpenCode(w, args.text)
          return wasBusy ? "queued; runs after the current turn finishes" : "sent; worker is running"
        },
      }),

      worker_interrupt: tool({
        description:
          `Interrupt a worker's current turn (e.g. it went off track or hangs). The worker stays alive with full context; follow up with worker_send to redirect it.\n` +
          `For agy workers, this terminates the underlying agy process (SIGTERM). The worker remains in the registry and can be restarted via worker_send.`,
        args: {
          id: tool.schema.string().describe("Worker name or worker id"),
        },
        async execute(args) {
          const w = resolveWorker(args.id)
          if (!w) return `unknown worker: ${args.id}`

          if (w.backend === "agy") {
            // Agy path: kill the child process
            if (w.agyProcess && !w.agyProcessExited) {
              cleanupAgyProcess(w)
            }
            w.status = "interrupted"
            w.error = undefined
            w.retry = undefined
            w.updatedAt = Date.now()
            checkGroup(w)
            return "interrupted; agy process terminated. Use worker_send to restart the worker."
          }

          // OpenCode path (existing)
          try {
            await client.session.abort({ path: { id: w.id } })
          } catch (e) {
            return `abort failed: ${errMsg(e)}`
          }
          w.status = "interrupted"
          w.error = undefined
          w.retry = undefined
          w.updatedAt = Date.now()
          checkGroup(w)
          return "interrupted; worker alive, use worker_send to redirect"
        },
      }),

      worker_shutdown: tool({
        description:
          `Shut down a worker: interrupt it if running and remove it from the registry (its feedback group no longer waits for it).\n` +
          `Set delete=true to also delete the session history (OpenCode workers only; agy workers have no session history to delete).\n` +
          `For agy workers, this terminates the underlying agy process and removes it from the registry.`,
        args: {
          id: tool.schema.string().describe("Worker name or worker id"),
          delete: tool.schema.boolean().optional().describe("Also delete the session itself (OpenCode workers only)"),
        },
        async execute(args) {
          const w = resolveWorker(args.id)
          if (!w) return `unknown worker: ${args.id}`

          if (w.backend === "agy") {
            cleanupAgyProcess(w)
            workers.delete(w.id)
            byName.delete(w.name)
            const g = groups.get(w.parentID ?? "")?.get(w.group)
            if (g) {
              g.members.delete(w.id)
              if (g.members.size === 0) {
                groups.get(w.parentID ?? "")?.delete(w.group)
              } else if (!g.notified) {
                const survivor = [...g.members].map((id) => workers.get(id)).find((m): m is Worker => Boolean(m))
                if (survivor) checkGroup(survivor)
              }
            }
            return `agy worker "${w.name}" closed`
          }

          // OpenCode path (existing)
          try {
            await client.session.abort({ path: { id: w.id } })
          } catch { /* ignore */ }
          workers.delete(w.id)
          byName.delete(w.name)
          const g = groups.get(w.parentID ?? "")?.get(w.group)
          if (g) {
            g.members.delete(w.id)
            if (g.members.size === 0) {
              groups.get(w.parentID ?? "")?.delete(w.group)
            } else if (!g.notified) {
              const survivor = [...g.members].map((id) => workers.get(id)).find((m): m is Worker => Boolean(m))
              if (survivor) checkGroup(survivor)
            }
          }
          if (args.delete) {
            try {
              await client.session.delete({ path: { id: w.id } })
              return `worker "${w.name}" closed and session deleted`
            } catch (e) {
              return `worker "${w.name}" closed but session delete failed: ${errMsg(e)}`
            }
          }
          return `worker "${w.name}" closed (session history kept)`
        },
      }),

      worker_list: tool({
        description:
          `List all workers spawned by this plugin with their live status: busy / idle / retry (server auto-retrying a provider error, with attempt count) / error (needs your management) / interrupted. Also lists active timers.\n` +
          `Includes backend field: "opencode" (internal sub-session) or "agy" (external agy CLI process).\n` +
          `NEVER poll this to check completion: group completion and timers wake you automatically.`,
        args: {},
        async execute() {
          const list = [...workers.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((w) => ({
              name: w.name,
              id: w.id,
              backend: w.backend,
              group: w.group,
              title: w.title,
              agent: w.agent,
              model: w.model,
              variant: w.variant ?? null,
              status: w.status,
              retry: w.retry,
              error: w.error,
              turns: w.turns,
              failures: w.failures,
              ...(w.backend === "agy" ? { conversationID: w.agyConversationID ?? null } : {}),
              updatedAt: new Date(w.updatedAt).toISOString(),
            }))
          const timerList = [...timers.values()].map((t) => ({
            id: t.id,
            firesAt: new Date(t.fireAt).toISOString(),
            message: t.message,
          }))
          return JSON.stringify({ pluginVersion: WORKER_PLUGIN_VERSION, workers: list, timers: timerList }, null, 2)
        },
      }),

      models: tool({
        description:
          "List all available models from both OpenCode and agy backends. Returns grouped entries in a format directly usable with worker_spawn.model. " +
          "OpenCode models use 'provider/model' (e.g. 'epicrouter/deepseek-v4-flash'), agy models use 'agy/<slug>' (e.g. 'agy/gemini-3.8-flash-high'). " +
          "No API calls or token consumption.",
        args: {},
        async execute(_args, ctx) {
          // 1. Fetch OpenCode models via client config API
          let opencodeModels: { model: string; provider: string; label?: string }[] = []
          try {
            const resp = await client.config.providers({ query: { directory: ctx.directory } })
            const providers = (resp.data as Record<string, unknown> | undefined)?.providers as Array<Record<string, unknown>> | undefined
            if (providers) {
              for (const p of providers) {
                const pid = String(p.id ?? "")
                const pname = String(p.name ?? pid)
                const models = p.models as Record<string, { name?: string }> | undefined
                if (models) {
                  for (const [mid, minfo] of Object.entries(models)) {
                    opencodeModels.push({
                      model: `${pid}/${mid}`,
                      provider: pname,
                      label: (minfo as Record<string, unknown>)?.name as string ?? mid,
                    })
                  }
                }
              }
            }
          } catch (e) {
            opencodeModels = [{ model: `error: ${errMsg(e)}`, provider: "", label: "" }]
          }

          // 2. Fetch agy models via local CLI
          let agyModels: { model: string; label: string }[] = []
          try {
            const agyOutput = await new Promise<string>((resolve, reject) => {
              let proc: ChildProcess
              try {
                proc = spawn(AGY_BINARY, ["models"], {
                  stdio: ["ignore", "pipe", "pipe"],
                  cwd: ctx.directory,
                  shell: false,
                })
              } catch (e) {
                reject(new Error(`failed to spawn agy: ${errMsg(e)}`))
                return
              }
              let stdout = ""
              let stderr = ""
              const timeout = setTimeout(() => {
                proc.kill("SIGTERM")
                reject(new Error(`agy models timed out after ${AGY_MODELS_TIMEOUT}ms`))
              }, AGY_MODELS_TIMEOUT)
              proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8") })
              proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8") })
              proc.on("close", (code: number | null) => {
                clearTimeout(timeout)
                if (code !== 0) {
                  const diag = stderr ? ` stderr: ${trunc(stderr, 200)}` : ""
                  reject(new Error(`agy models exited with code ${code}${diag}`))
                  return
                }
                resolve(stdout)
              })
              proc.on("error", (e: Error) => {
                clearTimeout(timeout)
                reject(new Error(`agy models error: ${errMsg(e)}`))
              })
            })
            for (const line of agyOutput.split("\n")) {
              const trimmed = line.trim()
              if (!trimmed) continue
              // Skip diagnostic lines (Fetching, status, empty headers)
              if (/fetching|available|updated|checking|error|warn/i.test(trimmed)) continue
              // agy models output: slug<TAB>Display Name
              const parts = trimmed.split("\t")
              const slug = parts[0]?.trim()
              // Only accept valid slug characters
              if (!slug || !/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(slug)) continue
              agyModels.push({ model: `agy/${slug}`, label: parts[1]?.trim() || slug })
            }
          } catch (e) {
            agyModels = [{ model: `error: ${errMsg(e)}`, label: "" }]
          }

          return JSON.stringify(
            {
              opencode: opencodeModels,
              agy: agyModels,
              note: "Pass the 'model' value directly to worker_spawn.model. OpenCode models use 'provider/model' format; agy models use 'agy/<slug>' format.",
            },
            null,
            2,
          )
        },
      }),

      set_timer: tool({
        description:
          "Set a timer: after `time` seconds, wake this session once with `message` (delivered as a synthetic system notification). Async — returns immediately with a timer id, does not block. Use it to schedule self-check-ins, poll deadlines, or periodic follow-ups while workers run.",
        args: {
          time: tool.schema
            .number()
            .describe("Delay in seconds before the main agent is woken (must be > 0)"),
          message: tool.schema.string().describe("Message delivered to the main agent when the timer fires"),
        },
        async execute(args, ctx) {
          if (!args.time || args.time <= 0) return "failed: 'time' must be a positive number of seconds"
          const parentState = await captureParentState(ctx.sessionID, ctx.messageID, ctx.agent)
          if (!parentState) return "failed to capture the session's model, agent, and reasoning variant"
          const id = `timer-${++timerSeq}`
          const fireAt = Date.now() + args.time * 1000
          const timer = setTimeout(() => {
            timers.delete(id)
            const text = [
              "<worker-notification>",
              "<type>timer</type>",
              `<timer-id>${id}</timer-id>`,
              `<message>${args.message}</message>`,
              "</worker-notification>",
            ].join("\n")
            void pushToParent(ctx.sessionID, parentState, text, true)
          }, args.time * 1000)
          timers.set(id, { id, sessionID: ctx.sessionID, parentState, message: args.message, fireAt, timer })
          return `timer ${id} set: this session will be woken in ${args.time}s with your message (async, no blocking)`
        },
      }),

      notify_parent: tool({
        description:
          "Worker subagents only: proactively wake your parent (main) agent with a message. Use it when you finished early, hit a blocker, or need a decision before continuing. The message is delivered as a synthetic system notification; the parent is woken immediately (queued if it is busy).\n" +
          "NOTE: Only works inside OpenCode workers (spawned with non-agy model). Agy external workers cannot call this tool.",
        args: {
          message: tool.schema.string().describe("Message to deliver to the parent agent"),
        },
        async execute(args, ctx) {
          const w = workers.get(ctx.sessionID)
          if (!w) {
            return "not available: notify_parent only works inside a worker spawned via worker_spawn (this session is not a tracked worker)"
          }
          if (w.backend === "agy") {
            return "not available: notify_parent is not supported for agy external workers (no OpenCode sub-session)"
          }
          if (!w.parentID) return "not available: this worker has no parent session"
          const text = [
            "<worker-notification>",
            "<type>worker-message</type>",
            `<worker>${w.name}</worker>`,
            `<group>${w.group}</group>`,
            `<message>${args.message}</message>`,
            "</worker-notification>",
          ].join("\n")
          const status = await pushToParent(w.parentID, w.parentState, text, true)
          return status === "sent"
            ? `parent woken with your message`
            : `parent is unreachable right now; message queued and will be delivered on its next turn`
        },
      }),
    },
  }
}

export default WorkerPlugin