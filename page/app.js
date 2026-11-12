const $ = (selector) => document.querySelector(selector)
const token = $('meta[name="quota-token"]').content
const statusNames = { queued: "等待发送", enqueued: "已进入队列", delivered: "服务已接收", retrying: "等待重试", failed: "发送失败", cancelled: "已取消", applied: "已应用" }
const kindNames = { test: "测试推送", low: "额度不足", exhausted: "额度耗尽", recovered: "额度恢复", reset_reminder: "重置前提醒", codex_reset_scheduled: "外部重置预告", codex_reset_completed: "外部完成消息", overview: "定时概览", batch: "同轮合并", settings: "设置更新" }
const channelNames = { meow: "MeoW", bark: "Bark", webhook: "Webhook", pushplus: "PushPlus", serverchan: "Server酱", telegram: "Telegram" }
const notificationEvents = ["low", "exhausted", "recovered", "reset_reminder", "codex_reset_scheduled", "codex_reset_completed", "overview"]
const themeTokens = ["bg", "card", "fg", "fg-2", "line", "accent", "accent-soft", "accent-fg", "green", "red", "amber", "font"]
const themeRequestId = "quota-notify-theme"
let saved
let draft
let status
let dirty = false
let saving = false
let testing = false
let toastTimer
let customPoll = false

function followMagpieTheme() {
  if (window.parent === window) return

  // The service document replaces the launcher but keeps its Magpie frame.
  // Ask the same parent for its theme and listen for changes in that frame.
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.magpie !== 1) return
    const message = event.data
    const theme = message.event === "theme" ? message.data : message.id === themeRequestId ? message.result : null
    if (typeof theme?.dark !== "boolean") return

    const root = document.documentElement
    root.dataset.theme = theme.dark ? "dark" : "light"
    for (const name of themeTokens) {
      root.style.setProperty(`--magpie-${name}`, theme.tokens?.[name] || "")
    }
  })
  window.parent.postMessage({ magpie: 1, id: themeRequestId, method: "theme" }, "*")
}

async function api(path, body) {
  const response = await fetch(new URL(`api/${path}`, document.baseURI), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Quota-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || "请求失败，请稍后重试")
  return value
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function date(value, short = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—"
  return new Intl.DateTimeFormat("zh-CN", { timeZone: saved?.options.timeZone || "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(short ? {} : { second: "2-digit" }) }).format(new Date(value))
}

function toast(message, error = false) {
  clearTimeout(toastTimer)
  $("#toast").textContent = message
  $("#toast").classList.toggle("toast-error", error)
  $("#toast").hidden = false
  toastTimer = setTimeout(() => { $("#toast").hidden = true }, error ? 8000 : 4000)
}

function setDirty(value = true) {
  dirty = value
  $("#save-state").textContent = dirty ? "有尚未保存的修改" : `设置已应用 · v${saved.revision}`
  $("#save").disabled = saving || !dirty
  $("#revert").disabled = saving || !dirty
  $("#test-push").disabled = dirty || testing || !status?.enabled || !status?.configured
  document.querySelectorAll(".channel-test").forEach((button) => { button.disabled = dirty || testing || !status?.enabled || !button.dataset.channelId || draft.channels[Number(button.dataset.index)]?.off === true })
  $("#test-help").textContent = dirty ? "请先保存设置，再测试推送。" : status?.demo ? "本机测试只模拟发送，不会向手机推送。" : "使用已保存的渠道发送，请在手机端确认接收。"
}

function fillForm() {
  draft = structuredClone(saved.options)
  customPoll = ![60, 300, 600, 1800].includes(draft.pollSeconds)
  const values = { "poll-minutes": draft.pollSeconds / 60, "max-age": draft.maxReadAgeMinutes, providers: draft.providers.join(", "), timezone: draft.timeZone, "dashboard-url": draft.dashboardUrl, "gateway-url": draft.gatewayUrl, "gateway-key": "" }
  for (const [id, value] of Object.entries(values)) $(`#${id}`).value = value ?? ""
  for (const [id, name] of Object.entries({ enabled: "enabled", "notify-low": "notifyLow", "notify-exhausted": "notifyExhausted", "notify-recovered": "notifyRecovered", "notify-start": "notifyOnStart" })) $(`#${id}`).checked = draft[name]
  $("#clear-gateway").checked = false
  $("#gateway-key").placeholder = saved.hasGatewayKey ? "已保存，留空保留" : "未设置，可选"
  $("#reset-feed-enabled").checked = draft.codexResetUpdates.enabled
  $("#reset-feed-current").checked = draft.codexResetUpdates.notifyCurrentPending
  $("#merge-polling").checked = draft.mergePolling
  $("#overview-enabled").checked = draft.overview.enabled
  $("#overview-time").value = draft.overview.time
  document.querySelectorAll("#overview-weekdays input").forEach((input) => { input.checked = draft.overview.weekdays.includes(Number(input.value)) })
  $("#time-zone-note").textContent = `页面和通知使用 ${draft.timeZone} 时区。`
  fillThresholds()
  renderChoices()
  renderNotificationRules()
  renderChannels()
  setDirty(false)
}

function fillThresholds() {
  for (let index = 0; index < 3; index++) $(`#threshold-${index}`).value = draft.lowThresholds[index] ?? ""
}

function renderChoices() {
  document.querySelectorAll(".segments[data-option]").forEach((group) => {
    const path = group.dataset.option.split(".")
    let value = path.length === 1 ? draft[path[0]] : draft[path[0]][path[1]]
    if (path[0] === "pollSeconds" && customPoll) value = "custom"
    group.querySelectorAll("[data-custom]").forEach((button) => button.remove())
    if (![...group.querySelectorAll("button")].some((button) => button.dataset.value === String(value))) {
      const button = element("button", "", `${value} 分钟`)
      button.type = "button"
      button.dataset.value = value
      button.dataset.custom = "true"
      group.append(button)
    }
    group.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === String(value))))
  })
  $("#custom-poll").hidden = !customPoll
  $("#overview-fields").disabled = !$("#overview-enabled").checked
  $("#overview-weekdays").hidden = draft.overview.frequency !== "weekly"
}

