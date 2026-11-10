export async function getCards(opts, fetchFn = fetch) {
  const base = new URL(opts.gatewayUrl + "/")
  const headers = opts.gatewayKey ? { authorization: `Bearer ${opts.gatewayKey}` } : {}
  if (opts.readMode === "refresh") {
    // This asks only the quota/usage endpoints; it NEVER sends a model
    // prompt, consumes a Codex reset credit, or activates a usage window.
    const refresh = await fetchFn(new URL("v1/magpie/quotas/refresh", base), {
      method: "POST", headers, signal: AbortSignal.timeout(40_000),
    })
    if (!refresh.ok) throw new Error(`quota refresh HTTP ${refresh.status}`)
    await refresh.arrayBuffer()
  }
  const path = opts.readMode === "refresh" ? "v1/magpie/quotas?kept=1" : "v1/magpie/quotas"
  const response = await fetchFn(new URL(path, base), {
    headers, signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`quota API HTTP ${response.status}`)
  const data = await response.json()
  if (data?.object !== "list" || !Array.isArray(data.data)) throw new Error("unexpected quota API response")
  return data.data
}
