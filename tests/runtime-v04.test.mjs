import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountId, channelId, freshState } from "../core.mjs"
import { createNotifier } from "../runtime.mjs"
import { openSettings } from "../settings.mjs"

const BASE = Date.parse("2026-11-11T01:00:00Z")
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
const save = (notifier, patch) => {
  const config = notifier.readConfig()
  return notifier.saveConfig({ revision: config.revision, options: { ...config.options, ...patch } })
}
const card = (user, used, now) => ({
  provider: "codex", name: "Codex", kind: "subscription", user, alias: user.split("@")[0], plan: "plus", readAt: new Date(now).toISOString(),
  windows: [{ name: "5 hours", used, resetsAt: new Date(BASE + 5 * 3_600_000).toISOString() }, { name: "7 days", used, resetsAt: new Date(BASE + 7 * 86_400_000).toISOString() }],
})

test("an existing legacy queue and queued UI command resume without rewriting historical receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-migrate-"))
  const channel = { type: "webhook", url: "https://notify.invalid/mock" }
  const db = openSettings(directory, { channels: [channel], readMode: "live" })
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("old-receipt", new Date().toISOString(), "old-event", "test", "delivered", "webhook", "旧记录", "保留正文", "保留回执")
  db.prepare("INSERT INTO test_requests VALUES (?, ?, ?, ?, ?, ?)").run("old-command", new Date().toISOString(), JSON.stringify([channelId(channel)]), "queued", null, "")
  db.close()
  const state = { ...freshState(), entries: { old: { level: "normal" } }, testTag: "old-tag", meowSent: [1], pending: [{ id: "old-job", channelId: channelId(channel), attempts: 0, dueAt: Date.now(), event: { id: "old-pending", kind: "test", at: new Date().toISOString() } }] }
  await writeFile(join(directory, "quota-notify-state.json"), JSON.stringify(state))
  const sent = []
  const notifier = await createNotifier({ directory }, {}, { start: false, fetchFn: async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") return response({ object: "list", data: [] })
    sent.push(JSON.parse(init.body))
    return response({ ok: true })
  } })
  try {
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(sent.length, 2)
    assert.equal(status.pendingCount, 0)
    assert.equal(status.tests[0].status, "delivered")
    const old = status.events.find((event) => event.id === "old-receipt")
    assert.equal(old.message, "保留正文")
    assert.equal(old.detail, "保留回执")
    const current = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(current.testTag, "old-tag")
    assert.deepEqual(current.meowSent, [1])
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("global filter edits apply to queued retries on every channel without changing their IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-filter-"))
  const oldNow = Date.now
  let now = BASE
  let used = 20
  let failing = true
  const sent = []
  Date.now = () => now
  const notifier = await createNotifier({ directory }, { pollSeconds: 60, readMode: "live", channels: [{ type: "webhook", url: "https://notify.invalid/first" }, { type: "webhook", url: "https://notify.invalid/second" }] }, { start: false, fetchFn: async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") return response({ object: "list", data: [card("first@example.test", used, now), card("second@example.test", used, now)] })
    sent.push(JSON.parse(init.body))
    return response({}, failing ? 503 : 200)
  } })
  try {
    await notifier.tick()
    now += 60_000
    used = 100
    await notifier.tick()
    assert.equal((await notifier.status()).pendingCount, 2)
    const current = notifier.readConfig()
    const ids = current.options.channels.map((channel) => channel.id)
    current.options.accounts = [accountId(card("first@example.test", 0, now))]
    current.options.events = ["exhausted"]
    const saved = notifier.saveConfig({ revision: current.revision, options: current.options })
    assert.deepEqual(saved.options.channels.map((channel) => channel.id), ids)
    failing = false
    now += 16_000
    await notifier.tick()
    assert.equal(sent.length, 4)
    for (const payload of sent.slice(2)) {
      assert.ok(payload.body.includes("first"))
      assert.ok(!payload.body.includes("second"))
      assert.equal(payload.event.events.length, 2)
    }
    assert.deepEqual(sent[2], sent[3])
    assert.equal((await notifier.status()).pendingCount, 0)
  } finally { await notifier.close(); Date.now = oldNow; await rm(directory, { recursive: true, force: true }) }
})

