import { DatabaseSync } from "node:sqlite"

// Bun 1.4+ and Node 24 provide SQLite without an npm dependency. This
// database stores no quota data; its write transaction is only a process
// mutex around reading JSON state, polling, sending, and saving JSON state.
// The operating system releases it when a host exits or is killed.
export function acquireStateLock(path) {
  const lock = new DatabaseSync(path, { timeout: 0 })
  try {
    lock.exec("CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)")
    lock.exec("BEGIN IMMEDIATE")
    return lock
  } catch (error) {
    lock.close()
    // Another live host is already working. Its next state is read on
    // our next timer tick; contention is not a quota or delivery failure.
    if (error.errcode === 5 || error.errcode === 6) return null
    throw error
  }
}

export function releaseStateLock(lock) {
  try {
    lock.exec("ROLLBACK")
  } finally {
    lock.close()
  }
}
