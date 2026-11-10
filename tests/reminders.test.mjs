import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { freshState, observe, optionsOf, windowGroup } from "../core.mjs"
import { messageOf } from "../channels.mjs"
import { createNotifier } from "../runtime.mjs"

const BASE = Date.parse("2026-11-10T08:00:00Z")
const HOUR = 3_600_000
const iso = (time) => new Date(time).toISOString()
const options = (patch = {}) => optionsOf({ lowThresholds: [50, 20, 10], channels: [{ type: "meow", nickname: "mock-only" }], ...patch })
const reading = (used, at = BASE, reset = BASE + 5 * HOUR, name = "5 hours", extra = {}) => ({
  provider: "codex", name: "Codex", kind: "subscription", user: "local-test", readAt: iso(at),
  windows: [{ name, used, resetsAt: iso(reset) }], ...extra,
})

test("three remaining thresholds fire once each, followed by exhaustion; bounces do not replay tiers", () => {
  const state = freshState()
  const opts = options()
  observe(state, [reading(10)], opts, BASE)
  const events = []
  for (const [index, used] of [50, 55, 80, 90, 100].entries()) events.push(...observe(state, [reading(used, BASE + (index + 1) * 60_000)], opts, BASE + (index + 1) * 60_000))
  assert.deepEqual(events.map((event) => [event.kind, event.threshold]), [["low", 50], ["low", 20], ["low", 10], ["exhausted", undefined]])
  observe(state, [reading(30, BASE + 6 * 60_000)], opts, BASE + 6 * 60_000)
  assert.equal(observe(state, [reading(90, BASE + 7 * 60_000)], opts, BASE + 7 * 60_000).length, 0)
})

test("one poll crossing multiple tiers merges the notice and depletion takes priority", () => {
  const opts = options()
  const state = freshState()
  observe(state, [reading(0)], opts, BASE)
  const events = observe(state, [reading(95, BASE + 60_000)], opts, BASE + 60_000)
  assert.equal(events.length, 1)
  assert.equal(events[0].threshold, 10)
  assert.deepEqual(events[0].crossedThresholds, [50, 20, 10])
  const second = freshState()
  observe(second, [reading(0)], opts, BASE)
  assert.deepEqual(observe(second, [reading(100, BASE + 60_000)], opts, BASE + 60_000).map((event) => event.kind), ["exhausted"])
})

test("new settings do not replay thresholds from old state, and preserve the old exhaustion transition", () => {
  const opts = optionsOf({ lowPercent: 90 })
  assert.deepEqual(opts.lowThresholds, [10])
  const state = freshState()
  observe(state, [reading(85)], opts, BASE)
  const entry = Object.values(state.entries)[0]
  delete entry.used
  delete entry.alertedThresholds
  assert.equal(observe(state, [reading(85, BASE + 60_000)], options(), BASE + 60_000).length, 0)
  assert.deepEqual(observe(state, [reading(100, BASE + 120_000)], options(), BASE + 120_000).map((event) => event.kind), ["exhausted"])
})

test("every-cycle recovery confirms a new period even when severity stays normal", () => {
  const state = freshState()
  const opts = options({ recoveryModes: { fiveHour: "all", weekly: "off" } })
  const reset = BASE + HOUR
  observe(state, [reading(20, BASE, reset)], opts, BASE)
  const at = reset + 60_000
  const events = observe(state, [reading(0, at, reset + 5 * HOUR)], opts, at)
  assert.deepEqual(events.map((event) => event.kind), ["recovered"])
  assert.equal(events[0].previousRemaining, 80)
  assert.equal(events[0].previousReadAt, iso(BASE))
  assert.match(messageOf(events[0], opts).body, /上次有效读数/)
  assert.equal(observe(state, [reading(0, at + 60_000, reset + 5 * HOUR)], opts, at + 60_000).length, 0)
})

test("a confirmed new period still notifies after some fresh allowance has already been consumed", () => {
  const state = freshState()
  const opts = options({ recoveryModes: { fiveHour: "all" } })
  observe(state, [reading(10, BASE, BASE + HOUR)], opts, BASE)
  const events = observe(state, [reading(20, BASE + HOUR + 60_000, BASE + 6 * HOUR)], opts, BASE + HOUR + 60_000)
  assert.deepEqual(events.map((event) => event.kind), ["recovered"])
})

test("same-band reads cannot roll back the trusted reading clock or manufacture a later recovery", () => {
  const state = freshState()
  const opts = options()
  observe(state, [reading(80, BASE + 120_000)], opts, BASE + 120_000)
  observe(state, [reading(60, BASE + 60_000)], opts, BASE + 180_000)
  const entry = Object.values(state.entries)[0]
  assert.equal(entry.readAt, BASE + 120_000)
  assert.equal(entry.used, 80)
  assert.equal(observe(state, [reading(95, BASE + 90_000)], opts, BASE + 180_000).length, 0)
  assert.equal(entry.used, 80)
})

