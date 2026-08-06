import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DIR = join(import.meta.dir, 'data')
mkdirSync(DIR, { recursive: true })

export const db = new Database(join(DIR, 'bridge.db'))
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA foreign_keys=ON')

// Schema
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      name TEXT,
      shortname TEXT,
      added TEXT DEFAULT (datetime('now')),
      last_fetched TEXT
    );
    CREATE TABLE IF NOT EXISTS user_repos (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, repo_id)
    );
    CREATE TABLE IF NOT EXISTS extensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pkg TEXT,
      type TEXT NOT NULL,
      version TEXT,
      icon_url TEXT,
      lang TEXT,
      is_nsfw INTEGER DEFAULT 0,
      file_path TEXT,
      file_hash TEXT,
      extra TEXT,
      created TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_extensions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ext_id INTEGER NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      installed TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, ext_id)
    );
  `)
}

export function createUser(username: string, password: string): { ok: boolean; error?: string; user?: { id: string; username: string } } {
  const existing = db.query('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) return { ok: false, error: 'username already exists' }

  const id = crypto.randomUUID()
 db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [id, username, password])
  return { ok: true, user: { id, username } }
}

export function authenticateUser(username: string, password: string): { id: string; username: string } | null {
  return db.query('SELECT id, username FROM users WHERE username = ? AND password = ?').get(username, password) as any || null
}

export function addRepoForUser(userId: string, url: string, type: string, name?: string, shortname?: string): { ok: boolean; error?: string; repo?: { id: number; url: string; type: string } } {
  // upsert repo
  const existing = db.query('SELECT id FROM repos WHERE url = ?').get(url) as any
  let repoId: number
  if (existing) {
    repoId = existing.id
  } else {
    db.run('INSERT INTO repos (url, type, name, shortname) VALUES (?, ?, ?, ?)', [url, type, name || null, shortname || null])
    const row = db.query('SELECT last_insert_rowid() as id').get() as any
    repoId = row.id
  }
  // link to user
  try {
    db.run('INSERT OR IGNORE INTO user_repos (user_id, repo_id) VALUES (?, ?)', [userId, repoId])
  } catch {}
  return { ok: true, repo: { id: repoId, url, type } }
}

export function getUserRepos(userId: string) {
  return db.query(`
    SELECT r.id, r.url, r.type, r.name, r.shortname, r.added, r.last_fetched
    FROM repos r JOIN user_repos ur ON r.id = ur.repo_id
    WHERE ur.user_id = ? ORDER BY r.added DESC
  `).all(userId) as any[]
}

export function upsertExtension(name: string, pkg: string | null, type: string, version: string | null, iconUrl: string | null, lang: string | null, isNsfw: boolean, filePath: string | null, fileHash: string | null, extra: any): number {
  const existing = db.query('SELECT id FROM extensions WHERE pkg = ? OR (pkg IS NULL AND name = ?)').get(pkg, name) as any
  if (existing) {
    db.run(`UPDATE extensions SET name=?, type=?, version=?, icon_url=?, lang=?, is_nsfw=?, file_path=?, file_hash=?, extra=? WHERE id=?`,
      [name, type, version, iconUrl, lang, isNsfw ? 1 : 0, filePath, fileHash, typeof extra === 'string' ? extra : JSON.stringify(extra), existing.id])
    return existing.id
  }
  db.run(`INSERT INTO extensions (name, pkg, type, version, icon_url, lang, is_nsfw, file_path, file_hash, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, pkg, type, version, iconUrl, lang, isNsfw ? 1 : 0, filePath, fileHash, typeof extra === 'string' ? extra : JSON.stringify(extra)])
  const row = db.query('SELECT last_insert_rowid() as id').get() as any
  return row.id
}

export function installExtensionForUser(userId: string, extId: number): boolean {
  try {
    db.run('INSERT OR IGNORE INTO user_extensions (user_id, ext_id) VALUES (?, ?)', [userId, extId])
    return true
  } catch { return false }
}

export function getUserExtensions(userId: string) {
  return db.query(`
    SELECT e.* FROM extensions e
    JOIN user_extensions ue ON e.id = ue.ext_id
    WHERE ue.user_id = ?
  `).all(userId) as any[]
}

export function getAllExtensions() {
  return db.query('SELECT * FROM extensions ORDER BY name').all() as any[]
}

export function getExtension(id: number) {
  return db.query('SELECT * FROM extensions WHERE id = ?').get(id) as any || null
}

export function getAllUsers() {
  return db.query('SELECT id, username, created FROM users ORDER BY username').all() as any[]
}

export function markRepoFetched(repoId: number) {
  db.run("UPDATE repos SET last_fetched = datetime('now') WHERE id = ?", [repoId])
}

export function getStats() {
  return db.query(`SELECT
    (SELECT COUNT(*) FROM users) as users,
    (SELECT COUNT(*) FROM user_repos) as repos,
    (SELECT COUNT(*) FROM extensions) as extensions,
    (SELECT COUNT(*) FROM user_extensions) as installs
  `).get() as any
}
