import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { channelId, freshState } from "../core.mjs"
import { openSettings, readSettings, publicSettings, writeSettings } from "../settings.mjs"
import { createNotifier } from "../runtime.mjs"
import { startSettingsService } from "../service.mjs"

const initial = { readMode: "refresh", channels: [{ type: "meow", nickname: "mock-only", category: "Magpie额度" }] }
const makeDirectory = () => mkdtemp(join(tmpdir(), "magpie-ui-test-"))
const save = (notifier, patch) => {
  const current = notifier.readConfig()
  return notifier.saveConfig({ revision: current.revision, options: { ...current.options, ...patch } })
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function mockGateway(calls, delivery = { status: 200, data: true }) {
  return async (url, init) => {
    const target = new URL(url)
    calls.push([target.toString(), init?.method || "GET"])
    if (target.hostname === "127.0.0.1" && target.pathname === "/v1/magpie/quotas/refresh") return response({})
    if (target.hostname === "127.0.0.1" && target.pathname === "/v1/magpie/quotas") return response({ object: "list", data: [{
      provider: "codex", name: "Codex", kind: "subscription", user: "local-test", readAt: new Date().toISOString(),
      windows: [{ name: "5 hours", used: 50, resetsAt: new Date(Date.now() + 3600_000).toISOString() }],
    }] })
    if (target.hostname === "api.chuckfang.com" && target.pathname === "/mock-only") return response(delivery)
    throw new Error("Unexpected request: offline tests reject external destinations")
  }
}

test("migration retains old options, JSON state bytes, unknown fields and recipient hashes", async () => {
  const directory = await makeDirectory()
  let notifier
  try {
    const state = { ...freshState(), entries: { old: { level: "normal" } }, meowSent: [123], testTag: "old", pending: [{ id: "old-job" }] }
    const bytes = JSON.stringify(state, null, 2)
    await writeFile(join(directory, "quota-notify-state.json"), bytes)
    notifier = await createNotifier({ directory }, { ...initial, customOption: "preserved", testTag: "old" }, { start: false })
    const current = notifier.readConfig()
    const next = notifier.saveConfig({ revision: current.revision, options: current.options })
    assert.equal(next.options.customOption, "preserved")
    assert.equal(next.options.testTag, "old")
    const db = openSettings(directory)
    const stored = readSettings(db)
    db.close()
    assert.equal(channelId(stored.options.channels[0]), channelId(initial.channels[0]))
    assert.equal(await readFile(join(directory, "quota-notify-state.json"), "utf8"), bytes)
  } finally { await notifier?.close(); await rm(directory, { recursive: true, force: true }) }
})

test("secret fields are redacted and an unchanged form preserves keys, URLs, headers and channel identity", async () => {
  const directory = await makeDirectory()
  const channels = [
    { type: "bark", key: "secret-bark", server: "https://example.invalid" },
    { type: "webhook", url: "https://example.invalid/secret-hook", headers: { Authorization: "Bearer secret-token", Remove: "old" } },
  ]
  const db = openSettings(directory, { ...initial, channels, gatewayKey: "secret-gateway" })
  try {
    const view = publicSettings(readSettings(db))
    assert.ok(!JSON.stringify(view).includes("secret-"))
    const next = writeSettings(db, { revision: view.revision, options: view.options })
    assert.deepEqual(next.options.channels, channels)
    assert.equal(next.options.gatewayKey, "secret-gateway")
    assert.deepEqual(next.options.channels.map(channelId), channels.map(channelId))
    const edit = publicSettings(next)
    delete edit.options.channels[1].headers.Remove
    edit.options.channels[0].key = "changed"
    const changed = writeSettings(db, { revision: edit.revision, options: edit.options, clearGatewayKey: true })
    assert.equal(changed.options.gatewayKey, "")
    assert.equal(changed.options.channels[0].key, "changed")
    assert.deepEqual(changed.options.channels[1].headers, { Authorization: "Bearer secret-token" })
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("invalid settings and stale revisions cannot modify the saved configuration", async () => {
  const directory = await makeDirectory()
  const db = openSettings(directory, initial)
  try {
    const original = readSettings(db)
    for (const patch of [{ pollSeconds: 1 }, { enabled: "true" }, { readMode: "unknown" }, { timeZone: "unknown" }, { channels: [] }, { channels: [null] }, { channels: [{ type: "meow", nickname: "wrong/path" }] }, { gatewayUrl: "file:///etc/passwd" }, { lowThresholds: [10, 20, 50] }, { lowThresholds: [] }, { lowThresholds: [50, 50] }, { recoveryModes: { fiveHour: "wrong" } }, { resetReminders: { fiveHour: "wrong" } }, { resetLeadMinutes: { fiveHour: 0 } }, { codexResetUpdates: { enabled: true, pollSeconds: 30 } }]) {
      assert.throws(() => writeSettings(db, { revision: 1, options: { ...original.options, ...patch } }), { status: 400 })
      assert.deepEqual(readSettings(db), original)
    }
    writeSettings(db, { revision: 1, options: { ...original.options, pollSeconds: 120 } })
    assert.throws(() => writeSettings(db, { revision: 1, options: original.options }), { status: 409 })
    assert.throws(() => writeSettings(db, null), { status: 400 })
    assert.equal(readSettings(db).revision, 2)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

test("opening v0.2 settings expands new controls without rewriting old options or existing receipts", async () => {
  const directory = await makeDirectory()
  const db = openSettings(directory, { ...initial, lowPercent: 90, notifyRecovered: false })
  const raw = db.prepare("SELECT options FROM settings WHERE id = 1").get().options
  db.exec("INSERT INTO events VALUES ('old-receipt', '2026-11-10T08:00:00Z', null, 'test', 'delivered', 'meow', 'old notification', '', '')")
  db.close()
  let notifier
  try {
    notifier = await createNotifier({ directory }, { ...initial, lowThresholds: [50, 20, 10] }, { start: false })
    const view = notifier.readConfig()
    assert.equal(view.revision, 1)
    assert.deepEqual(view.options.lowThresholds, [10])
    assert.deepEqual(view.options.recoveryModes, { fiveHour: "off", weekly: "off" })
    assert.equal(view.options.codexResetUpdates.enabled, false)
    assert.equal((await notifier.status()).events[0].id, "old-receipt")
    const check = openSettings(directory)
    assert.equal(check.prepare("SELECT options FROM settings WHERE id = 1").get().options, raw)
    check.close()
  } finally { await notifier?.close(); await rm(directory, { recursive: true, force: true }) }
})

test("hot changes shorten the poll interval, pause sends and survive restart without resetting history", async () => {
  const directory = await makeDirectory()
  const calls = []
  let notifier
  try {
    notifier = await createNotifier({ directory }, initial, { start: false, fetchFn: mockGateway(calls) })
    await notifier.tick()
    const path = join(directory, "quota-notify-state.json")
    const state = JSON.parse(await readFile(path, "utf8"))
    state.lastPollAt = new Date(Date.now() - 120_000).toISOString()
    state.meowSent = [Date.now() - 20_000]
    await writeFile(path, JSON.stringify(state))
    await notifier.tick()
    assert.equal(calls.length, 2)
    save(notifier, { pollSeconds: 60, enabled: false })
    await notifier.tick()
    assert.equal(calls.length, 2)
    assert.throws(() => notifier.requestTest({ id: "paused" }), { status: 409 })
    save(notifier, { enabled: true })
    await notifier.tick()
    assert.equal(calls.length, 4)
    assert.equal((await notifier.status()).pollSeconds, 60)
    notifier.requestTest({ id: "one-test" })
    notifier.requestTest({ id: "one-test" })
    await notifier.tick()
    const sent = calls.filter(([url]) => url.includes("chuckfang"))
    assert.equal(sent.length, 1)
    assert.equal((await notifier.status()).tests[0].status, "delivered")
    await notifier.close()
    notifier = await createNotifier({ directory }, { ...initial, pollSeconds: 300 }, { start: false, fetchFn: mockGateway(calls) })
    notifier.requestTest({ id: "one-test" })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.savedRevision, 3)
    assert.equal(status.pollSeconds, 60)
    assert.equal(status.events.filter((item) => item.kind === "test").length, 1)
    assert.equal(status.pendingCount, 0)
    assert.equal(status.meowAttempts, 2)
    assert.equal(calls.filter(([url]) => url.includes("chuckfang")).length, 1)
  } finally { await notifier?.close(); await rm(directory, { recursive: true, force: true }) }
})

test("replacing a recipient cancels old queued work instead of forwarding it", async () => {
  const directory = await makeDirectory()
  const calls = []
  let notifier
  try {
    notifier = await createNotifier({ directory }, initial, { start: false, fetchFn: mockGateway(calls, { status: 429 }) })
    notifier.requestTest({ id: "replace-recipient" })
    await notifier.tick()
    assert.equal((await notifier.status()).events[0].status, "retrying")
    const config = notifier.readConfig()
    config.options.channels[0].nickname = "different"
    notifier.saveConfig({ revision: config.revision, options: config.options })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.pendingCount, 0)
    assert.equal(status.tests[0].status, "failed")
    assert.equal(status.events.find((event) => event.kind === "test").status, "cancelled")
    assert.equal(calls.filter(([url]) => url.includes("chuckfang")).length, 1)
  } finally { await notifier?.close(); await rm(directory, { recursive: true, force: true }) }
})

test("configuration saved during a quota request discards that old result", async () => {
  const directory = await makeDirectory()
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const calls = []
  const mock = mockGateway(calls)
  const notifier = await createNotifier({ directory }, { ...initial, readMode: "live" }, { start: false, fetchFn: async (...args) => {
    started()
    await new Promise((resolve) => { release = resolve })
    return mock(...args)
  } })
  try {
    const tick = notifier.tick()
    await entered
    save(notifier, { enabled: false })
    release()
    await tick
    const status = await notifier.status()
    assert.equal(status.cards.length, 0)
    assert.equal(status.lastPollAt, null)
    assert.equal(status.appliedRevision, 2)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("a terminal push failure is reported as failed rather than retrying", async () => {
  const directory = await makeDirectory()
  const notifier = await createNotifier({ directory }, initial, { start: false, fetchFn: mockGateway([], { status: 404 }) })
  try {
    notifier.requestTest({ id: "failure" })
    await notifier.tick()
    const status = await notifier.status()
    assert.equal(status.tests[0].status, "failed")
    assert.equal(status.events[0].status, "failed")
    assert.equal(status.pendingCount, 0)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("pausing during a delivery retains its receipt and prevents another send", async () => {
  const directory = await makeDirectory()
  const calls = []
  const mock = mockGateway(calls)
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const notifier = await createNotifier({ directory }, initial, { start: false, fetchFn: async (url, init) => {
    if (String(url).includes("chuckfang")) {
      started()
      await new Promise((resolve) => { release = resolve })
    }
    return mock(url, init)
  } })
  try {
    notifier.requestTest({ id: "in-flight" })
    const tick = notifier.tick()
    await entered
    save(notifier, { enabled: false })
    release()
    await tick
    const status = await notifier.status()
    assert.equal(status.tests[0].status, "delivered")
    assert.equal(status.pendingCount, 0)
    assert.equal(status.enabled, false)
    await notifier.tick()
    assert.equal(calls.filter(([url]) => url.includes("chuckfang")).length, 1)
  } finally { await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})

test("loopback API requires a page token, validates origin, hides secrets and saves without service restart", async () => {
  const directory = await makeDirectory()
  const notifier = await createNotifier({ directory }, { ...initial, gatewayKey: "private-gateway" }, { start: false, fetchFn: mockGateway([]) })
  let service
  try {
    service = await startSettingsService(notifier, { port: 0, demo: true })
    const page = await fetch(service.url, { headers: { origin: "null" } })
    assert.equal(page.headers.get("access-control-allow-origin"), null)
    const html = await page.text()
    assert.ok(!html.includes("private-gateway"))
    const token = html.match(/name="quota-token" content="([a-f0-9]+)"/)[1]
    assert.equal((await fetch(service.url + "api/status")).status, 403)
    assert.equal((await fetch(service.url + "api/status", { headers: { "x-quota-token": token, origin: "https://attacker.invalid" } })).status, 403)
    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest(service.url, { headers: { host: "attacker.invalid" } }, (result) => { result.resume(); resolve(result.statusCode) })
      request.on("error", reject)
      request.end()
    })
    assert.equal(wrongHost, 403)
    const headers = { "x-quota-token": token, origin: "null", "content-type": "application/json" }
    const configResponse = await fetch(service.url + "api/config", { headers })
    assert.equal(configResponse.headers.get("access-control-allow-origin"), "null")
    const config = await configResponse.json()
    assert.ok(!JSON.stringify(config).includes("private-gateway"))
    config.options.pollSeconds = 120
    const changed = await fetch(service.url + "api/config", { method: "POST", headers, body: JSON.stringify(config) })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).appliedRevision, 2)
    assert.equal((await (await fetch(service.url + "api/status", { headers })).json()).pollSeconds, 120)
    assert.equal((await fetch(service.url + "api/config", { method: "POST", headers, body: "null" })).status, 400)
    assert.equal((await fetch(service.url + "api/test", { method: "POST", headers, body: "null" })).status, 400)
    assert.equal((await fetch(service.url + "api/config", { method: "POST", headers, body: JSON.stringify(config) })).status, 409)
    assert.equal((await fetch(service.url + "api/config", { method: "POST", headers, body: JSON.stringify({ huge: "x".repeat(70_000) }) })).status, 413)
    assert.equal((await fetch(service.url + "settings.mjs")).status, 404)
    assert.equal((await fetch(service.url + "%2e%2e/settings.mjs")).status, 404)
    assert.equal((await fetch(service.url + "app.js")).status, 200)
    const preflight = await fetch(service.url + "api/config", { method: "OPTIONS", headers: { origin: "null", "access-control-request-headers": "x-quota-token" } })
    assert.equal(preflight.status, 204)
  } finally { await service?.close(); await notifier.close(); await rm(directory, { recursive: true, force: true }) }
})
