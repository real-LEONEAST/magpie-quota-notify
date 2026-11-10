import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { channelId, enqueue, freshState, observe, optionsOf, queueTest, windowGroup } from "./core.mjs"
import { deliver, messageOf } from "./channels.mjs"
import { getCards } from "./quota.mjs"
import { acquireStateLock, releaseStateLock } from "./state-lock.mjs"
import { observeResetFeed, readResetFeed } from "./reset-feed.mjs"
import { addTestRequest, openSettings, problem, publicSettings, readEvents, readSettings, recordEvent, writeSettings } from "./settings.mjs"

const POLL_TICK_MS = 15_000
const PENDING_MAX_AGE = 48 * 60 * 60_000
const STATE_LOCK_FILE = "quota-notify-lock.sqlite"

async function loadState(path) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"))
    if (data.version !== 1 || !data.entries || !Array.isArray(data.pending)) throw new Error("unknown state version")
    return data
  } catch (error) {
    if (error.code === "ENOENT") return freshState()
    throw new Error("quota-notify-state.json cannot be read; keeping it unchanged", { cause: error })
  }
}

async function saveState(path, state) {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await rename(temp, path)
}

// Respect MeoW's 3s, 15/min, 60/h, 1000/day free-tier limits. The log is
// persisted so a Magpie restart does not cause an accidental burst.
function meowWait(state, now) {
  const sends = (state.meowSent || []).filter((time) => now - time < 86_400_000)
  state.meowSent = sends
  let until = now
  for (const [period, count] of [[3000, 1], [60_000, 15], [3_600_000, 60], [86_400_000, 1000]]) {
    const recent = sends.filter((time) => now - time < period)
    if (recent.length >= count) until = Math.max(until, recent[recent.length - count] + period + 200)
  }
  return Math.max(0, until - now)
}

