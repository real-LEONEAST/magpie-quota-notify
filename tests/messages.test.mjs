import test from "node:test"
import assert from "node:assert/strict"
import { freshState, observe, optionsOf } from "../core.mjs"
import { deliver, messageOf } from "../channels.mjs"

const NOW = Date.parse("2026-11-10T08:00:00Z")
const iso = (time) => new Date(time).toISOString()
const opts = optionsOf({ timeZone: "Asia/Shanghai", lowThresholds: [50, 20, 10] })
const card = (plan, used = 14, at = NOW) => ({
  provider: "codex", name: "Codex", kind: "subscription", plan,
  user: "demo-plus@example.com", readAt: iso(at), windows: [
    { name: "5 hours", used: 0, resetsAt: iso(NOW + 3 * 3600_000) },
    { name: "7 days", used, resetsAt: iso(NOW + 12 * 3600_000) },
  ],
})

function eventFor(kind, plan = "plus") {
  const state = freshState()
  if (kind === "reset_reminder") return observe(state, [card(plan)], { ...opts, resetReminders: { ...opts.resetReminders, weekly: "all" } }, NOW)[0]
  if (kind === "low" || kind === "exhausted") return observe(state, [card(plan, kind === "low" ? 95 : 100)], { ...opts, notifyOnStart: true }, NOW)[0]
  observe(state, [card(plan, 100)], opts, NOW)
  return observe(state, [card(plan, 14, NOW + 60_000)], opts, NOW + 60_000)[0]
}

for (const kind of ["low", "exhausted", "recovered", "reset_reminder"]) {
  test(`Plus ${kind} notifications include the same account's five-hour and weekly quota`, () => {
    const event = eventFor(kind)
    const message = messageOf(event, opts)
    assert.match(message.title, /Codex Plus/)
    assert.match(message.body, /👤 账号：demo-plus@example.com/)
    assert.match(message.body, /💳 套餐：Plus/)
    assert.match(message.body, /⏱️ 5 小时额度：剩余 100% · 已用 0%/)
    assert.match(message.body, /📅 周额度：剩余/)
    assert.match(message.body, /🔄 (预计重置|重置)：/)
    assert.match(message.body, /🕒 读数：/)
    assert.ok(!message.body.includes("按额度接口的预计时间提醒"))
    assert.ok(!message.body.includes("实际恢复仍需新读数确认"))
    assert.equal(event.quotaWindows.length, 2)
  })
}

for (const plan of ["pro", "prolite"]) {
  test(`${plan} notifications show weekly quota without a five-hour quota`, () => {
    const event = eventFor("reset_reminder", plan)
    const message = messageOf(event, opts)
    assert.match(message.title, /Codex Pro/)
    assert.match(message.body, /📅 周额度：剩余 86% · 已用 14%/)
    assert.ok(!message.body.includes("5 小时额度"))
    assert.equal(event.quotaWindows.length, 1)
    assert.equal(event.quotaWindows[0].name, "7 days")
  })
}

test("a missing Plus window is shown as unknown rather than a zero or full balance", () => {
  const reading = card("plus", 95)
  reading.windows.shift()
  const event = observe(freshState(), [reading], { ...opts, notifyOnStart: true }, NOW)[0]
  const message = messageOf(event, opts)
  assert.match(message.body, /⏱️ 5 小时额度：暂无读数/)
  assert.match(message.body, /📅 周额度：剩余 5%/)
  assert.ok(!message.body.includes("5 小时额度：剩余 0%"))
  assert.ok(!message.body.includes("5 小时额度：剩余 100%"))
})

test("account notification snapshots never combine another account's windows", () => {
  const first = card("plus", 95)
  const second = { ...card("plus", 55), user: "other@example.com" }
  const events = observe(freshState(), [first, second], { ...opts, notifyOnStart: true }, NOW)
  const firstMessage = messageOf(events.find((event) => event.account === first.user), opts)
  assert.match(firstMessage.body, /周额度：剩余 5%/)
  assert.ok(!firstMessage.body.includes("other@example.com"))
  assert.ok(!firstMessage.body.includes("周额度：剩余 45%"))
})

test("legacy queued events retain their original reading without guessing a plan", () => {
  const event = { kind: "reset_reminder", providerName: "Codex", account: "legacy@example.com", window: "7 days", used: 22, remaining: 78, resetsAt: iso(NOW + 3600_000) }
  const message = messageOf(event, opts)
  assert.match(message.body, /📅 周额度：剩余 78% · 已用 22%/)
  assert.ok(!message.body.includes("套餐：Plus"))
  assert.ok(!message.body.includes("按额度接口"))
})

test("other providers keep their own triggering quota and plan", () => {
  const reading = { ...card("Free plan", 95), provider: "workbuddy", name: "WorkBuddy", windows: [{ name: "Credits", used: 95, resetsAt: iso(NOW + 3600_000) }] }
  const event = observe(freshState(), [reading], { ...opts, notifyOnStart: true }, NOW)[0]
  const message = messageOf(event, opts)
  assert.match(message.body, /💳 套餐：Free plan/)
  assert.match(message.body, /📊 Credits：剩余 5%/)
  assert.ok(!message.body.includes("周额度"))
})

test("MeoW receives the enhanced text while preserving its API payload contract", async () => {
  const event = eventFor("reset_reminder")
  let payload
  const result = await deliver({ type: "meow", nickname: "mock-only", category: "Magpie额度" }, event, opts, async (url, init) => {
    payload = JSON.parse(init.body)
    assert.equal(new URL(url).searchParams.get("msgType"), "text")
    return new Response(JSON.stringify({ status: 200, data: true }))
  })
  assert.equal(result.ok, true)
  assert.equal(payload.category, "Magpie额度")
  assert.match(payload.msg, /⏱️ 5 小时额度/)
  assert.match(payload.msg, /📅 周额度/)
  assert.ok(!Object.hasOwn(payload, "body"))
})
