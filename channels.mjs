import { windowGroup } from "./core.mjs"

function resetText(value, zone) {
  if (!value) return "未知"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "未知"
  try {
    const stamp = new Intl.DateTimeFormat("zh-CN", {
      timeZone: zone, month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date)
    return `${stamp}（${zone === "Asia/Shanghai" ? "北京时间" : zone}）`
  } catch {
    return date.toISOString()
  }
}

function percent(value) {
  return `${Number(value).toFixed(Number.isInteger(value) ? 0 : 1)}%`
}

function planText(value) {
  if (typeof value !== "string" || !value.trim()) return ""
  const plan = value.trim().toLowerCase()
  if (plan === "plus") return "Plus"
  if (plan === "pro") return "Pro"
  if (plan === "prolite") return "Pro Lite"
  return value.trim()
}

function quotaLines(event, opts) {
  const lines = []
  if (event.account) lines.push(`👤 账号：${event.account}`)
  const plan = planText(event.plan)
  if (plan) lines.push(`💳 套餐：${plan}`)
  if (event.kind === "recovered" && event.previousReadAt && Number.isFinite(event.previousRemaining)) lines.push(`📍 上次有效读数（${event.window}）：剩余 ${percent(event.previousRemaining)}（${resetText(event.previousReadAt, opts.timeZone)}）`)
  // Older queued events have only their triggering window. Keep those
  // usable without rewriting notification history or guessing a plan.
  const windows = Array.isArray(event.quotaWindows) && event.quotaWindows.length ? event.quotaWindows : [{ name: event.window, used: event.used, resetsAt: event.resetsAt }]
  for (const window of windows) {
    const group = windowGroup(window)
    const label = group === "fiveHour" ? "⏱️ 5 小时额度" : group === "weekly" ? "📅 周额度" : `📊 ${window.name || "额度"}`
    lines.push(`${label}：${Number.isFinite(window.used) ? "剩余 " + percent(Math.max(0, 100 - window.used)) + " · 已用 " + percent(window.used) : "暂无读数"}`)
    if (window.resetsAt) lines.push(`🔄 ${event.kind === "reset_reminder" ? "预计重置" : "重置"}：${resetText(window.resetsAt, opts.timeZone)}`)
  }
  if (event.quotaReadAt) lines.push(`🕒 读数：${resetText(event.quotaReadAt, opts.timeZone)}`)
  return lines
}

export function messageOf(event, opts) {
  if (event.kind === "test") {
    return {
      title: "✅ Magpie 额度通知测试",
      body: "📨 测试消息已由插件发出。\n📱 收到此通知说明推送渠道配置正确。",
    }
  }
  if (event.kind.startsWith("codex_reset_")) {
    const scheduled = event.kind === "codex_reset_scheduled"
    const lines = ["📡 来源：Did Codex Reset（第三方监测）", scheduled ? "这是外部预告，尚未确认你的账号恢复。" : "这是外部完成记录，请以账号有效读数为准。"]
    lines.push(`🌐 重置范围：${{ global: "全局额度", banked: "储备额度", global_and_banked: "全局及储备额度" }[event.resetType] || "来源未说明"}`)
    if (scheduled && event.schedulePrecision === "date" && event.scheduleWindow) {
      lines.push(`🗓️ 预计时段：${resetText(event.scheduleWindow.startAt, opts.timeZone)} ～ ${resetText(event.scheduleWindow.endAt, opts.timeZone)}`)
    } else lines.push(`⏰ ${scheduled ? "预计时间" : "外部记录时间"}：${resetText(event.effectiveAt, opts.timeZone)}`)
    if (event.scheduleConstraint === "deadline") lines.push("原消息给出的是最晚期限，不是确定重置时刻。")
    if (Number.isFinite(event.confidence)) lines.push(`📊 来源置信度：${Math.round(event.confidence * 100)}%`)
    if (event.scope?.plans?.length) lines.push(`💳 涉及套餐：${event.scope.plans.join("、")}`)
    if (event.text) lines.push(event.text)
    if (event.sourceUrl) lines.push(`🔗 原文：${event.sourceUrl}`)
    return { title: `📣 Codex ${scheduled ? "重置预告" : "重置完成（外部消息）"}${event.updated ? " · 更新" : ""}`, body: lines.join("\n") }
  }
  if (event.kind === "reset_reminder") {
    return {
      title: `⏳ ${event.providerName}${planText(event.plan) ? " " + planText(event.plan) : ""} · ${event.window} ${event.used >= 99.999 ? "预计即将恢复" : "即将重置"}`,
      body: quotaLines(event, opts).join("\n"),
    }
  }
  const status = {
    exhausted: ["🔴", "已耗尽"],
    recovered: ["🟢", "已恢复"],
    low: ["🟠", "即将耗尽"],
  }[event.kind] || ["🔔", "额度变化"]
  const title = `${status[0]} ${event.providerName}${planText(event.plan) ? " " + planText(event.plan) : ""} · ${event.window} ${event.kind === "low" && event.threshold ? "剩余 ≤ " + percent(event.threshold) : status[1]}`
  const lines = quotaLines(event, opts)
  return { title, body: lines.join("\n") }
}

function fail(retry, code, message) {
  return { ok: false, retry, code, reason: message }
}

function endpoint(base, path) {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/+$/, "") + path
  url.search = ""
  url.hash = ""
  return url.toString()
}