function field(container, title, value, change, options = {}) {
  const label = element("label", "", title)
  const input = element("input")
  input.type = options.type || "text"
  input.value = value ?? ""
  input.placeholder = options.placeholder || ""
  if (options.required) input.required = true
  if (input.type === "password") input.autocomplete = "new-password"
  input.addEventListener("input", () => { change(input.value); setDirty() })
  label.append(input)
  container.append(label)
  return input
}

function checkbox(container, title, checked, change) {
  const label = element("label", "choice", "")
  const input = element("input")
  input.type = "checkbox"
  input.checked = checked
  input.addEventListener("change", () => { change(input.checked); setDirty() })
  label.append(input, document.createTextNode(title))
  container.append(label)
  return input
}

function renderAccountGroup(container) {
  const choices = new Map((status?.accounts || []).map((account) => [account.id, account.label]))
  for (const id of draft.accounts || []) {
    if (choices.has(id)) continue
    let label = id
    try { const [provider, , account] = JSON.parse(id); label = `${provider} · ${account}` } catch {}
    choices.set(id, `${label}（暂未读取）`)
  }
  const signature = JSON.stringify([draft.accounts, [...choices]])
  if (container.dataset.signature === signature) return
  container.dataset.signature = signature
  container.replaceChildren()
  const all = draft.accounts == null
  for (const [id, label] of choices) {
    const input = checkbox(container, label, all || draft.accounts.includes(id), (checked) => {
      draft.accounts = checked ? [...draft.accounts, id] : draft.accounts.filter((value) => value !== id)
    })
    input.disabled = all
  }
  if (!choices.size) container.append(element("p", "muted", "账号列表在下一次额度检查后出现。"))
}

function renderAccountChoices() {
  renderAccountGroup($("#notification-account-choices"))
}

