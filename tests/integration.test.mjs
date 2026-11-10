import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNotifier } from "../runtime.mjs"

test("plugin lifecycle: idle timer, baseline, exhaustion, recovery, persistence, restart dedupe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-notify-test-"))
  const oldFetch = globalThis.fetch
  const oldSetTimeout = globalThis.setTimeout
  const oldSetInterval = globalThis.setInterval
  const oldNow = Date.now
  const oldLog = console.error
  const timers = []
  const calls = []
  let now = Date.parse("2026-11-10T08:00:00Z")
  let used = 60
  let notifier
  const reading = () => ({ object: "list", data: ["user@example.com", "another@example.com"].map((user) => ({
    provider: "codex", name: "Codex", kind: "subscription", user,
    readAt: new Date(now).toISOString(),
    windows: [{ name: "5 hours", used, resetsAt: "2026-11-12T12:00:00Z" }],
  })) })

  try {
    Date.now = () => now
    console.error = () => {}
    globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return 1 }
    globalThis.setInterval = (fn, delay) => { timers.push({ fn, delay }); return 1 }
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body ? JSON.parse(init.body) : null])
      if (String(url).includes("chuckfang.com")) return new Response(JSON.stringify({ status: 200, data: true }))
      return new Response(JSON.stringify(reading()))
    }

    const options = { pollSeconds: 60, channels: [{ type: "meow", nickname: "小明" }] }
    notifier = await createNotifier({ directory: dir }, options)
    assert.equal(timers[0].delay, 15_000)
    assert.equal(timers[1].delay, 10_000)
    const tick = timers[1].fn
    await tick() // baseline: no notification
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 0)

    now += 61_000
    used = 100
    await tick()
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 1)
    now += 1_000
    await tick() // MeoW free-tier one-per-3-seconds gate
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 1)
    now += 4_000
    await tick() // second account's queued exhaustion
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 2)

    now += 61_000
    used = 2
    await tick()
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 3)

    now += 4_000
    await tick() // no new poll, send queued recovery
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 4)

    const persisted = JSON.parse(await readFile(join(dir, "quota-notify-state.json"), "utf8"))
    assert.equal(persisted.pending.length, 0)
    assert.equal(Object.values(persisted.entries).length, 2)
    assert.ok(Object.values(persisted.entries).every((entry) => entry.level === "normal"))

    // Simulate a new plugin process reading the same persisted state.
    await notifier.close()
    timers.length = 0
    notifier = await createNotifier({ directory: dir }, options)
    now += 61_000
    await timers[1].fn()
    assert.equal(calls.filter(([url]) => url.includes("chuckfang.com")).length, 4)
    assert.ok(calls.every(([url]) => !url.includes("/v1/responses") && !url.includes("/v1/chat/completions")))
  } finally {
    await notifier?.close()
    globalThis.fetch = oldFetch
    globalThis.setTimeout = oldSetTimeout
    globalThis.setInterval = oldSetInterval
    Date.now = oldNow
    console.error = oldLog
    await rm(dir, { recursive: true, force: true })
  }
})
