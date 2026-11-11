import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountId, channelId, enqueue, freshState, observe, optionsOf } from "../core.mjs"
import { messageOf } from "../channels.mjs"
import { openSettings, publicSettings, readSettings, writeSettings } from "../settings.mjs"

const BASE = Date.parse("2026-11-11T01:00:00Z")
const card = (user, used, time = BASE) => ({
  provider: "codex", name: "Codex", kind: "subscription", user, alias: user.split("@")[0], plan: "plus",
  readAt: new Date(time).toISOString(), windows: [{ name: "5 hours", used, resetsAt: new Date(BASE + 5 * 3_600_000).toISOString() }, { name: "7 days", used, resetsAt: new Date(BASE + 7 * 86_400_000).toISOString() }],
})

test("global event/account selection is merged once and shared by every enabled channel", () => {
  const first = card("first@example.test", 20)
  const second = card("second@example.test", 20)
  const options = optionsOf({ accounts: [accountId(first)], events: ["exhausted"], channels: [
    { id: "first-only", type: "webhook", url: "https://example.invalid/1", accounts: [accountId(second)], events: ["low"] },
    { id: "low-only", type: "webhook", url: "https://example.invalid/2", events: [], accounts: [] },
    { id: "both", type: "webhook", url: "https://example.invalid/3" },
    { id: "disabled", type: "webhook", url: "https://example.invalid/4", off: true },
  ] })
  const state = freshState()
  observe(state, [first, second], options, BASE)
  observe(state, [card(first.user, 100, BASE + 60_000), card(second.user, 100, BASE + 60_000)], options, BASE + 60_000)
  assert.equal(state.pending.length, 3)
  const one = state.pending.find((job) => job.channelId === "first-only")
  assert.equal(one.event.events.length, 2)
  assert.ok(state.pending.every((job) => job.channelId !== "disabled"))
  for (const job of state.pending) assert.deepEqual(job.event, one.event)
  assert.ok(one.event.events.every((event) => event.accountId === accountId(first)))
  const message = messageOf(one.event, options)
  assert.ok(message.body.includes("first"))
  assert.ok(!message.body.includes("second"))
  assert.match(message.title, /1 个账号 \/ 2 项变化/)
  assert.match(message.body, /5 小时额度/)
  assert.match(message.body, /周额度/)
})

test("turning merging off keeps individual events and different polls never share a batch", () => {
  const options = optionsOf({ mergePolling: false, channels: [{ type: "webhook", url: "https://example.invalid" }] })
  const state = freshState()
  observe(state, [card("first@example.test", 20)], options, BASE)
  observe(state, [card("first@example.test", 100, BASE + 60_000)], options, BASE + 60_000)
  assert.deepEqual(state.pending.map((job) => job.event.kind), ["exhausted", "exhausted"])
  const merged = freshState()
  const enabled = { ...options, mergePolling: true }
  observe(merged, [card("first@example.test", 20)], enabled, BASE)
  observe(merged, [card("first@example.test", 100, BASE + 60_000)], enabled, BASE + 60_000)
  observe(merged, [card("first@example.test", 2, BASE + 120_000)], enabled, BASE + 120_000)
  assert.equal(merged.pending.length, 2)
  assert.deepEqual(merged.pending.map((job) => job.event.events[0].kind), ["exhausted", "recovered"])
})

test("account routing follows the underlying account when its display alias changes", () => {
  const first = card("first@example.test", 20)
  const state = freshState()
  const options = optionsOf({ accounts: [accountId(first)], channels: [{ type: "webhook", url: "https://example.invalid" }] })
  observe(state, [first], options, BASE)
  observe(state, [{ ...card(first.user, 100, BASE + 60_000), alias: "新的显示名" }], options, BASE + 60_000)
  assert.equal(state.pending.length, 1)
  const message = messageOf(state.pending[0].event, options)
  assert.ok(message.body.includes("新的显示名"))
})

