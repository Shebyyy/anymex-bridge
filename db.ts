import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DIR = join(import.meta.dir, 'data')
mkdirSync(DIR, { recursive: true })

export const db = new Database(join(DIR, 'bridge.db'))
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA foreign_keys=ON')

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      created TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_installed (
      user_id TEXT NOT NULL,
      pkg_name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'aniyomi',
      name TEXT,
      icon_url TEXT,
      version TEXT,
      PRIMARY KEY (user_id, pkg_name)
    );
  `)
  // Migrate: add banned column if missing
  try { db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0') } catch {}
}

// ── User auth ──

export function createUser(username: string, password: string): { ok: boolean; error?: string; user?: { id: string; username: string } } {
  const existing = db.query('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) return { ok: false, error: 'username already exists' }

  const id = crypto.randomUUID()
  db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [id, username, password])
  return { ok: true, user: { id, username } }
}

export function authenticateUser(username: string, password: string): { id: string; username: string; banned?: number } | null {
  return db.query('SELECT id, username, banned FROM users WHERE username = ? AND password = ?').get(username, password) as any || null
}

export function getAllUsers() {
  return db.query('SELECT id, username, banned, created FROM users ORDER BY username').all() as any[]
}

// ── User management ──

export function banUser(userId: string, banned: boolean) {
  db.run('UPDATE users SET banned = ? WHERE id = ?', [banned ? 1 : 0, userId])
}

export function changePassword(userId: string, password: string) {
  db.run('UPDATE users SET password = ? WHERE id = ?', [password, userId])
}

export function editUsername(userId: string, username: string): { ok: boolean; error?: string } {
  const existing = db.query('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId)
  if (existing) return { ok: false, error: 'username already taken' }
  db.run('UPDATE users SET username = ? WHERE id = ?', [username, userId])
  return { ok: true }
}

export function deleteAllUsers() {
  db.run('DELETE FROM user_installed')
  db.run('DELETE FROM users')
}

export function getUserById(userId: string) {
  return db.query('SELECT id, username, banned, created FROM users WHERE id = ?').get(userId) as any || null
}

// ── User installed extensions (v2) ──

export function addUserInstalled(userId: string, pkgName: string, type: string, name?: string, iconUrl?: string, version?: string) {
  db.run(
    'INSERT OR REPLACE INTO user_installed (user_id, pkg_name, type, name, icon_url, version) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, pkgName, type, name || pkgName, iconUrl || null, version || null]
  )
}

export function removeUserInstalled(userId: string, pkgName: string) {
  db.run('DELETE FROM user_installed WHERE user_id = ? AND pkg_name = ?', [userId, pkgName])
}

export function getUserInstalledPkgs(userId: string, type?: string): Set<string> {
  let sql = 'SELECT pkg_name FROM user_installed WHERE user_id = ?'
  const params: any[] = [userId]
  if (type) { sql += ' AND type = ?'; params.push(type) }
  return new Set((db.prepare(sql).all(...params) as any[]).map(r => r.pkg_name))
}

export function countOtherUsersWithPkg(userId: string, pkgName: string): number {
  const row = db.query('SELECT COUNT(*) as c FROM user_installed WHERE pkg_name = ? AND user_id != ?').get(pkgName, userId) as any
  return row?.c ?? 0
}

export function getUserInstalled(userId: string) {
  return db.query('SELECT * FROM user_installed WHERE user_id = ?').all(userId) as any[]
}

export function deleteUserExtensions(userId: string) {
  db.run('DELETE FROM user_installed WHERE user_id = ?', [userId])
}

export function deleteExtensionGlobally(pkgName: string) {
  db.run('DELETE FROM user_installed WHERE pkg_name = ?', [pkgName])
}

export function getAllInstalledExtensions() {
  return db.query(`
    SELECT ui.pkg_name, ui.type, ui.name, ui.version, COUNT(ui.user_id) as install_count,
           GROUP_CONCAT(u.username) as users
    FROM user_installed ui
    JOIN users u ON u.id = ui.user_id
    GROUP BY ui.pkg_name, ui.type
    ORDER BY install_count DESC
  `).all() as any[]
}

export function getPkgUsers(pkgName: string) {
  return db.query(`
    SELECT u.id, u.username, ui.type, ui.name, ui.version
    FROM user_installed ui JOIN users u ON u.id = ui.user_id
    WHERE ui.pkg_name = ?
  `, pkgName).all() as any[]
}

export function getTotalInstalls() {
  return (db.query('SELECT COUNT(*) as c FROM user_installed').get() as any)?.c ?? 0
}

export function clearDatabase() {
  db.run('DELETE FROM user_installed')
  db.run('DELETE FROM users')
}