function renderNotificationRules() {
  const section = $("#notification-rules")
  section.replaceChildren()
  const events = element("fieldset", "notification-rule")
  events.append(element("legend", "", "接收事件"))
  checkbox(events, "全部事件", draft.events == null, (all) => {
    draft.events = all ? null : []
    renderNotificationRules()
  })
  const eventChoices = element("div", "choice-grid")
  for (const kind of notificationEvents) {
    const input = checkbox(eventChoices, kindNames[kind], draft.events == null || draft.events.includes(kind), (checked) => {
      draft.events = checked ? [...draft.events, kind] : draft.events.filter((value) => value !== kind)
    })
    input.disabled = draft.events == null
  }
  events.append(eventChoices)
  const accounts = element("fieldset", "notification-rule")
  accounts.append(element("legend", "", "接收账号"))
  checkbox(accounts, "全部账号", draft.accounts == null, (all) => {
    draft.accounts = all ? null : []
    renderNotificationRules()
  })
  const accountChoices = element("div", "choice-grid account-choices")
  accountChoices.id = "notification-account-choices"
  renderAccountGroup(accountChoices)
  accounts.append(accountChoices, element("p", "rule-note", "账号筛选用于额度提醒和定时概览。外部重置消息按事件选择接收。"))
  section.append(events, accounts)
}

function renderChannels() {
  const list = $("#channel-list")
  list.replaceChildren()
  if (!draft.channels.length) list.append(element("p", "empty", "尚未添加推送渠道。"))
  draft.channels.forEach((channel, index) => {
    const card = element("article", "channel-card")
    const head = element("div", "channel-head")
    const title = element("strong", "", `${String(index + 1).padStart(2, "0")} / ${channelNames[channel.type]}`)
    const actions = element("div", "channel-actions")
    const enabledLabel = element("label", "inline", "启用")
    const enabled = element("input")
    enabled.type = "checkbox"
    enabled.checked = !channel.off
    enabled.addEventListener("change", () => { channel.off = !enabled.checked; setDirty() })
    enabledLabel.prepend(enabled)
    const test = element("button", "secondary channel-test", "测试此渠道")
    test.type = "button"
    test.dataset.channelId = channel.id || channel.__source || ""
    test.dataset.index = index
    test.addEventListener("click", () => runTest([test.dataset.channelId]))
    const remove = element("button", "text-button danger", "删除")
    remove.type = "button"
    remove.addEventListener("click", () => { draft.channels.splice(index, 1); renderChannels(); setDirty() })
    actions.append(test, enabledLabel, remove)
    head.append(title, actions)
    const fields = element("div", "form-grid")
    const advanced = element("details", "channel-details")
    advanced.append(element("summary", "", "更多渠道设置"))
    const advancedFields = element("div", "form-grid details-grid")
    if (channel.type === "meow") {
      field(fields, "MeoW 昵称", channel.nickname, (value) => { channel.nickname = value }, { placeholder: "手机端的推送昵称" })
      field(advancedFields, "消息分类", channel.category ?? "Magpie额度", (value) => { channel.category = value })
      field(advancedFields, "MeoW 服务地址（可选）", channel.server, (value) => { channel.server = value }, { type: "url", placeholder: "留空使用默认服务" })
    } else if (channel.type === "bark") {
      field(fields, "Bark 设备 Key", "", (value) => { channel.key = value }, { type: "password", placeholder: channel.__hasKey ? "已保存，留空保留" : "填写设备 Key" })
      field(advancedFields, "Bark 服务地址（可选）", channel.server, (value) => { channel.server = value }, { type: "url", placeholder: "留空使用默认服务" })
      field(advancedFields, "消息分组（可选）", channel.group, (value) => { channel.group = value })
    } else if (["pushplus", "serverchan", "telegram"].includes(channel.type)) {
      const keyName = { pushplus: "PushPlus Token", serverchan: "Server酱 SendKey", telegram: "Telegram Bot Token" }[channel.type]
      field(fields, keyName, "", (value) => { channel.key = value }, { type: "password", placeholder: channel.__hasKey ? "已保存，留空保留" : `填写 ${keyName}` })
      if (channel.type === "telegram") field(fields, "Telegram Chat ID", channel.chatId, (value) => { channel.chatId = value.trim() }, { placeholder: "个人或群组 ID，例如 -100…" })
      if (channel.type === "pushplus") field(advancedFields, "PushPlus 群组编码（可选）", channel.topic, (value) => { channel.topic = value.trim() })
      field(advancedFields, "服务地址（可选）", channel.server, (value) => { channel.server = value }, { type: "url", placeholder: "留空使用官方服务" })
    } else if (channel.type === "webhook") {
      field(fields, "Webhook 地址", "", (value) => { channel.url = value }, { type: "password", placeholder: channel.__hasUrl ? "已保存，留空保留" : "https://…" })
      const headerSection = element("div", "headers-section")
      headerSection.append(element("span", "field-title", "请求头（可选）"))
      const rows = element("div")
      const headers = Object.entries(channel.headers || {}).map(([name, value]) => ({ name, value }))
      const syncHeaders = () => { channel.headers = Object.fromEntries(headers.filter((row) => row.name).map((row) => [row.name, row.value])) }
      function renderHeaders() {
        rows.replaceChildren()
        headers.forEach((row, rowIndex) => {
          const line = element("div", "header-row")
          field(line, "名称", row.name, (value) => { row.name = value; syncHeaders() }, { placeholder: "Authorization" })
          field(line, "值", row.value, (value) => { row.value = value; syncHeaders() }, { type: "password", placeholder: channel.__savedHeaders?.includes(row.name) ? "已保存，留空保留" : "填写请求头值" })
          const removeHeader = element("button", "text-button danger", "移除")
          removeHeader.type = "button"
          removeHeader.addEventListener("click", () => { headers.splice(rowIndex, 1); syncHeaders(); renderHeaders(); setDirty() })
          line.append(removeHeader)
          rows.append(line)
        })
      }
      const add = element("button", "text-button", "＋ 添加请求头")
      add.type = "button"
      add.addEventListener("click", () => { headers.push({ name: "", value: "" }); renderHeaders(); setDirty() })
      renderHeaders()
      headerSection.append(rows, add)
      advancedFields.append(headerSection)
    }
    advanced.append(advancedFields)
    card.append(head, fields, advanced)
    list.append(card)
  })
}

