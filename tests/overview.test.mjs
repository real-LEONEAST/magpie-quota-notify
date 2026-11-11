import test from "node:test"
import assert from "node:assert/strict"
import { accountId, freshState, optionsOf } from "../core.mjs"
import { overviewSlot, queueOverview } from "../overview.mjs"
import { messageOf } from "../channels.mjs"

const BASE = Date.parse("2026-11-11T01:00:00Z") // Wednesday 09:00 in Shanghai.
const options = (extra = {}) => optionsOf({ channels: [{ type: "webhook", url: "https://example.invalid" }], overview: { enabled: true }, ...extra })
const card = (user, plan = "plus") => ({
  accountId: accountId({ provider: "codex", kind: "subscription", user }), provider: "codex", name: "Codex", kind: "subscription", user, plan,
  readAt: new Date(BASE).toISOString(), windows: [{ name: "5 hours", used: 50 }, { name: "7 days", used: 80 }],
})

test("daily schedule uses the configured zone and only a five-minute restart grace", () => {
  const opts = options()
  assert.equal(overviewSlot(opts, BASE - 1000), null)
  assert.ok(overviewSlot(opts, BASE))
  assert.equal(overviewSlot(opts, BASE + 4 * 60_000), overviewSlot(opts, BASE))
  assert.equal(overviewSlot(opts, BASE + 5 * 60_000), null)
  assert.equal(overviewSlot({ ...opts, timeZone: "UTC" }, BASE), null)
  assert.equal(overviewSlot(options({ overview: { enabled: false } }), BASE), null)
})

test("weekly overview runs on selected weekdays and DST fallback does not create a second slot", () => {
  assert.ok(overviewSlot(options({ overview: { enabled: true, frequency: "weekly", weekdays: [3] } }), BASE))
  assert.equal(overviewSlot(options({ overview: { enabled: true, frequency: "weekly", weekdays: [1] } }), BASE), null)
  const newYork = options({ timeZone: "America/New_York", overview: { enabled: true, time: "01:30" } })
  assert.equal(overviewSlot(newYork, Date.parse("2026-11-01T05:30:00Z")), overviewSlot(newYork, Date.parse("2026-11-01T06:30:00Z")))
})

test("saved slots prevent duplicate summaries after restart and the next day gets a new slot", () => {
  const state = { ...freshState(), quotaSnapshot: [card("first@example.test")], lastPollAt: new Date(BASE).toISOString() }
  assert.equal(queueOverview(state, options(), BASE).length, 1)
  const resumed = JSON.parse(JSON.stringify(state))
  assert.equal(queueOverview(resumed, options(), BASE + 60_000).length, 0)
  assert.equal(queueOverview(resumed, options(), BASE + 86_400_000).length, 1)
  assert.equal(resumed.pending.length, 2)
})

test("all summary recipients share global account/event selection despite legacy channel filters", () => {
  const first = card("first@example.test")
  const second = card("second@example.test", "prolite")
  const state = { ...freshState(), quotaSnapshot: [first, second] }
  const opts = options({ accounts: [second.accountId], events: ["overview"], channels: [
    { id: "selected", type: "webhook", url: "https://example.invalid/1", accounts: [first.accountId], events: ["low"] },
    { id: "no-overview", type: "webhook", url: "https://example.invalid/2", events: ["exhausted"] },
    { id: "no-accounts", type: "webhook", url: "https://example.invalid/3", accounts: [] },
  ] })
  const jobs = queueOverview(state, opts, BASE)
  assert.equal(jobs.length, 3)
  assert.equal(jobs[0].channelId, "selected")
  for (const job of jobs) assert.deepEqual(job.event, jobs[0].event)
  const message = messageOf(jobs[0].event, opts)
  assert.match(message.title, /每日额度概览 · 1 个账号/)
  assert.ok(!message.body.includes(first.user))
  assert.ok(message.body.includes(second.user))
  assert.ok(!message.body.includes("5 小时额度"))
  assert.ok(message.body.includes("周额度"))
})

test("global overview event and account exclusions apply to every recipient", () => {
  const channels = [{ type: "webhook", url: "https://example.invalid/1" }, { type: "webhook", url: "https://example.invalid/2" }]
  for (const selection of [{ events: ["exhausted"] }, { accounts: [] }]) {
    const state = { ...freshState(), quotaSnapshot: [card("first@example.test")] }
    assert.equal(queueOverview(state, options({ ...selection, channels }), BASE).length, 0)
    assert.equal(state.pending.length, 0)
  }
})

test("summaries retain stale values with timestamps and expose an actual read failure", () => {
  const stale = { ...card("first@example.test"), readAt: "2026-11-10T01:00:00Z" }
  const state = { ...freshState(), quotaSnapshot: [stale], lastError: "quota API HTTP 503" }
  const opts = options()
  const [job] = queueOverview(state, opts, BASE)
  const message = messageOf(job.event, opts)
  assert.match(message.body, /HTTP 503/)
  assert.match(message.body, /读数待刷新/)
  assert.match(message.body, /读数：/)
  assert.match(message.body, /剩余 50%/)
})