test("each window has independent recovery choices; unused and early rescheduled windows do not claim recovery", () => {
  const opts = options({ recoveryModes: { fiveHour: "off", weekly: "all" } })
  const state = freshState()
  observe(state, [reading(100)], opts, BASE)
  assert.equal(observe(state, [reading(0, BASE + 60_000)], opts, BASE + 60_000).length, 0)
  const unused = freshState()
  const every = options({ recoveryModes: { fiveHour: "all", weekly: "all" } })
  observe(unused, [reading(0, BASE, BASE + HOUR)], every, BASE)
  assert.equal(observe(unused, [reading(0, BASE + 2 * HOUR, BASE + 6 * HOUR)], every, BASE + 2 * HOUR).length, 0)
  const early = freshState()
  observe(early, [reading(20)], every, BASE)
  assert.equal(observe(early, [reading(0, BASE + 60_000, BASE + 6 * HOUR)], every, BASE + 60_000).length, 0)
})

test("pre-reset reminder can become due on the same fresh reading and fires once per period", () => {
  const state = freshState()
  const opts = options({ resetReminders: { fiveHour: "all" } })
  const card = reading(70, BASE, BASE + 90 * 60_000)
  assert.equal(observe(state, [card], opts, BASE).length, 0)
  const events = observe(state, [card], opts, BASE + 40 * 60_000)
  assert.deepEqual(events.map((event) => event.kind), ["reset_reminder"])
  const restored = JSON.parse(JSON.stringify(state))
  assert.equal(observe(restored, [card], opts, BASE + 45 * 60_000).length, 0)
})

test("remaining-only and exhausted-only reminders honor their thresholds and describe forecasts accurately", () => {
  const opts = options({ resetReminders: { fiveHour: "remaining" } })
  assert.equal(observe(freshState(), [reading(90, BASE, BASE + 30 * 60_000)], opts, BASE).length, 0)
  assert.equal(observe(freshState(), [reading(89, BASE, BASE + 30 * 60_000)], opts, BASE)[0].kind, "reset_reminder")
  const recovery = options({ resetReminders: { fiveHour: "exhausted" } })
  assert.equal(observe(freshState(), [reading(30, BASE, BASE + 30 * 60_000)], recovery, BASE).length, 0)
  const event = observe(freshState(), [reading(100, BASE, BASE + 30 * 60_000)], recovery, BASE)[0]
  assert.match(messageOf(event, recovery).title, /预计即将恢复/)
  assert.ok(!messageOf(event, recovery).body.includes("按额度接口的预计时间提醒"))
  assert.match(messageOf(event, recovery).body, /🔄 预计重置/)
})

test("weekly lead time is separate; invalid, deferred, expired and unknown-window readings cannot forecast", () => {
  const opts = options({ resetReminders: { fiveHour: "all", weekly: "all" } })
  assert.equal(observe(freshState(), [reading(10, BASE, BASE + 20 * HOUR, "Weekly")], opts, BASE)[0].kind, "reset_reminder")
  for (const card of [reading(10, BASE - 2 * HOUR, BASE + 30 * 60_000), reading(10, BASE, BASE - 60_000), reading(10, BASE, BASE + 30 * 60_000, "Daily"), reading(10, BASE, BASE + 30 * 60_000, "5 hours", { readDeferred: true }), reading(10, BASE, BASE + 30 * 60_000, "5 hours", { readAt: null })]) {
    assert.equal(observe(freshState(), [card], opts, BASE).length, 0)
  }
  assert.equal(windowGroup({ name: "5-hour" }), "fiveHour")
  assert.equal(windowGroup({ name: "7 天" }), "weekly")
  assert.equal(windowGroup({ name: "Some custom pool" }), "other")
})

test("fresh periods rearm thresholds and reminders without clearing earlier pending notifications", () => {
  const opts = options({ resetReminders: { fiveHour: "all" } })
  const state = freshState()
  const reset = BASE + HOUR
  observe(state, [reading(10, BASE, reset)], opts, BASE)
  observe(state, [reading(90, BASE + 60_000, reset)], opts, BASE + 60_000)
  const before = state.pending.length
  observe(state, [reading(0, reset + 60_000, reset + 5 * HOUR)], opts, reset + 60_000)
  const events = observe(state, [reading(50, reset + 120_000, reset + 5 * HOUR)], opts, reset + 120_000)
  assert.equal(events[0].threshold, 50)
  assert.ok(state.pending.length > before)
})

test("disabling a pre-reset rule cancels an unsent retry immediately without erasing its receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-reminder-disable-"))
  let sends = 0
  const notifier = await createNotifier({ directory }, options({ resetReminders: { fiveHour: "exhausted" } }), { start: false, fetchFn: async (url) => {
    const target = new URL(url)
    if (target.hostname === "127.0.0.1") return new Response(JSON.stringify({ object: "list", data: [reading(100, Date.now(), Date.now() + 30 * 60_000)] }))
    if (target.hostname === "api.chuckfang.com") { sends++; return new Response(JSON.stringify({ status: 429 })) }
    throw new Error("Unexpected offline-test request")
  } })
  try {
    await notifier.tick()
    assert.equal(sends, 1)
    assert.equal((await notifier.status()).pendingCount, 1)
    const config = notifier.readConfig()
    config.options.resetReminders.fiveHour = "off"
    notifier.saveConfig({ revision: config.revision, options: config.options })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.pendingCount, 0)
    assert.equal(status.events.find((event) => event.kind === "reset_reminder").status, "cancelled")
    assert.equal(sends, 1)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})