function formOptions() {
  const lowThresholds = [0, 1, 2].map((index) => $(`#threshold-${index}`).value).filter((value) => value !== "").map(Number)
  return {
    ...draft, enabled: $("#enabled").checked, pollSeconds: customPoll ? Math.round(Number($("#poll-minutes").value) * 60) : draft.pollSeconds,
    lowThresholds, lowPercent: lowThresholds.length ? Number((100 - Math.min(...lowThresholds)).toFixed(1)) : draft.lowPercent,
    maxReadAgeMinutes: Number($("#max-age").value), providers: $("#providers").value.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
    timeZone: $("#timezone").value.trim(), dashboardUrl: $("#dashboard-url").value.trim(),
    gatewayUrl: $("#gateway-url").value.trim(), gatewayKey: $("#gateway-key").value,
    notifyLow: $("#notify-low").checked, notifyExhausted: $("#notify-exhausted").checked,
    notifyRecovered: $("#notify-recovered").checked, notifyOnStart: $("#notify-start").checked,
    mergePolling: $("#merge-polling").checked,
    overview: { ...draft.overview, enabled: $("#overview-enabled").checked, time: $("#overview-time").value, weekdays: [...document.querySelectorAll("#overview-weekdays input:checked")].map((input) => Number(input.value)) },
    codexResetUpdates: { ...draft.codexResetUpdates, enabled: $("#reset-feed-enabled").checked, notifyCurrentPending: $("#reset-feed-current").checked },
  }
}

