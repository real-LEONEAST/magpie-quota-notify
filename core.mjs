import { createHash, randomUUID } from "node:crypto"

const DAY = 86_400_000

const clamp = (value, fallback, min, max) =>
  Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback

export function optionsOf(input = {}) {
  const options = input && typeof input === "object" ? input : {}
  const channels = Array.isArray(options.channels) ? options.channels.filter((channel) => {
    if (!channel || channel.off) return false
    if (channel.type === "meow") return typeof channel.nickname === "string" && !!channel.nickname.trim()
    if (channel.type === "bark") return typeof channel.key === "string" && !!channel.key.trim()
    return channel.type === "webhook" && typeof channel.url === "string" && !!channel.url.trim()
  }) : []
  return {
    pollSeconds: clamp(options.pollSeconds, 300, 60, 3600),
    maxReadAgeMinutes: clamp(options.maxReadAgeMinutes, 60, 5, 1440),
    readMode: options.readMode === "refresh" ? "refresh" : "live",
    gatewayUrl: String(options.gatewayUrl || "http://127.0.0.1:3425").replace(/\/+$/, ""),
    gatewayKey: String(options.gatewayKey || ""),
    providers: Array.isArray(options.providers) ? options.providers.map(String) : [],
    lowPercent: clamp(options.lowPercent, 90, 1, 99.9),
    lowThresholds: Array.isArray(options.lowThresholds) ? [...options.lowThresholds] : [Number((100 - clamp(options.lowPercent, 90, 1, 99.9)).toFixed(1))],
    recoveryModes: { fiveHour: options.notifyRecovered === false ? "off" : "exhausted", weekly: options.notifyRecovered === false ? "off" : "exhausted", ...options.recoveryModes },
    resetReminders: { fiveHour: "off", weekly: "off", ...options.resetReminders },
    resetLeadMinutes: { fiveHour: 60, weekly: 1440, ...options.resetLeadMinutes },
    codexResetUpdates: { enabled: false, pollSeconds: 300, notifyCurrentPending: true, ...options.codexResetUpdates },
    notifyLow: options.notifyLow !== false,
    notifyExhausted: options.notifyExhausted !== false,
    notifyRecovered: options.notifyRecovered !== false,
    notifyOnStart: options.notifyOnStart === true,
    timeZone: String(options.timeZone || "Asia/Shanghai"),
    dashboardUrl: typeof options.dashboardUrl === "string" ? options.dashboardUrl : "",
    testTag: typeof options.testTag === "string" ? options.testTag.trim() : "",
    channels,
  }
}

export function channelId(channel) {
  return createHash("sha256").update(JSON.stringify(channel)).digest("hex").slice(0, 20)
}

export function freshState() {
  return { version: 1, entries: {}, pending: [], testTag: "" }
}

function timeOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : null
  if (typeof value !== "string" || !value.trim()) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function severity(used, opts) {
  if (used >= 99.999) return "exhausted"
  if (used >= 100 - Math.max(...opts.lowThresholds)) return "low"
  return "normal"
}

export function windowGroup(window) {
  const name = String(window.name || "").toLowerCase().replace(/[\s_-]/g, "")
  if (/^(5h(ours?)?|5小时|五小时|fivehours?)$/.test(name)) return "fiveHour"
  if (/^(7d(ays?)?|7天|七天|weekly|week|一周)$/.test(name)) return "weekly"
  return "other"
}

function resetReminder(events, prev, card, window, opts, now, readAt, reset) {
  const group = windowGroup(window)
  const mode = opts.resetReminders[group] || "off"
  if (mode === "off" || readAt === null || reset === null || reset <= now || prev.resetReminderSent) return
  if (reset - now > opts.resetLeadMinutes[group] * 60_000) return
  const remaining = Math.max(0, 100 - window.used)
  if (mode === "remaining" && remaining <= Math.min(...opts.lowThresholds)) return
  if (mode === "exhausted" && window.used < 99.999) return
  events.push({ ...makeEvent("reset_reminder", card, window, now), leadMinutes: opts.resetLeadMinutes[group], expiresAt: new Date(reset).toISOString() })
  prev.resetReminderSent = true
}

