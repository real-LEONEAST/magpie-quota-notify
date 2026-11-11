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
  if (event.kind === "batch") return batchMessage(event, opts)
  if (event.kind === "overview") return overviewMessage(event, opts)
  if (event.kind === "test") {
    return {
      title: "✅ Magpie 额度通知测试",
      body: "📨 测试消息已由插件发出。\n📱 收到此通知说明推送渠道配置正确。",
    }
  }
  if (event.kind.startsWith("codex_reset_")) {
    const scheduled = event.kind === "codex_reset_scheduled"
    const lines = ["📡 来源：Did Codex Reset（第三方监测）"]
    lines.push(`🌐 重置范围：${{ global: "全局额度", banked: "储备额度", global_and_banked: "全局及储备额度" }[event.resetType] || "来源未说明"}`)
    if (scheduled && event.schedulePrecision === "date" && event.scheduleWindow) {
      lines.push(`🗓️ 预计时段：${resetText(event.scheduleWindow.startAt, opts.timeZone)} ～ ${resetText(event.scheduleWindow.endAt, opts.timeZone)}`)
    } else lines.push(`⏰ ${scheduled ? "预计时间" : "外部记录时间"}：${resetText(event.effectiveAt, opts.timeZone)}`)
    if (event.scheduleConstraint === "deadline") lines.push("该时间为最晚期限。")
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

function triggerText(event) {
  const status = {
    low: `剩余 ≤ ${percent(event.threshold || event.remaining)}`,
    exhausted: "已耗尽", recovered: "已恢复", reset_reminder: "重置前提醒",
  }[event.kind] || "额度变化"
  return `${event.window} · ${status}`
}

function batchMessage(event, opts) {
  const accounts = new Map()
  for (const item of event.events) {
    const key = item.accountId || JSON.stringify([item.provider, item.account])
    if (!accounts.has(key)) accounts.set(key, [])
    accounts.get(key).push(item)
  }
  const lines = []
  for (const changes of accounts.values()) {
    if (lines.length) lines.push("")
    const first = changes.find((item) => item.kind === "recovered") || changes[0]
    lines.push(`🔔 ${first.providerName || first.provider}`)
    lines.push(`📣 触发：${changes.map(triggerText).join("；")}`)
    lines.push(...quotaLines(first, opts))
    for (const change of changes) {
      if (change === first || change.kind !== "recovered" || !change.previousReadAt || !Number.isFinite(change.previousRemaining)) continue
      lines.push(`📍 上次有效读数（${change.window}）：剩余 ${percent(change.previousRemaining)}（${resetText(change.previousReadAt, opts.timeZone)}）`)
    }
  }
  return { title: `📬 Magpie 额度提醒 · ${accounts.size} 个账号 / ${event.events.length} 项变化`, body: lines.join("\n") }
}

function overviewMessage(event, opts) {
  const lines = [`🗓️ 概览时间：${resetText(event.at, opts.timeZone)}`]
  if (event.error) lines.push(`⚠️ 最近读取异常：${event.error}`)
  for (const account of event.accounts) {
    lines.push("", `📊 ${account.providerName || account.provider}`)
    lines.push(...quotaLines({ ...account, kind: "overview" }, opts))
    if (account.stale) lines.push("⚠️ 此账号读数待刷新")
  }
  if (!event.accounts.length) lines.push("暂无符合筛选条件的额度账号。")
  if (event.lastPollAt) lines.push("", `🕒 最近检查：${resetText(event.lastPollAt, opts.timeZone)}`)
  return { title: `📋 Magpie ${event.frequency === "weekly" ? "每周" : "每日"}额度概览 · ${event.accounts.length} 个账号`, body: lines.join("\n") }
}

export function deliveryMessages(channel, event, opts) {
  const message = messageOf(event, opts)
  if (channel.type !== "telegram") return [message]
  let text = [message.title, message.body].filter(Boolean).join("\n\n")
  if (text.length <= 4096) return [message]
  const parts = []
  while (text.length > 4000) {
    let end = text.lastIndexOf("\n", 4000)
    if (end < 2000) end = 4000
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
    parts.push(text.slice(0, end))
    text = text.slice(end).replace(/^\n/, "")
  }
  if (text) parts.push(text)
  // The queue saves its part index, so a retry resumes the unsent part.
  return parts.map((body, index) => ({ title: "", body: `📨 ${index + 1}/${parts.length}\n${body}` }))
}

function fail(retry, code, message, retryAfter = 0) {
  return { ok: false, retry, code, reason: message, ...(retryAfter > 0 ? { retryAfter } : {}) }
}

function retryDelay(response, result) {
  const seconds = Number(result?.parameters?.retry_after || response.headers.get("retry-after"))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
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
export async function deliver(channel, event, opts, fetchFn = fetch, message = messageOf(event, opts)) {
  const { title, body } = message
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
      case "pushplus": {
        response = await post(endpoint(channel.server || "https://www.pushplus.plus", "/send"), {
          token: channel.key, title, content: body, template: "txt", channel: "wechat",
          ...(channel.topic ? { topic: channel.topic } : {}),
        }, {}, fetchFn)
        if (!response.ok) return fail(response.status === 429 || response.status >= 500, response.status, "PushPlus HTTP error", retryDelay(response))
        const result = await response.json().catch(() => null)
        const code = result?.code == null ? NaN : Number(result.code)
        return code === 200 ? { ok: true } : fail(code === 429 || code >= 500 && code < 600 || !Number.isFinite(code), code || 502, "PushPlus business status", retryDelay(response, result))
      }
      case "serverchan": {
        const key = String(channel.key)
        const sc3 = key.startsWith("sctp")
        // SC3 encodes its account number in the sctp<number>t prefix.
        const account = sc3 ? key.match(/^sctp(\d+)t[A-Za-z0-9_-]+$/)?.[1] : null
        if (sc3 && !account) return fail(false, 400, "ServerChan SendKey format is invalid")
        const base = channel.server || (sc3 ? `https://${account}.push.ft07.com` : "https://sctapi.ftqq.com")
        const target = endpoint(base, `${sc3 ? "/send" : ""}/${encodeURIComponent(key)}.send`)
        response = await post(target, { title, desp: body }, {}, fetchFn)
        if (!response.ok) return fail(response.status === 429 || response.status >= 500, response.status, "ServerChan HTTP error", retryDelay(response))
        const result = await response.json().catch(() => null)
        const code = result?.code == null ? NaN : Number(result.code)
        return code === 0 ? { ok: true } : fail(code === 429 || code >= 500 && code < 600 || !Number.isFinite(code), Number.isFinite(code) ? code : 502, "ServerChan business status", retryDelay(response, result))
      }
      case "telegram": {
        response = await post(endpoint(channel.server || "https://api.telegram.org", `/bot${channel.key}/sendMessage`), {
          chat_id: String(channel.chatId), text: [title, body].filter(Boolean).join("\n\n"),
          link_preview_options: { is_disabled: true },
        }, {}, fetchFn)
        const result = await response.json().catch(() => null)
        if (response.ok && result?.ok === true) return { ok: true }
        const code = Number(result?.error_code || (!response.ok ? response.status : 502))
        return fail(code === 429 || code >= 500, code, "Telegram API error", retryDelay(response, result))
      }
      default:
        return fail(false, 400, "Unknown channel type")
    }
  } catch {
    return fail(true, 0, "Network request failed or timed out")
  }
}