function renderStatus() {
  $("#demo").hidden = !status.demo
  $("#connection").textContent = status.demo ? "本机模拟" : "已连接"
  $("#connection").classList.add("connected")
  $("#monitor-state").textContent = !status.enabled ? "已暂停" : !status.configured ? "待配置" : status.lastError ? "读取异常" : "运行中"
  $("#monitor-detail").textContent = !status.enabled ? "已停止新的检查与发送" : status.lastError ? "请检查额度接口与运行记录" : `每 ${status.pollSeconds / 60} 分钟检查`
  $("#window-count").textContent = status.trackedWindowCount
  $("#next-poll").textContent = status.enabled ? status.busy ? "检查 / 发送中" : date(status.nextPollAt, true) : "—"
  $("#last-poll").textContent = `上次检查 ${date(status.lastPollAt, true)}`
  $("#pending-count").textContent = status.pendingCount
  $("#applied-detail").textContent = `后台已应用 v${status.appliedRevision} · ${date(status.appliedAt, true)}`
  $("#snapshot-mode").textContent = status.readMode === "refresh" ? "主动刷新" : "Magpie 缓存"
  $("#overview-status").textContent = !status.overview.enabled ? "未开启定时概览。" : `按 ${saved.options.timeZone} 时区发送${status.overview.lastQueuedAt ? " · 上次入队 " + date(status.overview.lastQueuedAt) : ""}`
  renderAccountChoices()
  const cards = $("#quota-cards")
  cards.replaceChildren()
  for (const card of status.cards) {
    const view = element("article", "quota-card")
    const head = element("div", "quota-head")
    head.append(element("strong", "", card.name || card.provider), element("span", "badge", card.provider))
    view.append(head)
    if (card.user) view.append(element("p", "muted account", card.user))
    const old = card.stale || !card.readAt || Date.now() - Date.parse(card.readAt) > saved.options.maxReadAgeMinutes * 60_000
    for (const window of card.windows) {
      const row = element("div", "quota-window")
      const label = element("div", "quota-label")
      const known = Number.isFinite(window.used)
      const remaining = known ? Math.max(0, Math.min(100, 100 - window.used)) : null
      label.append(element("span", "", window.name || "额度"), element("strong", remaining !== null && remaining <= 10 ? "danger" : "", window.unlimited ? "不限量" : remaining === null ? "暂无读数" : `剩余 ${Number(remaining.toFixed(1))}%`))
      row.append(label)
      if (known && !window.unlimited) {
        const track = element("div", "progress")
        const bar = element("progress")
        bar.max = 100
        bar.value = remaining
        bar.className = remaining <= 10 ? "low" : ""
        bar.setAttribute("aria-label", `${window.name} 剩余额度`)
        track.append(bar)
        row.append(track)
      }
      row.append(element("small", "muted", `重置时间 ${date(window.resetsAt, true)}`))
      const reminder = saved.options.resetReminders[window.group]
      if (reminder && reminder !== "off") row.append(element("small", "reminder-note", `重置前 ${saved.options.resetLeadMinutes[window.group]} 分钟提醒 · ${reminder === "remaining" ? "有余量时" : reminder === "exhausted" ? "用完后" : "每次"}`))
      view.append(row)
    }
    view.append(element("small", old ? "stale" : "muted", `${old ? "读数待刷新 · " : "读取于 "}${date(card.readAt, true)}`))
    cards.append(view)
  }
  if (!status.cards.length) cards.append(element("p", "empty", status.lastError || "等待首次读取额度，快照将在下一次检查后出现。"))
  const feed = status.externalResets
  $("#feed-status").textContent = !feed.enabled ? "未启用转发。" : feed.lastError ? `外部消息读取失败：${feed.lastError}；账号额度监控继续运行。` : `上次检查 ${date(feed.lastPollAt)} · 数据更新时间 ${date(feed.generatedAt)}`
  const pending = $("#feed-pending")
  pending.replaceChildren()
  if (feed.enabled) for (const record of feed.pending) {
    const item = element("div", "feed-item")
    item.append(element("strong", "", "Codex · 外部重置预告"))
    item.append(element("p", "", record.schedulePrecision === "date" ? `预计时段 ${date(record.scheduleWindow?.startAt)} ～ ${date(record.scheduleWindow?.endAt)}` : `预计时间 ${date(record.effectiveAt)}`))
    if (record.text) item.append(element("p", "muted", record.text))
    pending.append(item)
  }
  const events = $("#event-list")
  events.replaceChildren()
  for (const event of status.events) {
    const row = element("tr")
    for (const value of [date(event.at), `${kindNames[event.kind] || event.kind}${event.channel ? " / " + event.channel : ""}`, statusNames[event.status] || event.status, event.detail || event.title]) row.append(element("td", "", value))
    row.children[2].className = ["failed", "cancelled"].includes(event.status) ? "danger" : "event-result"
    events.append(row)
  }
  if (!status.events.length) {
    const row = element("tr")
    const cell = element("td", "empty", "暂无新记录。")
    cell.colSpan = 4
    row.append(cell)
    events.append(row)
  }
  const latest = status.tests[0]
  if (latest) $("#test-result").textContent = `最近测试：${statusNames[latest.status] || latest.status} · ${date(latest.at)}${latest.detail ? " · " + latest.detail : ""}`
  setDirty(dirty)
}

