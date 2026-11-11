import { randomUUID } from "node:crypto"
import { accountId, enqueue, notificationWindows } from "./core.mjs"

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const SCHEDULE_GRACE_MINUTES = 5

export function overviewSlot(options, now = Date.now()) {
  if (!options.overview.enabled) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now)
  const local = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  if (options.overview.frequency === "weekly" && !options.overview.weekdays.includes(WEEKDAYS[local.weekday])) return null
  const [hour, minute] = options.overview.time.split(":").map(Number)
  const late = Number(local.hour) * 60 + Number(local.minute) - hour * 60 - minute
  // A short restart can resume this slot. Older missed summaries are not
  // replayed hours later; the next scheduled date gets its own slot.
  if (late < 0 || late >= SCHEDULE_GRACE_MINUTES) return null
  return `${local.year}-${local.month}-${local.day}/${options.overview.time}/${options.timeZone}/${options.overview.frequency}`
}

export function overviewAccounts(cards, options, now = Date.now()) {
  const providers = new Set(options.providers.map((provider) => provider.toLowerCase()))
  return cards.filter((card) => ["subscription", "plan"].includes(card.kind) && (!providers.size || providers.has(String(card.provider).toLowerCase()))).map((card) => ({
    accountId: card.accountId || accountId(card), provider: card.provider,
    providerName: card.name || card.provider, account: card.user || card.seat || card.name || "",
    plan: card.plan || "", quotaReadAt: card.readAt || null,
    quotaWindows: notificationWindows(card),
    stale: !!card.stale || !Number.isFinite(Date.parse(card.readAt)) || now - Date.parse(card.readAt) > options.maxReadAgeMinutes * 60_000 || Date.parse(card.readAt) > now + 60_000,
  }))
}

export function queueOverview(state, options, now = Date.now()) {
  const slot = overviewSlot(options, now)
  if (!slot || state.overview?.slot === slot) return []
  const event = {
    id: randomUUID(), kind: "overview", at: new Date(now).toISOString(),
    frequency: options.overview.frequency, scheduledTime: options.overview.time, timeZone: options.timeZone, weekdays: options.overview.weekdays,
    slot, accounts: overviewAccounts(state.quotaSnapshot || [], options, now),
    lastPollAt: state.lastPollAt || null, error: state.lastError || "",
    expiresAt: new Date(now + 3_600_000).toISOString(),
  }
  const jobs = enqueue(state, event, options, now)
  // The existing state transaction saves the slot together with its jobs.
  // A second host sees the same slot and cannot queue a second overview.
  state.overview = { slot, queuedAt: event.at }
  return jobs
}
