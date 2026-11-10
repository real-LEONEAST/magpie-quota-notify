import test from "node:test"
import assert from "node:assert/strict"
import { freshState, observe, optionsOf, queueTest } from "../core.mjs"

const BASE = Date.parse("2026-11-10T08:00:00.000Z")
const iso = (n) => new Date(n).toISOString()
const opts = optionsOf({ channels: [{ type: "meow", nickname: "小明" }] })
const card = (five, week, readAt = BASE, more = {}) => ({
  provider: "codex", name: "ChatGPT Codex", kind: "subscription", user: "pro@example.com",
  readAt: iso(readAt),
  windows: [
    { name: "5 hours", used: five, resetsAt: iso(BASE + 10 * 3_600_000) },
    { name: "7 days", used: week, resetsAt: iso(BASE + 7 * 86_400_000) },
  ], ...more,
})

test("first read is a baseline; low, exhausted and recovered happen only on transitions", () => {
  const s = freshState()
  assert.equal(observe(s, [card(85, 15)], opts, BASE).length, 0)
  let changes = observe(s, [card(95, 15, BASE + 60_000)], opts, BASE + 60_000)
  assert.deepEqual(changes.map((x) => x.kind), ["low"])
  changes = observe(s, [card(100, 15, BASE + 120_000)], opts, BASE + 120_000)
  assert.deepEqual(changes.map((x) => x.kind), ["exhausted"])
  assert.match(changes[0].account, /pro@example.com/)
  assert.equal(observe(s, [card(100, 15, BASE + 180_000)], opts, BASE + 180_000).length, 0)
  changes = observe(s, [card(5, 15, BASE + 240_000)], opts, BASE + 240_000)
  assert.deepEqual(changes.map((x) => x.kind), ["recovered"])
  assert.equal(changes[0].remaining, 95)
  assert.equal(s.pending.length, 3)
})

test("five-hour recovery never implies weekly recovery", () => {
  const s = freshState()
  observe(s, [card(100, 100)], opts, BASE)
  const changes = observe(s, [card(0, 100, BASE + 60_000)], opts, BASE + 60_000)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, "recovered")
  assert.equal(changes[0].window, "5 hours")
})

test("unchanged readAt, errors, deferred reads and expired windows cannot fake recovery", () => {
  const s = freshState()
  observe(s, [card(100, 3)], opts, BASE)
  assert.equal(observe(s, [card(0, 3)], opts, BASE + 60_000).length, 0)
  assert.equal(observe(s, [card(0, 3, BASE + 120_000, { readDeferred: true })], opts, BASE + 120_000).length, 0)
  assert.equal(observe(s, [card(0, 3, BASE + 180_000, { error: "timeout" })], opts, BASE + 180_000).length, 0)
  assert.equal(observe(s, [card(0, 3, BASE + 240_000, { asOf: iso(BASE) })], opts, BASE + 240_000).length, 0)
  const old = card(0, 3, BASE + 300_000)
  old.windows[0].resetsAt = iso(BASE - 60_000)
  assert.equal(observe(s, [old], opts, BASE + 300_000).length, 0)
  assert.deepEqual(observe(s, [card(0, 3, BASE + 360_000)], opts, BASE + 360_000).map((x) => x.kind), ["recovered"])
})

test("missing reading timestamp requires two separated observations", () => {
  const s = freshState()
  const noTime = (used) => ({ ...card(used, 20), readAt: null })
  observe(s, [noTime(100)], opts, BASE)
  assert.equal(observe(s, [noTime(0)], opts, BASE + 60_000).length, 0)
  assert.equal(observe(s, [noTime(0)], opts, BASE + 75_000).length, 0)
  assert.deepEqual(observe(s, [noTime(0)], opts, BASE + 100_000).map((x) => x.kind), ["recovered"])
})

test("different accounts are isolated and live readings older than configured maximum are skipped", () => {
  const s = freshState()
  observe(s, [card(50, 25)], opts, BASE)
  const other = { ...card(100, 25, BASE + 60_000), user: "second@example.com" }
  assert.equal(observe(s, [other], opts, BASE + 60_000).length, 0)
  assert.equal(observe(s, [card(100, 25, BASE + 120_000)], opts, BASE + 120_000).length, 1)
  assert.equal(observe(s, [card(0, 25, BASE + 120_000)], opts, BASE + 2 * 3_600_000).length, 0)
})

test("opt-in first-state notification, channel filtering and one-time test tag", () => {
  const s = freshState()
  const o = optionsOf({ notifyOnStart: true, channels: [{ type: "meow", nickname: "A" }, { type: "bark", key: "B" }] })
  assert.deepEqual(observe(s, [card(100, 0)], o, BASE).map((x) => x.kind), ["exhausted"])
  assert.equal(s.pending.length, 2)
  assert.equal(queueTest(s, { ...o, testTag: "trial-1" }, BASE), true)
  assert.equal(queueTest(s, { ...o, testTag: "trial-1" }, BASE + 1), false)
  assert.equal(s.pending.length, 4)
  assert.equal(optionsOf({ channels: [{ type: "meow", nickname: "" }, { type: "bark", key: "" }] }).channels.length, 0)
})

test("only subscription/plan percentage windows count", () => {
  const s = freshState()
  const bad = card(100, 10)
  bad.kind = "balance"
  bad.windows.push({ name: "Text only", used: 100, text: true })
  observe(s, [bad], opts, BASE)
  assert.equal(Object.keys(s.entries).length, 0)
})
