import { openSync, closeSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { channelId, optionsOf } from "./core.mjs"

const SETTINGS_FILE = "quota-notify-settings.sqlite"
const DEFAULT_OPTIONS = {
  enabled: true, pollSeconds: 300, readMode: "live", providers: [],
  lowPercent: 90, notifyLow: true, notifyExhausted: true,
  notifyRecovered: true, notifyOnStart: false, maxReadAgeMinutes: 60,
  timeZone: "Asia/Shanghai", dashboardUrl: "",
  gatewayUrl: "http://127.0.0.1:3425", gatewayKey: "", testTag: "", channels: [],
}

export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

// Only this new database holds editable settings and UI commands. Existing
// plugins.json options and quota-notify-state.json are not rewritten here.
export function openSettings(directory, previousOptions = {}) {
  const path = join(directory, SETTINGS_FILE)
  closeSync(openSync(path, "a", 0o600))
  const db = new DatabaseSync(path, { timeout: 1000 })
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL, options TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS test_requests (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, channels TEXT NOT NULL,
      status TEXT NOT NULL, event_id TEXT, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, event_id TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, detail TEXT NOT NULL
    );
  `)
  db.prepare("INSERT OR IGNORE INTO settings VALUES (1, 1, ?, ?)").run(
    new Date().toISOString(), JSON.stringify({ ...DEFAULT_OPTIONS, ...previousOptions }),
  )
  return db
}

export function readSettings(db) {
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get()
  const options = JSON.parse(row.options)
  const current = optionsOf(options)
  // Expand old settings in memory; opening the new page does not rewrite
  // the saved options, their revision, or the notification state.
  for (const key of ["lowThresholds", "recoveryModes", "resetReminders", "resetLeadMinutes", "codexResetUpdates"]) options[key] = current[key]
  return { revision: row.revision, updatedAt: row.updated_at, options }
}

function checkUrl(value, label, optional = false) {
  if (optional && !value) return
  let url
  try { url = new URL(value) } catch { throw problem(`${label}不是有效的网址`) }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw problem(`${label}须使用 HTTP 或 HTTPS，且不能在网址中包含账号密码`)
  }
}

export function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw problem("设置必须是一个对象")
  for (const name of ["enabled", "notifyLow", "notifyExhausted", "notifyRecovered", "notifyOnStart"]) {
    if (typeof options[name] !== "boolean") throw problem(`${name}须为开关值`)
  }
  if (!Number.isInteger(options.pollSeconds) || options.pollSeconds < 60 || options.pollSeconds > 3600) throw problem("检查间隔须为 1～60 分钟")
  if (!["live", "refresh"].includes(options.readMode)) throw problem("请选择有效的额度读取方式")
  if (!Number.isFinite(options.lowPercent) || options.lowPercent < 1 || options.lowPercent > 99.9) throw problem("剩余额度阈值须大于 0 且小于 100")
  if (!Array.isArray(options.lowThresholds) || !options.lowThresholds.length || options.lowThresholds.length > 3 || options.lowThresholds.some((value, index, values) => !Number.isFinite(value) || value < 0.1 || value > 99 || index > 0 && value >= values[index - 1])) throw problem("提醒阈值须为 1～3 档，按从大到小排列，范围为 0.1～99%")
  for (const group of ["fiveHour", "weekly"]) {
    if (!["off", "all", "exhausted"].includes(options.recoveryModes?.[group])) throw problem("恢复通知选项无效")
    if (!["off", "all", "remaining", "exhausted"].includes(options.resetReminders?.[group])) throw problem("重置前提醒选项无效")
    if (!Number.isInteger(options.resetLeadMinutes?.[group]) || options.resetLeadMinutes[group] < 1 || options.resetLeadMinutes[group] > (group === "fiveHour" ? 240 : 4320)) throw problem("重置提醒提前时间无效")
  }
  if (typeof options.codexResetUpdates?.enabled !== "boolean" || typeof options.codexResetUpdates?.notifyCurrentPending !== "boolean" || !Number.isInteger(options.codexResetUpdates?.pollSeconds) || options.codexResetUpdates.pollSeconds < 300 || options.codexResetUpdates.pollSeconds > 3600) throw problem("外部重置预告选项无效")
  if (!Number.isFinite(options.maxReadAgeMinutes) || options.maxReadAgeMinutes < 5 || options.maxReadAgeMinutes > 1440) throw problem("有效读数时间须为 5～1440 分钟")
  if (!Array.isArray(options.providers) || options.providers.some((value) => typeof value !== "string" || !value.trim())) throw problem("供应商选择无效")
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: options.timeZone }) } catch { throw problem("时区无效") }
  checkUrl(options.gatewayUrl, "额度接口地址")
  checkUrl(options.dashboardUrl, "通知跳转地址", true)
  if (!Array.isArray(options.channels)) throw problem("通知渠道须为列表")
  let active = 0
  for (const channel of options.channels) {
    if (!channel || typeof channel !== "object" || !["meow", "bark", "webhook"].includes(channel.type)) throw problem("通知渠道类型无效")
    if (channel.off) continue
    active++
    if (channel.type === "meow") {
      if (typeof channel.nickname !== "string" || !channel.nickname.trim() || /[\/\r\n]/.test(channel.nickname)) throw problem("请填写有效的 MeoW 昵称")
      if ([...String(channel.category ?? "Magpie额度")].length > 10 || /[\r\n]/.test(String(channel.category || ""))) throw problem("MeoW 分类最多 10 个字符，不能换行")
    }
    if (channel.type === "bark" && (typeof channel.key !== "string" || !channel.key.trim())) throw problem("请填写 Bark 设备 Key")
    if (channel.server) checkUrl(channel.server, "推送服务地址")
    if (channel.type === "webhook") {
      checkUrl(channel.url, "Webhook 地址")
      if (channel.headers && (typeof channel.headers !== "object" || Array.isArray(channel.headers))) throw problem("Webhook 请求头无效")
      for (const [name, value] of Object.entries(channel.headers || {})) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw problem("Webhook 请求头名称或内容无效")
      }
    }
  }
  if (options.enabled && !active) throw problem("请添加并启用至少一个通知渠道，或先暂停通知")
  return options
}

// Secrets are kept on the server. Empty, unchanged password fields retain
// the old value; deleting a header row removes it. UI-only markers never
// enter the channel hash, so an unchanged recipient keeps its queued jobs.
export function publicSettings(saved) {
  const options = structuredClone(saved.options)
  const hasGatewayKey = !!options.gatewayKey
  options.gatewayKey = ""
  options.channels = (options.channels || []).map((channel) => ({
    ...channel, key: channel.key ? "" : channel.key,
    url: channel.type === "webhook" ? "" : channel.url,
    headers: channel.headers ? Object.fromEntries(Object.keys(channel.headers).map((name) => [name, ""])) : undefined,
    __source: channelId(channel), __hasKey: !!channel.key, __hasUrl: !!channel.url,
    __savedHeaders: Object.keys(channel.headers || {}),
  }))
  return { ...saved, options, hasGatewayKey }
}

export function writeSettings(db, request) {
  if (!request || typeof request !== "object") throw problem("设置内容无效")
  db.exec("BEGIN IMMEDIATE")
  try {
    const previous = readSettings(db)
    if (request.revision !== previous.revision) throw problem("设置已在其他页面更新，请重新载入后再保存", 409)
    if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) throw problem("设置内容无效")
    const next = { ...previous.options, ...request.options }
    if (!next.gatewayKey && !request.clearGatewayKey) next.gatewayKey = previous.options.gatewayKey
    if (request.clearGatewayKey) next.gatewayKey = ""
    const oldChannels = new Map(previous.options.channels.map((channel) => [channelId(channel), channel]))
    if (!Array.isArray(next.channels)) throw problem("通知渠道须为列表")
    next.channels = next.channels.map((submitted) => {
      if (!submitted || typeof submitted !== "object") throw problem("通知渠道无效")
      const candidate = oldChannels.get(submitted.__source)
      const old = candidate?.type === submitted.type ? candidate : undefined
      const channel = Object.fromEntries(Object.entries(submitted).filter(([name]) => !name.startsWith("__")))
      if (old?.key && !channel.key && !submitted.__clearKey) channel.key = old.key
      if (old?.url && !channel.url && !submitted.__clearUrl) channel.url = old.url
      if (old?.headers && channel.headers) {
        channel.headers = Object.fromEntries(Object.entries(channel.headers).map(([name, value]) => [name, value === "" && old.headers[name] ? old.headers[name] : value]))
      }
      return channel
    })
    validateOptions(next)
    const updatedAt = new Date().toISOString()
    db.prepare("UPDATE settings SET revision = ?, updated_at = ?, options = ? WHERE id = 1").run(previous.revision + 1, updatedAt, JSON.stringify(next))
    db.exec("COMMIT")
    return readSettings(db)
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function addTestRequest(db, id, channels) {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(id)) throw problem("测试请求标识无效")
  const old = db.prepare("SELECT * FROM test_requests WHERE id = ?").get(id)
  const payload = JSON.stringify(channels)
  if (old && old.channels !== payload) throw problem("该测试请求已用于其他渠道", 409)
  db.prepare("INSERT OR IGNORE INTO test_requests (id, at, channels, status) VALUES (?, ?, ?, 'queued')").run(id, new Date().toISOString(), payload)
  return db.prepare("SELECT id, at, status, detail FROM test_requests WHERE id = ?").get(id)
}

export function recordEvent(db, event) {
  db.prepare("INSERT OR REPLACE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    event.id || randomUUID(), event.at || new Date().toISOString(), event.eventId || null,
    event.kind, event.status, event.channel || "", event.title || "", event.message || "", event.detail || "",
  )
}

export function readEvents(db) {
  return db.prepare("SELECT * FROM events ORDER BY at DESC, rowid DESC LIMIT 100").all()
}