function makeEvent(kind, card, window, at) {
  const used = Math.min(100, Math.max(0, window.used))
  return {
    id: randomUUID(), kind, at: new Date(at).toISOString(),
    provider: card.provider,
    providerName: card.name || card.provider,
    account: card.alias || card.user || card.seat || "",
    plan: typeof card.plan === "string" ? card.plan : "",
    quotaReadAt: card.readAt || null,
    quotaWindows: notificationWindows(card, window),
    window: window.name,
    used, remaining: Math.max(0, 100 - used), resetsAt: window.resetsAt || null,
  }
}

function notificationWindows(card, triggeringWindow) {
  const plan = typeof card.plan === "string" ? card.plan.trim().toLowerCase() : ""
  const codex = card.provider === "codex"
  const groups = codex && plan === "plus" ? ["fiveHour", "weekly"] : codex && plan.startsWith("pro") ? ["weekly"] : []
  const windows = groups.length ? groups.map((group) => (card.windows || []).find((item) => windowGroup(item) === group) || { name: group === "fiveHour" ? "5 hours" : "7 days" }) : [triggeringWindow]
  // Capture only this account's notification readings. A missing window
  // stays unknown rather than becoming an invented zero or full balance.
  return windows.map((item) => ({
    name: item.name,
    used: typeof item.used === "number" && Number.isFinite(item.used) && !item.text && !item.unlimited && item.balance == null ? Math.min(100, Math.max(0, item.used)) : null,
    resetsAt: item.resetsAt || null,
  }))
}

export function enqueue(state, event, opts, at = Date.now()) {
  for (const channel of opts.channels) {
    state.pending.push({ id: randomUUID(), channelId: channelId(channel), event, attempts: 0, dueAt: at })
  }
  if (state.pending.length > 300) state.pending.splice(0, state.pending.length - 300)
}

