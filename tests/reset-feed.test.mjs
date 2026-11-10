import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freshState, optionsOf } from "../core.mjs"
import { observeResetFeed, readResetFeed } from "../reset-feed.mjs"
import { messageOf } from "../channels.mjs"
import { createNotifier } from "../runtime.mjs"

const NOW = Date.parse("2026-11-10T08:00:00Z")
const iso = (value) => new Date(value).toISOString()
const record = (patch = {}) => ({ signalId: "sig-one", id: "source-one", kind: "reset_scheduled", resetType: "global", confidence: 0.9, effectiveAt: iso(NOW + 86_400_000), scheduleState: "pending", schedulePrecision: "datetime", scheduleWindow: null, scope: { plans: ["all"], windows: ["weekly", "five_hour"] }, source: { url: "https://example.invalid/source" }, text: "Reset planned", ...patch })
const options = (patch = {}) => optionsOf({ channels: [{ type: "meow", nickname: "mock-only" }], codexResetUpdates: { enabled: true, ...patch } })
const result = (records) => ({ records, generatedAt: iso(NOW) })

test("first activation forwards live pending announcements but baselines historical completions", () => {
  const state = freshState()
  const completed = record({ signalId: "completed", kind: "reset_completed", effectiveAt: iso(NOW - 60_000) })
  const events = observeResetFeed(state, result([record(), completed]), options(), NOW)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, "codex_reset_scheduled")
  assert.equal(state.externalResets.pending.length, 1)
  assert.equal(observeResetFeed(state, result([record(), completed]), options(), NOW + 60_000).length, 0)
})

test("optional silent initial baseline still forwards later announcements and deduplicates across sources", () => {
  const state = freshState()
  const opts = options({ notifyCurrentPending: false })
  assert.equal(observeResetFeed(state, result([record()]), opts, NOW).length, 0)
  assert.equal(observeResetFeed(state, result([record({ id: "different-source", source: { url: "https://example.invalid/other" }, text: "Other copy", scope: { plans: ["all"], windows: ["five_hour", "weekly"] } })]), opts, NOW + 60_000).length, 0)
  assert.equal(observeResetFeed(state, result([record({ signalId: "new" })]), opts, NOW + 120_000).length, 1)
})

test("timing, confidence and scope updates forward once with a stable signal ID", () => {
  const state = freshState()
  const opts = options()
  observeResetFeed(state, result([record()]), opts, NOW)
  const changed = record({ confidence: 0.99 })
  const events = observeResetFeed(state, result([changed]), opts, NOW + 60_000)
  assert.equal(events.length, 1)
  assert.equal(events[0].updated, true)
  assert.equal(observeResetFeed(JSON.parse(JSON.stringify(state)), result([changed]), opts, NOW + 120_000).length, 0)
})

test("expired, fulfilled, unknown-time and old completions cannot become current notifications", () => {
  const state = freshState()
  observeResetFeed(state, result([]), options(), NOW)
  const records = [record({ signalId: "expired", effectiveAt: iso(NOW - 1000) }), record({ signalId: "fulfilled", scheduleState: "fulfilled" }), record({ signalId: "unknown", effectiveAt: null }), record({ signalId: "old", kind: "reset_completed", effectiveAt: iso(NOW - 49 * 3600_000) })]
  assert.equal(observeResetFeed(state, result(records), options(), NOW).length, 0)
  const events = observeResetFeed(state, result([record({ signalId: "new-completion", kind: "reset_completed", effectiveAt: iso(NOW - 60_000), confidence: null })]), options(), NOW)
  assert.equal(events[0].kind, "codex_reset_completed")
  const message = messageOf(events[0], options())
  assert.match(message.body, /以账号有效读数为准/)
  assert.ok(!message.body.includes("置信度：0%"))
})

test("date-level schedules show a range and a deadline without inventing a precise reset", () => {
  const event = observeResetFeed(freshState(), result([record({ schedulePrecision: "date", scheduleConstraint: "deadline", scheduleWindow: { startAt: iso(NOW + 86_400_000), endAt: iso(NOW + 2 * 86_400_000) } })]), options(), NOW)[0]
  const message = messageOf(event, options())
  assert.match(message.body, /预计时段/)
  assert.match(message.body, /最晚期限/)
  assert.match(message.body, /尚未确认你的账号恢复/)
})

test("feed requests are unauthenticated, bounded and respect Retry-After", async () => {
  const calls = []
  await readResetFeed(async (url, init) => {
    calls.push([url, init])
    return new Response(JSON.stringify({ ok: true, data: { items: [], hasNext: true }, meta: { generatedAt: iso(NOW) } }))
  })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(([url, init]) => url.startsWith("https://didcodexreset.com/openapi/v1/records?") && !init.headers && !init.body))
  const before = Date.now()
  await assert.rejects(readResetFeed(async () => new Response("{}", { status: 429, headers: { "retry-after": "1800" } })), (error) => error.retryAt >= before + 1800_000)
})

test("feed failures leave quota monitoring running and saved backoff survives another tick", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-feed-error-"))
  let feedCalls = 0
  let quotaCalls = 0
  const notifier = await createNotifier({ directory }, { ...options(), gatewayKey: "must-not-leave-local-gateway" }, { start: false, fetchFn: async (url) => {
    if (new URL(url).hostname === "didcodexreset.com") { feedCalls++; return new Response("{}", { status: 429, headers: { "retry-after": "1800" } }) }
    quotaCalls++
    return new Response(JSON.stringify({ object: "list", data: [] }))
  } })
  try {
    await notifier.tick()
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.lastError, "")
    assert.match(status.externalResets.lastError, /429/)
    assert.ok(Date.parse(status.externalResets.nextPollAt) - Date.now() > 1700_000)
    assert.equal(quotaCalls, 1)
    assert.equal(feedCalls, 1)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("turning off forwarding cancels queued external notices and preserves old delivery history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-feed-disable-"))
  let sends = 0
  const notifier = await createNotifier({ directory }, options(), { start: false, fetchFn: async (url) => {
    const target = new URL(url)
    if (target.hostname === "didcodexreset.com") return new Response(JSON.stringify({ ok: true, data: { items: [record({ effectiveAt: iso(Date.now() + 86_400_000) })], hasNext: false } }))
    if (target.hostname === "api.chuckfang.com") { sends++; return new Response(JSON.stringify({ status: 429 })) }
    return new Response(JSON.stringify({ object: "list", data: [] }))
  } })
  try {
    await notifier.tick()
    assert.equal(sends, 1)
    assert.equal((await notifier.status()).pendingCount, 1)
    const config = notifier.readConfig()
    config.options.codexResetUpdates.enabled = false
    notifier.saveConfig({ revision: config.revision, options: config.options })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.pendingCount, 0)
    assert.equal(status.events.find((item) => item.kind === "codex_reset_scheduled").status, "cancelled")
    assert.equal(sends, 1)
    const state = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(state.meowSent.length, 1)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})
