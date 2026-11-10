import { createHash, randomUUID } from "node:crypto"
import { enqueue } from "./core.mjs"

const FEED_URL = "https://didcodexreset.com/openapi/v1/records?kind=all&pageSize=10&lang=zh-CN"
const COMPLETION_MAX_AGE = 48 * 60 * 60_000
const MAX_PAGES = 3

export async function readResetFeed(fetchFn = fetch) {
  const records = []
  let generatedAt = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchFn(`${FEED_URL}&page=${page}`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) {
      const retry = response.headers.get("retry-after")
      const retrySeconds = Number(retry)
      const retryAt = retry && Number.isFinite(retrySeconds) ? Date.now() + retrySeconds * 1000 : Date.parse(retry)
      throw Object.assign(new Error(`Did Codex Reset HTTP ${response.status}`), { retryAt: Number.isFinite(retryAt) ? retryAt : null })
    }
    const body = await response.json()
    if (body?.ok !== true || !Array.isArray(body.data?.items)) throw new Error("Did Codex Reset 返回格式无效")
    records.push(...body.data.items)
    generatedAt = body.meta?.generatedAt || generatedAt
    if (!body.data.hasNext) break
  }
  return { records, generatedAt }
}

export function resetFingerprint(record) {
  // The stable signal identity survives source-post changes. Only a change
  // to kind, confidence, timing or scope makes an announcement an update.
  const content = {
    kind: record.kind, resetType: record.resetType, confidence: record.confidence,
    effectiveAt: record.effectiveAt, scheduleWindow: record.scheduleWindow,
    schedulePrecision: record.schedulePrecision, scheduleConstraint: record.scheduleConstraint,
    scope: record.scope ? { plans: [...(record.scope.plans || [])].sort(), windows: [...(record.scope.windows || [])].sort() } : null,
  }
  return createHash("sha256").update(JSON.stringify(content)).digest("hex")
}

export function observeResetFeed(state, result, opts, now = Date.now()) {
  state.externalResets ||= { initialized: false, seen: {} }
  const feed = state.externalResets
  const events = []
  const pending = []
  for (const record of result.records) {
    if (!record || !["reset_scheduled", "reset_completed"].includes(record.kind)) continue
    const key = record.signalId || record.id
    if (typeof key !== "string" || !key) continue
    const fingerprint = resetFingerprint(record)
    const previous = feed.seen[key]
    const scheduled = record.kind === "reset_scheduled"
    const end = Date.parse(record.scheduleWindow?.endAt || record.effectiveAt)
    const completed = Date.parse(record.completedAt || record.effectiveAt)
    const valid = scheduled ? record.scheduleState === "pending" && Number.isFinite(end) && end > now
      : Number.isFinite(completed) && completed <= now + 60_000 && now - completed <= COMPLETION_MAX_AGE
    feed.seen[key] = fingerprint
    if (!valid) continue
    const item = {
      signalKey: key, signalFingerprint: fingerprint,
      resetType: record.resetType, confidence: record.confidence,
      scope: record.scope,
      effectiveAt: record.effectiveAt, schedulePrecision: record.schedulePrecision,
      scheduleConstraint: record.scheduleConstraint,
      scheduleWindow: record.scheduleWindow, sourceUrl: record.source?.url || "",
      url: "https://didcodexreset.com/zh.html",
      text: String(record.translatedText || record.text || "").slice(0, 1000),
      expiresAt: new Date(scheduled ? end : completed + COMPLETION_MAX_AGE).toISOString(),
    }
    if (scheduled) pending.push(item)
    if (previous === fingerprint) continue
    if (!feed.initialized && (!scheduled || !opts.codexResetUpdates.notifyCurrentPending)) continue
    const event = { ...item, id: randomUUID(), kind: `codex_${record.kind}`, at: new Date(now).toISOString(), updated: !!previous }
    enqueue(state, event, opts, now)
    events.push(event)
  }
  feed.initialized = true
  feed.pending = pending
  feed.generatedAt = result.generatedAt
  return events
}