test("shared event rules also cancel legacy queued quota jobs on every channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-global-legacy-jobs-"))
  const channels = [{ type: "webhook", url: "https://notify.invalid/1" }, { type: "webhook", url: "https://notify.invalid/2" }]
  const state = freshState()
  state.pending = channels.map((channel, index) => ({ id: `legacy-${index}`, channelId: channelId(channel), attempts: 0, dueAt: Date.now(), event: { id: "legacy-event", kind: "low", at: new Date().toISOString(), account: "old-account", providerName: "Codex", window: "5 hours", used: 95 } }))
  await writeFile(join(directory, "quota-notify-state.json"), JSON.stringify(state))
  const notifier = await createNotifier({ directory }, { readMode: "live", events: ["recovered"], channels }, { start: false, fetchFn: async (url) => {
    assert.equal(new URL(url).hostname, "127.0.0.1")
    return response({ object: "list", data: [] })
  } })
  try {
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.pendingCount, 0)
    assert.equal(status.events.filter((event) => event.kind === "low" && event.status === "cancelled").length, 2)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("a daily overview is queued once across notifier restart and retains an actual receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-overview-"))
  const oldNow = Date.now
  let now = BASE
  Date.now = () => now
  const sent = []
  const fetchFn = async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") return response({ object: "list", data: [card("first@example.test", 20, now)] })
    sent.push(JSON.parse(init.body))
    return response({})
  }
  let notifier = await createNotifier({ directory }, { readMode: "live", overview: { enabled: true }, channels: [{ type: "webhook", url: "https://notify.invalid/mock" }] }, { start: false, fetchFn })
  try {
    await notifier.tick()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event.kind, "overview")
    assert.equal(sent[0].event.accounts[0].plan, "plus")
    await notifier.close()
    notifier = await createNotifier({ directory }, {}, { start: false, fetchFn })
    now += 30_000
    await notifier.tick()
    assert.equal(sent.length, 1)
    const status = await notifier.status()
    assert.equal(status.events.filter((event) => event.kind === "overview").length, 1)
    assert.equal(status.events.find((event) => event.kind === "overview").status, "delivered")
    assert.equal(status.overview.lastQueuedAt, new Date(BASE).toISOString())
  } finally { await notifier.close(); Date.now = oldNow; await rm(directory, { recursive: true, force: true }) }
})

test("an expired forecast is removed from an unsent batch while its valid quota alert still sends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-batch-expiry-"))
  const oldNow = Date.now
  let now = BASE - 60_000
  let used = 20
  const sent = []
  Date.now = () => now
  const notifier = await createNotifier({ directory }, { readMode: "live", pollSeconds: 60, channels: [{ type: "webhook", url: "https://notify.invalid/mock" }] }, { start: false, fetchFn: async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") {
      const quota = card("first@example.test", used, now)
      quota.windows = [{ ...quota.windows[0], resetsAt: new Date(BASE + 10_000).toISOString() }]
      return response({ object: "list", data: [quota] })
    }
    sent.push(JSON.parse(init.body))
    return response({}, sent.length === 1 ? 503 : 200)
  } })
  try {
    await notifier.tick()
    save(notifier, { resetReminders: { fiveHour: "all", weekly: "off" } })
    now = BASE
    used = 95
    await notifier.tick()
    assert.deepEqual(sent[0].event.events.map((event) => event.kind), ["low", "reset_reminder"])
    now += 16_000
    await notifier.tick()
    assert.deepEqual(sent[1].event.events.map((event) => event.kind), ["low"])
    assert.equal((await notifier.status()).pendingCount, 0)
  } finally { await notifier.close(); Date.now = oldNow; await rm(directory, { recursive: true, force: true }) }
})

test("disabling a scheduled overview cancels its pending retry immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-cancel-overview-"))
  const oldNow = Date.now
  Date.now = () => BASE
  const notifier = await createNotifier({ directory }, { readMode: "live", overview: { enabled: true }, channels: [{ type: "webhook", url: "https://notify.invalid/mock" }] }, { start: false, fetchFn: async (url) => new URL(url).hostname === "127.0.0.1" ? response({ object: "list", data: [] }) : response({}, 503) })
  try {
    await notifier.tick()
    assert.equal((await notifier.status()).pendingCount, 1)
    save(notifier, { overview: { enabled: false, frequency: "daily", time: "09:00", weekdays: [1] } })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.pendingCount, 0)
    assert.equal(status.events.find((event) => event.kind === "overview").status, "cancelled")
  } finally { await notifier.close(); Date.now = oldNow; await rm(directory, { recursive: true, force: true }) }
})

test("Telegram resumes unsent parts after restart and respects API retry_after", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-v04-telegram-parts-"))
  const oldNow = Date.now
  let now = BASE
  Date.now = () => now
  const sent = []
  let limited = false
  const fetchFn = async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") return response({ object: "list", data: Array.from({ length: 40 }, (_, index) => card(`person-${index}@example.test`, 20, now)) })
    const payload = JSON.parse(init.body)
    sent.push(payload.text)
    if (payload.text.startsWith("📨 2/") && !limited) {
      limited = true
      return response({ ok: false, error_code: 429, parameters: { retry_after: 45 } }, 429)
    }
    return response({ ok: true, result: { message_id: sent.length } })
  }
  let notifier = await createNotifier({ directory }, { readMode: "live", overview: { enabled: true }, channels: [{ type: "telegram", key: "123:mock", chatId: "123" }] }, { start: false, fetchFn })
  try {
    await notifier.tick()
    assert.equal(sent.length, 1)
    await notifier.close()
    notifier = await createNotifier({ directory }, {}, { start: false, fetchFn })
    now += 15_000
    await notifier.tick()
    assert.equal(sent.length, 2)
    now += 15_000
    await notifier.tick()
    assert.equal(sent.length, 2)
    for (let attempt = 0; attempt < 10 && (await notifier.status()).pendingCount; attempt++) {
      now += 15_000
      await notifier.tick()
    }
    assert.equal((await notifier.status()).pendingCount, 0)
    assert.equal(sent.filter((text) => text.startsWith("📨 1/")).length, 1)
    assert.equal(sent.filter((text) => text.startsWith("📨 2/")).length, 2)
    assert.ok(sent.every((text) => text.length <= 4096))
    assert.equal((await notifier.status()).events.find((event) => event.kind === "overview").status, "delivered")
  } finally { await notifier.close(); Date.now = oldNow; await rm(directory, { recursive: true, force: true }) }
})
