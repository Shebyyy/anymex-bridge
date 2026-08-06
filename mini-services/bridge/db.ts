import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DATA_DIR = join(import.meta.dir, '..', 'data')
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(join(DATA_DIR, 'bridge.db'), { create: true })
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA foreign_keys=ON')

// ── Schema ──────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  url      TEXT UNIQUE NOT NULL,
  type     TEXT NOT NULL CHECK(type IN ('aniyomi-anime','aniyomi-manga','cloudstream','kotatsu')),
  added_by TEXT REFERENCES users(id),
  created  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extensions (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,
  repo_id   TEXT REFERENCES repos(id) ON DELETE CASCADE,
  version   TEXT,
  icon_url  TEXT,
  lang      TEXT,
  is_nsfw   INTEGER DEFAULT 0,
  file_path TEXT,
  extra     TEXT  -- JSON blob for type-specific fields
);

CREATE TABLE IF NOT EXISTS user_extensions (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext_id   TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, ext_id)
);
`)

// ── Helpers ─────────────────────────────────────────────
const userStmt = db.prepare('SELECT * FROM users WHERE username = ?')
const userIdStmt = db.prepare('SELECT * FROM users WHERE id = ?')
const createUserStmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')

const allReposStmt = db.prepare('SELECT r.*, u.username as added_by_name FROM repos r LEFT JOIN users u ON r.added_by = u.id ORDER BY r.created DESC')
const repoByUrlStmt = db.prepare('SELECT * FROM repos WHERE url = ?')
const addRepoStmt = db.prepare('INSERT INTO repos (url, type, added_by) VALUES (?, ?, ?)')
const deleteRepoStmt = db.prepare('DELETE FROM repos WHERE url = ?')

const extByIdStmt = db.prepare('SELECT * FROM extensions WHERE id = ?')
const allExtsStmt = db.prepare('SELECT * FROM extensions ORDER BY name')
const extsByTypeStmt = db.prepare('SELECT * FROM extensions WHERE type = ? ORDER BY name')
const upsertExtStmt = db.prepare(`
  INSERT INTO extensions (id, name, type, repo_id, version, icon_url, lang, is_nsfw, file_path, extra)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, version = excluded.version, icon_url = excluded.icon_url,
    lang = excluded.lang, is_nsfw = excluded.is_nsfw, extra = excluded.extra
`)

const userInstalledStmt = db.prepare(`
  SELECT e.* FROM user_extensions ue JOIN extensions e ON ue.ext_id = e.id WHERE ue.user_id = ?
`)
const userInstalledByTypeStmt = db.prepare(`
  SELECT e.* FROM user_extensions ue JOIN extensions e ON ue.ext_id = e.id
  WHERE ue.user_id = ? AND e.type = ?
`)
const isInstalledStmt = db.prepare('SELECT 1 FROM user_extensions WHERE user_id = ? AND ext_id = ?')
const installStmt = db.prepare('INSERT OR IGNORE INTO user_extensions (user_id, ext_id) VALUES (?, ?)')
const uninstallStmt = db.prepare('DELETE FROM user_extensions WHERE user_id = ? AND ext_id = ?')
const extUserCountStmt = db.prepare('SELECT COUNT(*) as cnt FROM user_extensions WHERE ext_id = ?')

// ── Public API ──────────────────────────────────────────

export function authenticateUser(username: string, password: string) {
  const user = userStmt.get(username) as any
  if (!user) return null
  // For now: plain text comparison. Add bcrypt later if needed.
  if (user.password !== password) return null
  return user
}

export function createUser(username: string, password: string) {
  if (username.length < 3 || password.length < 4) throw new Error('username (3+) and password (4+) required')
  const existing = userStmt.get(username)
  if (existing) throw new Error('username taken')
  createUserStmt.run(username, password)
  return userStmt.get(username) as any
}

export function listUsers() {
  return db.query('SELECT id, username, (SELECT COUNT(*) FROM user_extensions WHERE user_id = users.id) as ext_count FROM users').all() as any[]
}

export function listRepos() {
  return allReposStmt.all() as any[]
}

export function getRepoByUrl(url: string) {
  return (repoByUrlStmt.get(url) as any) || null
}

export function addRepo(url: string, type: string, userId: string) {
  const existing = repoByUrlStmt.get(url)
  if (existing) return existing as any
  const result = addRepoStmt.run(url, type, userId)
  return db.query('SELECT * FROM repos WHERE id = ?').get(result.lastInsertRowid) as any
}

export function removeRepo(url: string) {
  deleteRepoStmt.run(url)
}

export function getExtension(id: string) {
  return (extByIdStmt.get(id) as any) || null
}

export function listExtensions(type?: string) {
  return (type ? extsByTypeStmt.all(type) : allExtsStmt.all()) as any[]
}

export function upsertExtension(ext: {
  id: string; name: string; type: string; repo_id?: string;
  version?: string; icon_url?: string; lang?: string; is_nsfw?: boolean;
  file_path?: string; extra?: any;
}) {
  upsertExtStmt.run(
    ext.id, ext.name, ext.type, ext.repo_id ?? null,
    ext.version ?? null, ext.icon_url ?? null, ext.lang ?? null,
    ext.is_nsfw ? 1 : 0, ext.file_path ?? null,
    ext.extra ? JSON.stringify(ext.extra) : null
  )
}

export function listInstalledForUser(userId: string, type?: string) {
  return (type ? userInstalledByTypeStmt.all(userId, type) : userInstalledStmt.all(userId)) as any[]
}

export function isInstalledForUser(userId: string, extId: string): boolean {
  return !!isInstalledStmt.get(userId, extId)
}

export function installForUser(userId: string, extId: string) {
  installStmt.run(userId, extId)
}

export function uninstallForUser(userId: string, extId: string) {
  uninstallStmt.run(userId, extId)
}

export function getExtUserCount(extId: string): number {
  return (extUserCountStmt.get(extId) as any).cnt
}

export { db }