test("external notices use event filters while test pushes bypass routing filters", () => {
  const options = optionsOf({ accounts: [], events: ["codex_reset_scheduled"], channels: [{ id: "selected", type: "webhook", url: "https://example.invalid" }] })
  const state = freshState()
  enqueue(state, { id: "external", kind: "codex_reset_scheduled" }, options)
  enqueue(state, { id: "completed", kind: "codex_reset_completed" }, options)
  enqueue(state, { id: "test", kind: "test" }, options)
  assert.deepEqual(state.pending.map((job) => job.event.id), ["external", "test"])
})

test("legacy channel IDs survive routing edits and replacement recipients get a fresh ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-routing-"))
  const original = { type: "meow", nickname: "mock-only" }
  const db = openSettings(directory, { channels: [original] })
  try {
    const before = publicSettings(readSettings(db))
    assert.equal(before.options.channels[0].id, channelId(original))
    before.options.events = ["recovered"]
    before.options.accounts = [accountId(card("first@example.test", 1))]
    const next = writeSettings(db, { revision: before.revision, options: before.options })
    assert.equal(next.options.channels[0].id, channelId(original))
    const replacement = publicSettings(next)
    replacement.options.channels[0].nickname = "another-recipient"
    const changed = writeSettings(db, { revision: replacement.revision, options: replacement.options })
    assert.notEqual(changed.options.channels[0].id, next.options.channels[0].id)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("all three new secrets stay redacted and an unchanged form preserves them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-new-secrets-"))
  const channels = [{ type: "pushplus", key: "private-pushplus" }, { type: "serverchan", key: "SCTprivateServerchan" }, { type: "telegram", key: "123:private-telegram", chatId: "-100123" }]
  const db = openSettings(directory, { channels })
  try {
    const view = publicSettings(readSettings(db))
    assert.ok(!JSON.stringify(view).includes("private"))
    const next = writeSettings(db, { revision: view.revision, options: view.options })
    assert.deepEqual(next.options.channels.map((channel) => channel.key), channels.map((channel) => channel.key))
    assert.deepEqual(next.options.channels.map(channelId), channels.map(channelId))
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("invalid routes, duplicate channels and invalid overview schedules leave settings unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-rules-validation-"))
  const db = openSettings(directory, { channels: [{ type: "meow", nickname: "mock-only" }] })
  try {
    const original = readSettings(db)
    for (const change of [
      { overview: { enabled: true, frequency: "daily", time: "25:00", weekdays: [1] } },
      { overview: { enabled: true, frequency: "weekly", time: "09:00", weekdays: [] } },
      { mergePolling: "yes" },
      { events: ["unknown"] },
      { accounts: [1] },
      { channels: [original.options.channels[0], original.options.channels[0]] },
    ]) {
      assert.throws(() => writeSettings(db, { revision: original.revision, options: { ...original.options, ...change } }))
      assert.deepEqual(readSettings(db), original)
    }
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("old channel filters are removed without changing existing global rules, IDs or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-global-migration-"))
  const legacy = { type: "bark", key: "mock-secret", events: ["exhausted"], accounts: ["old-local-account"] }
  const global = { events: ["recovered", "overview"], accounts: [accountId(card("first@example.test", 1))], mergePolling: false, overview: { enabled: true, frequency: "weekly", time: "10:20", weekdays: [2] } }
  const db = openSettings(directory, { ...global, channels: [legacy] })
  try {
    const originalBytes = db.prepare("SELECT options FROM settings WHERE id=1").get().options
    const before = readSettings(db)
    assert.equal(db.prepare("SELECT options FROM settings WHERE id=1").get().options, originalBytes)
    for (const [name, value] of Object.entries(global)) assert.deepEqual(before.options[name], value)
    assert.equal(before.options.channels[0].id, channelId(legacy))
    assert.equal(before.options.channels[0].events, undefined)
    assert.equal(before.options.channels[0].accounts, undefined)
    const view = publicSettings(before)
    view.options.channels[0].events = ["low"]
    view.options.channels[0].accounts = []
    const saved = writeSettings(db, { revision: view.revision, options: view.options })
    for (const [name, value] of Object.entries(global)) assert.deepEqual(saved.options[name], value)
    assert.deepEqual(saved.options.channels[0], { type: "bark", key: "mock-secret", id: channelId(legacy) })
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