export async function createNotifier({ directory }, rawOptions = {}, { fetchFn = fetch, start = true } = {}) {
  await mkdir(directory, { recursive: true })
  const settings = openSettings(directory, rawOptions)
  let configuration = readSettings(settings)
  let opts = optionsOf(configuration.options)
  let channels = new Map(opts.channels.map((ch) => [channelId(ch), ch]))
  let appliedAt = new Date().toISOString()
  const path = join(directory, "quota-notify-state.json")
  let state = await loadState(path)
  let busy = false
  let nextPoll = 0
  let lastWarning = 0
  let forcePoll = false
  let closed = false
  const timers = []

  function syncConfiguration() {
    const next = readSettings(settings)
    if (next.revision === configuration.revision) return false
    forcePoll ||= next.options.readMode !== configuration.options.readMode || next.options.gatewayUrl !== configuration.options.gatewayUrl
    configuration = next
    opts = optionsOf(next.options)
    channels = new Map(opts.channels.map((ch) => [channelId(ch), ch]))
    nextPoll = 0
    appliedAt = new Date().toISOString()
    return true
  }

  function note(job, status, detail = "") {
    const channel = channels.get(job.channelId)
    const message = messageOf(job.event, opts)
    recordEvent(settings, {
      id: job.id, eventId: job.event.id, kind: job.event.kind, status,
      channel: channel?.type || "", title: message.title, message: message.body, detail,
    })
    const request = settings.prepare("SELECT * FROM test_requests WHERE event_id = ?").get(job.event.id)
    if (request) {
      const events = settings.prepare("SELECT status FROM events WHERE event_id = ?").all(job.event.id)
      if (events.length === JSON.parse(request.channels).length && events.every((event) => ["delivered", "failed", "cancelled"].includes(event.status))) {
        settings.prepare("UPDATE test_requests SET status = ?, detail = ? WHERE id = ?").run(
          events.every((event) => event.status === "delivered") ? "delivered" : "failed", detail, request.id,
        )
      }
    }
  }

  async function queueCommands() {
    const requests = settings.prepare("SELECT * FROM test_requests WHERE status = 'queued' ORDER BY at LIMIT 20").all()
    state.uiTestRequests ||= {}
    let queued = false
    for (const request of requests) {
      if (!state.uiTestRequests[request.id]) {
        const selected = JSON.parse(request.channels)
        const targets = opts.channels.filter((channel) => selected.includes(channelId(channel)))
        if (targets.length !== selected.length) {
          settings.prepare("UPDATE test_requests SET status = 'failed', detail = ? WHERE id = ?").run("渠道已更改，请重新测试", request.id)
          continue
        }
        const event = { id: "ui-test-" + request.id, kind: "test", at: new Date().toISOString() }
        enqueue(state, event, { ...opts, channels: targets })
        state.uiTestRequests[request.id] = event.id
        await saveState(path, state)
        queued = true
      }
      settings.prepare("UPDATE test_requests SET status = 'enqueued', event_id = ? WHERE id = ?").run(state.uiTestRequests[request.id], request.id)
      for (const job of state.pending.filter((job) => job.event.id === state.uiTestRequests[request.id])) note(job, "queued")
    }
    return queued
  }

  async function poll() {
    const now = Date.now()
    const revision = configuration.revision
    const pollingOptions = opts
    try {
      const cards = await getCards(pollingOptions, fetchFn)
      syncConfiguration()
      if (revision !== configuration.revision) return
      const before = state.pending.length
      const changes = observe(state, cards, opts, now)
      state.quotaSnapshot = cards.map((card) => ({
        provider: card.provider, name: card.name, kind: card.kind,
        user: card.alias || card.user || card.seat || "", readAt: card.readAt,
        stale: !!(card.error || card.asOf || card.readDeferred),
        windows: (card.windows || []).map((window) => ({
          name: window.name, group: windowGroup(window), used: window.used, resetsAt: window.resetsAt,
          unlimited: window.unlimited, text: window.text, balance: window.balance,
        })),
      }))
      state.lastPollAt = new Date(now).toISOString()
      state.lastError = ""
      await saveState(path, state)
      for (const job of state.pending.slice(before)) note(job, "queued")
      for (const change of changes) console.error(`[quota-notify] ${change.kind}: ${change.provider}/${change.window}`)
      const deferred = cards.filter((card) => card.readDeferred).length
      const stale = cards.filter((card) => card.readAt && now - Date.parse(card.readAt) > opts.maxReadAgeMinutes * 60_000).length
      if ((deferred || stale) && now - lastWarning > 3_600_000) {
        lastWarning = now
        console.error(`[quota-notify] 额度卡未刷新：未读取 ${deferred} 张、读数过旧 ${stale} 张；可检查 Magpie 用量设置，或启用 readMode: refresh`)
      }
    } catch (error) {
      syncConfiguration()
      if (revision !== configuration.revision) return
      state.lastPollAt = new Date(now).toISOString()
      state.lastError = String(error?.message || error)
      await saveState(path, state)
      if (now - lastWarning > 60_000) {
        lastWarning = now
        console.error(`[quota-notify] 额度读取失败：${state.lastError}`)
      }
    }
  }

  async function pollResetUpdates() {
    if (!opts.codexResetUpdates.enabled) return
    const now = Date.now()
    if (Date.parse(state.externalResets?.nextPollAt) > now) return
    const revision = configuration.revision
    const pollingOptions = opts
    state.externalResets ||= { initialized: false, seen: {} }
    try {
      const result = await readResetFeed(fetchFn)
      syncConfiguration()
      if (revision !== configuration.revision) return
      const before = state.pending.length
      observeResetFeed(state, result, opts, now)
      state.externalResets.lastError = ""
      state.externalResets.retryAt = 0
      for (const job of state.pending.slice(before)) note(job, "queued")
    } catch (error) {
      syncConfiguration()
      if (revision !== configuration.revision) return
      state.externalResets.lastError = String(error.message || error)
      state.externalResets.retryAt = error.retryAt || 0
    }
    state.externalResets.lastPollAt = new Date(now).toISOString()
    state.externalResets.nextPollAt = new Date(Math.max(now + pollingOptions.codexResetUpdates.pollSeconds * 1000, state.externalResets.retryAt || 0)).toISOString()
    await saveState(path, state)
  }

  function obsolete(job, now) {
    if (!channels.has(job.channelId) || now - Date.parse(job.event.at) >= PENDING_MAX_AGE) return true
    if (job.event.expiresAt && Date.parse(job.event.expiresAt) <= now) return true
    if (job.event.kind === "reset_reminder") {
      const mode = opts.resetReminders[windowGroup({ name: job.event.window })] || "off"
      if (mode === "off" || mode === "remaining" && job.event.remaining <= Math.min(...opts.lowThresholds) || mode === "exhausted" && job.event.used < 99.999) return true
    }
    if (job.event.kind.startsWith("codex_reset_")) {
      if (!opts.codexResetUpdates.enabled) return true
      if (state.externalResets?.seen[job.event.signalKey] !== job.event.signalFingerprint) return true
      if (job.event.kind === "codex_reset_scheduled" && !state.externalResets?.pending?.some((record) => record.signalKey === job.event.signalKey)) return true
    }
    return false
  }

  async function flush() {
    const now = Date.now()
    const before = state.pending.length
    for (const job of state.pending) {
      if (obsolete(job, now)) note(job, "cancelled", "渠道或预告已更改、已关闭，或消息已过期")
    }
    state.pending = state.pending.filter((job) => !obsolete(job, now))
    if (state.pending.length !== before) await saveState(path, state)

    for (let sent = 0; sent < 5; sent++) {
      if (syncConfiguration() || configuration.options.enabled === false) return
      const at = Date.now()
      const job = state.pending.find((item) => item.dueAt <= at)
      if (!job) break
      if (obsolete(job, at)) {
        state.pending.splice(state.pending.indexOf(job), 1)
        await saveState(path, state)
        note(job, "cancelled", "消息已关闭、变更或过期")
        continue
      }
      const channel = channels.get(job.channelId)
      if (channel.type === "meow") {
        const wait = meowWait(state, at)
        if (wait) {
          job.dueAt = at + wait
          await saveState(path, state)
          continue
        }
        state.meowSent.push(at)
        await saveState(path, state)
      }
      const result = await deliver(channel, job.event, opts, fetchFn)
      if (result.ok || !result.retry || job.attempts >= 9) {
        state.pending.splice(state.pending.indexOf(job), 1)
        if (!result.ok) console.error(`[quota-notify] ${channel.type} 推送终止（状态 ${result.code}，${result.reason}）`)
      } else {
        job.attempts++
        job.dueAt = Date.now() + Math.min(3_600_000, 15_000 * 2 ** (job.attempts - 1))
        console.error(`[quota-notify] ${channel.type} 推送失败（状态 ${result.code}），稍后重试`)
      }
      await saveState(path, state)
      note(job, result.ok ? "delivered" : state.pending.includes(job) ? "retrying" : "failed", result.ok ? "推送服务已接收" : `状态 ${result.code}：${result.reason}`)
    }
  }

  async function tick() {
    if (busy || closed) return
    busy = true
    let lock
    try {
      syncConfiguration()
      if (configuration.options.enabled === false || !opts.channels.length) return
      lock = acquireStateLock(join(directory, STATE_LOCK_FILE))
      if (!lock) return
      // A CLI host and the web host can overlap. Never send from a stale
      // in-memory copy, and share the last poll time as well as the queue.
      state = await loadState(path)
      if (queueTest(state, opts)) await saveState(path, state)
      if (await queueCommands()) await flush()
      if (configuration.options.enabled === false) return
      const lastPoll = Date.parse(state.lastPollAt)
      nextPoll = forcePoll ? 0 : Number.isFinite(lastPoll) ? lastPoll + opts.pollSeconds * 1000 : 0
      if (Date.now() >= nextPoll) {
        forcePoll = false
        nextPoll = Date.now() + opts.pollSeconds * 1000
        await poll()
      }
      if (configuration.options.enabled === false) return
      await pollResetUpdates()
      await flush()
    } catch (error) {
      console.error(`[quota-notify] 后台任务出错：${error?.message || error}`)
    } finally {
      if (lock) releaseStateLock(lock)
      busy = false
    }
  }

  if (start) {
    timers.push(setInterval(() => tick(), POLL_TICK_MS))
    timers.push(setTimeout(() => tick(), 10_000))
  }
  console.error(`[quota-notify] 已启动；每 ${opts.pollSeconds}s 检查，模式 ${opts.readMode}，${opts.channels.length} 个渠道`)
  return {
    tick,
    readConfig() { return publicSettings(readSettings(settings)) },
    saveConfig(request) {
      const saved = writeSettings(settings, request)
      syncConfiguration()
      recordEvent(settings, { kind: "settings", status: "applied", title: "设置已应用", detail: `配置版本 ${saved.revision}` })
      if (start) timers.push(setTimeout(() => tick(), 0))
      return { ...publicSettings(saved), appliedRevision: configuration.revision, appliedAt }
    },
    requestTest(request) {
      if (!request || typeof request !== "object") throw problem("测试请求无效")
      syncConfiguration()
      if (configuration.options.enabled === false) throw problem("请先启用通知后再测试", 409)
      const ids = request.channels || [...channels.keys()]
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => !channels.has(id))) throw problem("请选择已保存并启用的通知渠道")
      const queued = addTestRequest(settings, request.id || randomUUID(), [...new Set(ids)])
      if (start) timers.push(setTimeout(() => tick(), 0))
      return queued
    },
    async status() {
      syncConfiguration()
      // Read under the same non-blocking lock. A concurrent Windows read
      // must not hold the destination open while a worker replaces it.
      const lock = acquireStateLock(join(directory, STATE_LOCK_FILE))
      let current
      try { current = lock ? await loadState(path) : structuredClone(state) }
      finally { if (lock) releaseStateLock(lock) }
      return {
        observedAt: new Date().toISOString(), enabled: configuration.options.enabled !== false,
        configured: opts.channels.length > 0, savedRevision: configuration.revision,
        appliedRevision: configuration.revision, appliedAt, busy,
        pollSeconds: opts.pollSeconds, readMode: opts.readMode,
        lastPollAt: current.lastPollAt || null, lastError: current.lastError || "",
        nextPollAt: current.lastPollAt ? new Date(Date.parse(current.lastPollAt) + opts.pollSeconds * 1000).toISOString() : null,
        pendingCount: current.pending.length, meowAttempts: (current.meowSent || []).length,
        trackedWindowCount: Object.keys(current.entries).length,
        cards: current.quotaSnapshot || [],
        externalResets: { enabled: opts.codexResetUpdates.enabled, pollSeconds: opts.codexResetUpdates.pollSeconds, lastPollAt: current.externalResets?.lastPollAt || null, nextPollAt: current.externalResets?.nextPollAt || null, lastError: current.externalResets?.lastError || "", generatedAt: current.externalResets?.generatedAt || null, pending: (current.externalResets?.pending || []).filter((record) => Date.parse(record.expiresAt) > Date.now()) },
        channels: opts.channels.map((channel) => ({ id: channelId(channel), type: channel.type, label: channel.nickname || channel.group || "Webhook" })),
        tests: settings.prepare("SELECT id, at, status, detail FROM test_requests ORDER BY at DESC LIMIT 10").all(),
        events: readEvents(settings),
      }
    },
    async close() {
      closed = true
      for (const timer of timers) { clearInterval(timer); clearTimeout(timer) }
      // An in-flight delivery is allowed to save its result before closing.
      while (busy) await new Promise((resolve) => setTimeout(resolve, 10))
      settings.close()
    },
  }
}
