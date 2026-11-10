import { createNotifier } from "../../runtime.mjs"

// Each child represents a separate Magpie/Bun host. Every request is mocked:
// these tests must never reach a real gateway or notification service.
let tick
let now = Date.now()
let releaseDelivery
Date.now = () => now
globalThis.setInterval = (fn) => { tick = fn; return 1 }
globalThis.setTimeout = () => 1
console.error = () => {}
globalThis.fetch = async (url) => {
  const target = new URL(url)
  if (target.hostname === "127.0.0.1" && target.pathname === "/v1/magpie/quotas") {
    process.send({ type: "quota" })
    return new Response(JSON.stringify({ object: "list", data: [] }))
  }
  if (target.hostname === "api.chuckfang.com" && target.pathname === "/mock-only") {
    process.send({ type: "sending" })
    if (process.env.HOLD_MOCK_DELIVERY === "1") {
      await new Promise((resolve) => { releaseDelivery = resolve })
    }
    process.send({ type: "delivered" })
    return new Response(JSON.stringify({ status: 200, data: true }))
  }
  throw new Error("Unexpected request in offline test")
}

const notifier = await createNotifier({ directory: process.argv[2] }, {
  pollSeconds: 60,
  testTag: "shared-test",
  channels: [{ type: "meow", nickname: "mock-only" }],
})
process.send({ type: "ready" })
process.on("message", async (message) => {
  if (message.type === "configure") {
    const config = notifier.readConfig()
    notifier.saveConfig({ revision: config.revision, options: { ...config.options, ...message.options } })
    process.send({ type: "configured", id: message.id })
    return
  }
  if (message.type === "test") {
    notifier.requestTest({ id: message.requestId })
    process.send({ type: "test-accepted", id: message.id })
    return
  }
  if (message.type === "release") {
    releaseDelivery?.()
    return
  }
  if (message.type === "tick") {
    now = message.now
    try {
      await tick()
      process.send({ type: "tick-done", id: message.id })
    } catch (error) {
      process.send({ type: "tick-error", id: message.id, error: String(error) })
    }
  }
})
