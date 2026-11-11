import test from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { freshState, optionsOf, queueTest } from "../core.mjs"

function startHost(directory, hold = false) {
  const child = fork(fileURLToPath(new URL("./fixtures/host-worker.mjs", import.meta.url)), [directory], {
    env: { ...process.env, HOLD_MOCK_DELIVERY: hold ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  child.messages = []
  child.on("message", (message) => child.messages.push(message))
  return child
}

function waitFor(child, type, id) {
  const matches = (message) => message.type === type && (id === undefined || message.id === id)
  const previous = child.messages.find(matches)
  if (previous) return Promise.resolve(previous)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive)
      reject(new Error(`Child did not report ${type}`))
    }, 10_000)
    function receive(message) {
      if (!matches(message)) return
      clearTimeout(timer)
      child.off("message", receive)
      resolve(message)
    }
    child.on("message", receive)
  })
}

async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill()
  await exited
}

async function seedState(directory, now) {
  const state = freshState()
  queueTest(state, optionsOf({
    testTag: "shared-test",
    channels: [{ type: "meow", nickname: "mock-only" }],
  }), now)
  await writeFile(join(directory, "quota-notify-state.json"), JSON.stringify(state), { mode: 0o600 })
}

test("two real host processes cannot send the same queued notification concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-notify-concurrency-"))
  const now = Date.now()
  let first
  let second
  try {
    await seedState(directory, now)
    first = startHost(directory, true)
    second = startHost(directory)
    await Promise.all([waitFor(first, "ready"), waitFor(second, "ready")])
    first.send({ type: "tick", id: 1, now })
    await waitFor(first, "sending") // Hold the first response while another host tries.
    second.send({ type: "tick", id: 1, now })
    await waitFor(second, "tick-done", 1)
    assert.equal(second.messages.filter((message) => message.type === "sending").length, 0)
    first.send({ type: "release" })
    await waitFor(first, "tick-done", 1)
    second.send({ type: "tick", id: 2, now: now + 5000 })
    await waitFor(second, "tick-done", 2)
    assert.equal(second.messages.filter((message) => message.type === "sending").length, 0)
    assert.equal(first.messages.filter((message) => message.type === "delivered").length, 1)
    assert.equal([...first.messages, ...second.messages].filter((message) => message.type === "quota").length, 1)
    const state = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(state.pending.length, 0)
    assert.equal(state.meowSent.length, 1)
  } finally {
    await Promise.all([stopHost(first), stopHost(second)])
    await rm(directory, { recursive: true, force: true })
  }
})

test("a host crash releases ownership and another host can resume the saved queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-notify-crash-"))
  const now = Date.now()
  let first
  let second
  try {
    await seedState(directory, now)
    first = startHost(directory, true)
    second = startHost(directory)
    await Promise.all([waitFor(first, "ready"), waitFor(second, "ready")])
    first.send({ type: "tick", id: 1, now })
    await waitFor(first, "sending")
    await stopHost(first)
    second.send({ type: "tick", id: 1, now: now + 5000 })
    await waitFor(second, "tick-done", 1)
    assert.equal(second.messages.filter((message) => message.type === "delivered").length, 1)
    const state = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(state.pending.length, 0)
    // The interrupted attempt still counts toward MeoW's rate limit.
    assert.equal(state.meowSent.length, 2)
  } finally {
    await Promise.all([stopHost(first), stopHost(second)])
    await rm(directory, { recursive: true, force: true })
  }
})

test("two host processes share hot configuration and deduplicate the same UI test command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-notify-ui-concurrency-"))
  let first
  let second
  try {
    first = startHost(directory, true)
    second = startHost(directory)
    await Promise.all([waitFor(first, "ready"), waitFor(second, "ready")])
    first.send({ type: "configure", id: 1, options: { testTag: "", pollSeconds: 120 } })
    await waitFor(first, "configured", 1)
    first.send({ type: "test", id: 1, requestId: "shared-ui-command" })
    await waitFor(first, "test-accepted", 1)
    second.send({ type: "test", id: 1, requestId: "shared-ui-command" })
    await waitFor(second, "test-accepted", 1)
    const now = Date.now()
    first.send({ type: "tick", id: 1, now })
    await waitFor(first, "sending")
    second.send({ type: "tick", id: 1, now })
    await waitFor(second, "tick-done", 1)
    first.send({ type: "release" })
    await waitFor(first, "tick-done", 1)
    second.send({ type: "tick", id: 2, now: now + 61_000 })
    await waitFor(second, "tick-done", 2)
    assert.equal([...first.messages, ...second.messages].filter((message) => message.type === "delivered").length, 1)
    assert.equal([...first.messages, ...second.messages].filter((message) => message.type === "quota").length, 1)
    const state = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(state.pending.length, 0)
    assert.equal(Object.keys(state.uiTestRequests).length, 1)
  } finally {
    await Promise.all([stopHost(first), stopHost(second)])
    await rm(directory, { recursive: true, force: true })
  }
})

test("two real hosts share one scheduled overview slot and its delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-overview-concurrency-"))
  const now = Date.parse("2026-11-11T01:00:00Z")
  let first
  let second
  try {
    first = startHost(directory, true)
    second = startHost(directory)
    await Promise.all([waitFor(first, "ready"), waitFor(second, "ready")])
    first.send({ type: "configure", id: 1, options: { testTag: "", overview: { enabled: true, frequency: "daily", time: "09:00", weekdays: [1] } } })
    await waitFor(first, "configured", 1)
    first.send({ type: "tick", id: 1, now })
    await waitFor(first, "sending")
    second.send({ type: "tick", id: 1, now })
    await waitFor(second, "tick-done", 1)
    first.send({ type: "release" })
    await waitFor(first, "tick-done", 1)
    second.send({ type: "tick", id: 2, now: now + 30_000 })
    await waitFor(second, "tick-done", 2)
    assert.equal([...first.messages, ...second.messages].filter((message) => message.type === "delivered").length, 1)
    const state = JSON.parse(await readFile(join(directory, "quota-notify-state.json"), "utf8"))
    assert.equal(state.pending.length, 0)
    assert.equal(state.overview.slot, "2026-11-11/09:00/Asia/Shanghai/daily")
  } finally {
    await Promise.all([stopHost(first), stopHost(second)])
    await rm(directory, { recursive: true, force: true })
  }
})