async function refreshStatus() {
  status = await api("status")
  $("#page-error").hidden = true
  renderStatus()
}

$("#settings-form").addEventListener("input", () => { if (saved) setDirty() })
$("#settings-form").addEventListener("change", () => { if (saved) setDirty() })
// Magpie's frame permits scripts but forbids native form submissions.
// Save via an explicit button and fetch, retaining browser field validation.
$("#settings-form").addEventListener("submit", (event) => event.preventDefault())
$("#save").addEventListener("click", async (event) => {
  event.preventDefault()
  if (saving || !dirty || !$("#settings-form").reportValidity()) return
  saving = true
  setDirty(dirty)
  $("#settings-form").inert = true
  try {
    saved = await api("config", { revision: saved.revision, options: formOptions(), clearGatewayKey: $("#clear-gateway").checked })
    fillForm()
    toast(`设置已保存并应用 · v${saved.revision}`)
    await refreshStatus()
  } catch (error) { toast(error.message, true) }
  finally { saving = false; $("#settings-form").inert = false; setDirty(dirty) }
})
$("#revert").addEventListener("click", () => { fillForm(); toast("已撤销尚未保存的修改") })
document.querySelectorAll("[data-add-channel]").forEach((button) => button.addEventListener("click", () => {
  const type = button.dataset.addChannel
  draft.channels.push(type === "meow" ? { type, nickname: "", category: "Magpie额度" } : type === "webhook" ? { type, url: "", headers: {} } : type === "telegram" ? { type, key: "", chatId: "" } : { type, key: "" })
  renderChannels()
  setDirty()
}))
document.querySelectorAll(".segments[data-option]").forEach((group) => group.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-value]")
  if (!button) return
  const path = group.dataset.option.split(".")
  const value = button.dataset.value
  if (path[0] === "pollSeconds") {
    customPoll = value === "custom"
    if (!customPoll) { draft.pollSeconds = Number(value); $("#poll-minutes").value = draft.pollSeconds / 60 }
  } else if (path.length === 1) draft[path[0]] = value
  else draft[path[0]][path[1]] = path[0] === "resetLeadMinutes" ? Number(value) : value
  renderChoices()
  setDirty()
}))
$("#threshold-standard").addEventListener("click", () => { draft.lowThresholds = [50, 20, 10]; $("#notify-low").checked = true; fillThresholds(); setDirty() })
$("#threshold-single").addEventListener("click", () => { draft.lowThresholds = [10]; $("#notify-low").checked = true; fillThresholds(); setDirty() })
async function runTest(channels) {
  testing = true
  setDirty(dirty)
  try {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("")
    await api("test", { id, ...(channels ? { channels } : {}) })
    toast(status.demo ? "模拟测试已进入队列" : "测试已进入发送队列，请留意手机")
    await refreshStatus()
  } catch (error) { toast(error.message, true) }
  finally { testing = false; setDirty(dirty) }
}
$("#test-push").addEventListener("click", () => runTest())
$("#overview-enabled").addEventListener("change", renderChoices)
$("#refresh").addEventListener("click", () => refreshStatus().catch((error) => toast(error.message, true)))
document.querySelectorAll("nav a").forEach((link) => link.addEventListener("click", () => {
  document.querySelectorAll("nav a").forEach((item) => {
    item.classList.toggle("active", item === link)
    if (item === link) item.setAttribute("aria-current", "location")
    else item.removeAttribute("aria-current")
  })
}))
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = "" } })

async function initialize() {
  try {
    saved = await api("config")
    fillForm()
    await refreshStatus()
    setInterval(() => refreshStatus().catch((error) => {
      $("#connection").textContent = "连接中断"
      $("#connection").classList.remove("connected")
      $("#page-error").textContent = error.message
      $("#page-error").hidden = false
    }), 5000)
  } catch (error) {
    $("#page-error").textContent = error.message
    $("#page-error").hidden = false
    $("#save").disabled = true
    $("#test-push").disabled = true
  }
}
followMagpieTheme()
initialize()