async function post(url, payload, headers, fetchFn) {
  return fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
}

// MeoW returns HTTP 200 even when the business status is 429/404/500.
// Inspect the JSON rather than treating any HTTP 200 as delivered.
export async function deliver(channel, event, opts, fetchFn = fetch) {
  const { title, body } = messageOf(event, opts)
  let response
  try {
    switch (channel.type) {
      case "meow": {
        const nickname = String(channel.nickname).trim()
        if (nickname.includes("/")) return fail(false, 400, "MeoW nickname cannot contain /")
        const target = new URL(endpoint(channel.server || "https://api.chuckfang.com", `/${encodeURIComponent(nickname)}`))
        target.searchParams.set("msgType", "text")
        const category = String(channel.category ?? "Magpie额度").trim()
        if ([...category].length > 10) return fail(false, 400, "MeoW category is over 10 characters")
        response = await post(target.toString(), {
          title, msg: body, category,
          ...(channel.url || event.url || opts.dashboardUrl ? { url: channel.url || event.url || opts.dashboardUrl } : {}),
        }, {}, fetchFn)
        if (!response.ok) return fail(response.status === 429 || response.status >= 500, response.status, "MeoW HTTP error")
        let result
        try { result = await response.json() } catch { return fail(true, 502, "MeoW returned invalid JSON") }
        const code = Number(result?.status)
        return code === 200 && result?.data !== false
          ? { ok: true }
          : fail(code === 429 || code >= 500 || !Number.isFinite(code), code || 502, "MeoW business status")
      }
      case "bark": {
        const base = channel.server || "https://api.day.app"
        response = await post(endpoint(base, "/push"), {
          device_key: channel.key, title, body,
          group: channel.group || "Magpie",
          ...(channel.sound ? { sound: channel.sound } : {}),
          ...(channel.url || event.url || opts.dashboardUrl ? { url: channel.url || event.url || opts.dashboardUrl } : {}),
        }, {}, fetchFn)
        if (!response.ok) return fail(response.status === 429 || response.status >= 500, response.status, "Bark HTTP error")
        const result = await response.json().catch(() => null)
        const code = Number(result?.code)
        return !result || !Number.isFinite(code) || code === 200
          ? { ok: true }
          : fail(code === 429 || code >= 500, code, "Bark business status")
      }
      case "webhook": {
        response = await post(channel.url, {
          title, body, event: { ...event, type: `magpie.quota.${event.kind}` },
        }, channel.headers && typeof channel.headers === "object" ? channel.headers : {}, fetchFn)
        return response.ok ? { ok: true } : fail(response.status === 429 || response.status >= 500, response.status, "Webhook HTTP error")
      }
      default:
        return fail(false, 400, "Unknown channel type")
    }
  } catch {
    return fail(true, 0, "Network request failed or timed out")
  }
}
