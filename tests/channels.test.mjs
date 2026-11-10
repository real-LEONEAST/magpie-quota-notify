import test from "node:test"
import assert from "node:assert/strict"
import { deliver, messageOf } from "../channels.mjs"
import { getCards } from "../quota.mjs"

const o = { timeZone: "Asia/Shanghai", dashboardUrl: "https://nas.example/magpie" }
const event = {
  id: "event-1", kind: "recovered", at: "2026-11-10T08:00:00Z",
  provider: "codex", providerName: "Codex", account: "pro@domain.test",
  window: "5 hours", used: 3, remaining: 97, resetsAt: "2026-11-10T10:30:00Z",
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("HarmonyOS MeoW uses correctly encoded nickname, POST JSON msg and category", async () => {
  let seen
  const result = await deliver({ type: "meow", nickname: "张三", category: "Magpie额度" }, event, o, async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return reply({ status: 200, data: true, msg: "ok" })
  })
  assert.equal(result.ok, true)
  assert.equal(new URL(seen.url).pathname, "/%E5%BC%A0%E4%B8%89")
  assert.equal(new URL(seen.url).searchParams.get("msgType"), "text")
  assert.equal(seen.init.method, "POST")
  assert.equal(seen.body.category, "Magpie额度")
  assert.match(seen.body.msg, /剩余 97%/)
  assert.match(seen.body.msg, /北京时间/)
  assert.match(seen.body.title, /5 hours 已恢复/)
  assert.equal(seen.body.url, o.dashboardUrl)
})

test("MeoW HTTP 200 with business 429 must retry, 404 must not", async () => {
  const ch = { type: "meow", nickname: "abc" }
  let result = await deliver(ch, event, o, async () => reply({ status: 429, msg: "limit" }))
  assert.equal(result.ok, false)
  assert.equal(result.retry, true)
  assert.equal(result.code, 429)
  result = await deliver(ch, event, o, async () => reply({ status: 404, msg: "not found" }))
  assert.equal(result.retry, false)
})

test("Bark uses POST /push and webhook uses event structure", async () => {
  const seen = []
  const fetchMock = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    return reply({ code: 200 })
  }
  assert.equal((await deliver({ type: "bark", key: "secret", group: "quota" }, event, o, fetchMock)).ok, true)
  assert.equal((await deliver({ type: "webhook", url: "https://example.com/hook" }, event, o, fetchMock)).ok, true)
  assert.equal(seen[0].url, "https://api.day.app/push")
  assert.equal(seen[0].body.device_key, "secret")
  assert.equal(seen[0].body.group, "quota")
  assert.equal(seen[1].body.event.type, "magpie.quota.recovered")
  assert.equal(seen[1].body.event.account, "pro@domain.test")
})

test("gateway live mode calls GET quotas only, no inference or reset", async () => {
  const calls = []
  const fetchMock = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET"])
    return reply({ object: "list", data: [] })
  }
  assert.deepEqual(await getCards({ gatewayUrl: "http://127.0.0.1:3425", gatewayKey: "", readMode: "live" }, fetchMock), [])
  assert.deepEqual(calls, [["http://127.0.0.1:3425/v1/magpie/quotas", "GET"]])
})

test("explicit refresh mode calls the quota-only endpoint then reads cached quotas", async () => {
  const calls = []
  const fetchMock = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET"])
    return reply(init.method === "POST" ? { cards: [] } : { object: "list", data: [] })
  }
  await getCards({ gatewayUrl: "http://127.0.0.1:3425", gatewayKey: "", readMode: "refresh" }, fetchMock)
  assert.deepEqual(calls, [
    ["http://127.0.0.1:3425/v1/magpie/quotas/refresh", "POST"],
    ["http://127.0.0.1:3425/v1/magpie/quotas?kept=1", "GET"],
  ])
})

test("human-readable test message is explicit, not a real quota event", () => {
  assert.match(messageOf({ kind: "test" }, o).title, /测试/)
})