// Each window is judged independently: a five-hour reset does not imply
// that an exhausted weekly allowance is usable again.
export function observe(state, cards, opts, now = Date.now()) {
  if (!Array.isArray(cards)) throw new Error("quota response data is not an array")
  const events = []
  const allowed = new Set(opts.providers.map((s) => s.toLowerCase()))

  for (const card of cards) {
    if (!card || !["subscription", "plan"].includes(card.kind)) continue
    if (allowed.size && !allowed.has(String(card.provider).toLowerCase())) continue
    if (card.error || card.asOf || card.readDeferred) continue

    const readAt = timeOf(card.readAt)
    if (card.readAt && readAt === null) continue
    if (readAt !== null && (now - readAt > opts.maxReadAgeMinutes * 60_000 || readAt > now + 60_000)) continue

    for (const window of card.windows || []) {
      if (!window || window.text || window.unlimited || window.balance !== undefined && window.balance !== null) continue
      if (typeof window.used !== "number" || !Number.isFinite(window.used)) continue
      const reset = timeOf(window.resetsAt)
      // Once the old period ended, its cached percentage proves nothing.
      if (reset !== null && reset < now - 60_000) continue

      const key = JSON.stringify([
        card.provider, card.kind, card.user || card.seat || card.name || "",
        window.name || "", window.pool || "",
      ])
      const level = severity(window.used, opts)
      const prev = state.entries[key]
      if (!prev) {
        const entry = { level, readAt, reset, seenAt: now, used: window.used, alertedThresholds: opts.lowThresholds.filter((threshold) => 100 - window.used <= threshold) }
        state.entries[key] = entry
        if (opts.notifyOnStart && ((level === "exhausted" && opts.notifyExhausted) ||
            (level === "low" && opts.notifyLow))) {
          events.push({ ...makeEvent(level, card, window, now), threshold: Math.min(...entry.alertedThresholds) })
        }
        resetReminder(events, entry, card, window, opts, now, readAt, reset)
        continue
      }

      prev.seenAt = now
      // Old state has no numeric reading. Infer only its old severity band,
      // retaining the existing transition without replaying added thresholds.
      const oldUsed = prev.used ?? (prev.level === "exhausted" ? 100 : prev.level === "low" ? opts.lowPercent : Math.max(0, opts.lowPercent - 0.001))
      const newPeriod = prev.reset !== null && reset !== null && reset > prev.reset + 60_000 && now >= prev.reset && (readAt === null || readAt >= prev.reset)
      const crossed = opts.lowThresholds.filter((threshold) => 100 - oldUsed > threshold && 100 - window.used <= threshold)
      const recovered = (prev.level === "exhausted" && level !== "exhausted") || (newPeriod && oldUsed > 0 && window.used < 99.999)
      // The same vendor reading cannot establish a new state, even if
      // Magpie reinterpreted an elapsed window in its local cache.
      if (readAt !== null && prev.readAt !== null && readAt <= prev.readAt) {
        if (readAt === prev.readAt && window.used === prev.used && reset === prev.reset) resetReminder(events, prev, card, window, opts, now, readAt, reset)
        continue
      }
      if (prev.level === level && !crossed.length && !newPeriod && !recovered) {
        prev.used = window.used
        prev.readAt = readAt ?? prev.readAt
        prev.reset = reset
        delete prev.candidate
        resetReminder(events, prev, card, window, opts, now, readAt, reset)
        continue
      }

      if (readAt === null || prev.readAt === null) {
        // No trustworthy reading clock: require the new level in two
        // separate polls, at least 30 seconds apart.
        const candidate = `${level}:${crossed.join(",")}:${newPeriod}`
        if (!prev.candidate || prev.candidate.signature !== candidate) {
          prev.candidate = { level, signature: candidate, at: now }
          continue
        }
        if (now - prev.candidate.at < 30_000) continue
      }

      const was = prev.level
      const previousReadAt = prev.readAt
      const wasExhausted = prev.exhaustedInPeriod || was === "exhausted"
      if (newPeriod) {
        prev.alertedThresholds = []
        prev.resetReminderSent = false
        prev.exhaustedInPeriod = false
      }
      prev.alertedThresholds ||= opts.lowThresholds.filter((threshold) => 100 - oldUsed <= threshold)
      const newlyCrossed = crossed.filter((threshold) => !prev.alertedThresholds.includes(threshold))
      prev.alertedThresholds = [...new Set([...prev.alertedThresholds, ...crossed])]
      prev.exhaustedInPeriod ||= level === "exhausted"
      prev.level = level
      prev.used = window.used
      prev.readAt = readAt
      prev.reset = reset
      delete prev.candidate
      let eventKind = null
      const recoveryMode = opts.recoveryModes[windowGroup(window)] || (opts.notifyRecovered ? "exhausted" : "off")
      if (recovered && recoveryMode !== "off" && (recoveryMode === "all" || wasExhausted)) eventKind = "recovered"
      else if (level === "exhausted" && opts.notifyExhausted) eventKind = "exhausted"
      else if (newlyCrossed.length && opts.notifyLow) eventKind = "low"
      if (eventKind) events.push({
        ...makeEvent(eventKind, card, window, now),
        ...(eventKind === "low" ? { threshold: Math.min(...newlyCrossed), crossedThresholds: newlyCrossed } : {}),
        ...(eventKind === "recovered" ? { previousRemaining: Math.max(0, 100 - oldUsed), previousReadAt: previousReadAt === null ? null : new Date(previousReadAt).toISOString() } : {}),
      })
      resetReminder(events, prev, card, window, opts, now, readAt, reset)
    }
  }

  for (const [key, value] of Object.entries(state.entries)) {
    if (now - value.seenAt > 90 * DAY) delete state.entries[key]
  }
  for (const event of events) enqueue(state, event, opts, now)
  return events
}

export function queueTest(state, opts, now = Date.now()) {
  if (!opts.testTag || opts.testTag === state.testTag) return false
  enqueue(state, { id: randomUUID(), kind: "test", at: new Date(now).toISOString() }, opts, now)
  state.testTag = opts.testTag
  return true
}
