import test from "node:test"
import assert from "node:assert/strict"
import { deliver, deliveryMessages } from "../channels.mjs"

const options = { timeZone: "Asia/Shanghai" }
const event = { kind: "test" }
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

test("PushPlus sends a WeChat text notification and validates the business result", async () => {
  let request
  const channel = { type: "pushplus", key: "mock-token", topic: "mock-group" }
  const result = await deliver(channel, event, options, async (url, init) => {
    request = { url, payload: JSON.parse(init.body) }
    return response({ code: 200, data: "mock-receipt" })
  })
  assert.equal(result.ok, true)
  assert.equal(request.url, "https://www.pushplus.plus/send")
  assert.equal(request.payload.token, "mock-token")
  assert.equal(request.payload.channel, "wechat")
  assert.equal(request.payload.template, "txt")
  assert.equal(request.payload.topic, "mock-group")
  assert.match(request.payload.content, /测试消息/)
  assert.equal((await deliver(channel, event, options, async () => response({ code: 400 }))).retry, false)
  assert.equal((await deliver(channel, event, options, async () => response({ code: 500 }))).retry, true)
})

test("ServerChan supports Turbo and sctp endpoints without adding an SDK dependency", async () => {
  const seen = []
  for (const key of ["SCTmockkey", "sctp123tmockkey"]) {
    assert.equal((await deliver({ type: "serverchan", key }, event, options, async (url, init) => {
      seen.push({ url, payload: JSON.parse(init.body) })
      return response({ code: 0, message: "SUCCESS" })
    })).ok, true)
  }
  assert.equal(seen[0].url, "https://sctapi.ftqq.com/SCTmockkey.send")
  assert.equal(seen[1].url, "https://123.push.ft07.com/send/sctp123tmockkey.send")
  assert.match(seen[0].payload.desp, /测试消息/)
  assert.equal((await deliver({ type: "serverchan", key: "SCTmockkey" }, event, options, async () => response({ code: 400 }))).retry, false)
})

test("SC3 follows the official SDK account-based endpoint and rejects malformed sctp keys", async () => {
  let target
  assert.equal((await deliver({ type: "serverchan", key: "sctp123tmock", server: "https://example.invalid/proxy" }, event, options, async (url) => {
    target = url
    return response({ code: 0 })
  })).ok, true)
  assert.equal(target, "https://example.invalid/proxy/send/sctp123tmock.send")
  const invalid = await deliver({ type: "serverchan", key: "sctp-invalid" }, event, options, async () => { throw new Error("An invalid key must not make a request") })
  assert.equal(invalid.code, 400)
  assert.equal(invalid.retry, false)
})

test("new channels reject malformed or missing success results", async () => {
  for (const channel of [{ type: "pushplus", key: "mock" }, { type: "serverchan", key: "SCTmock" }, { type: "telegram", key: "123:mock", chatId: "-100123" }]) {
    for (const body of [{}, { code: null }, { ok: false }]) {
      const result = await deliver(channel, event, options, async () => response(body))
      assert.equal(result.ok, false)
    }
    assert.equal((await deliver(channel, event, options, async () => new Response("bad json"))).ok, false)
  }
})

test("Telegram uses chat IDs, plain text and server-requested rate delays", async () => {
  let seen
  const channel = { type: "telegram", key: "123:mock-token", chatId: "-100123456" }
  assert.equal((await deliver(channel, event, options, async (url, init) => {
    seen = { url, payload: JSON.parse(init.body) }
    return response({ ok: true, result: { message_id: 1 } })
  })).ok, true)
  assert.equal(seen.url, "https://api.telegram.org/bot123:mock-token/sendMessage")
  assert.equal(seen.payload.chat_id, "-100123456")
  assert.match(seen.payload.text, /测试通知|通知测试/)
  assert.equal(seen.payload.parse_mode, undefined)
  assert.equal(seen.payload.link_preview_options.is_disabled, true)
  const limited = await deliver(channel, event, options, async () => response({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, 429))
  assert.equal(limited.retry, true)
  assert.equal(limited.retryAfter, 60_000)
  assert.equal((await deliver(channel, event, options, async () => response({ ok: false, error_code: 400 }, 400))).retry, false)
})

test("a configured API base is used for each new channel", async () => {
  const seen = []
  for (const channel of [{ type: "pushplus", key: "mock" }, { type: "serverchan", key: "SCTmock" }, { type: "telegram", key: "123:mock", chatId: "123" }]) {
    await deliver({ ...channel, server: "https://example.invalid/proxy/" }, event, options, async (url) => {
      seen.push(url)
      return response({ ok: true, code: channel.type === "serverchan" ? 0 : 200 })
    })
  }
  assert.deepEqual(seen, ["https://example.invalid/proxy/send", "https://example.invalid/proxy/SCTmock.send", "https://example.invalid/proxy/bot123:mock/sendMessage"])
})

test("Telegram splits long overviews without broken Unicode or dropping account content", () => {
  const accounts = Array.from({ length: 40 }, (_, index) => ({
    account: `user-${index}@example.test`, provider: "codex", providerName: "Codex", plan: "plus",
    quotaReadAt: "2026-11-11T01:00:00Z", quotaWindows: [{ name: "5 hours", used: 50, resetsAt: "2026-11-11T06:00:00Z" }, { name: "7 days", used: 90 }],
  }))
  const messages = deliveryMessages({ type: "telegram" }, { kind: "overview", frequency: "daily", at: "2026-11-11T01:00:00Z", accounts }, options)
  assert.ok(messages.length > 1)
  assert.ok(messages.every((message) => message.body.length <= 4096 && !message.body.includes("\uFFFD")))
  const text = messages.map((message) => message.body).join("\n")
  for (const account of accounts) assert.ok(text.includes(account.account))
})
