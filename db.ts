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
    CREATE TABLE IF NOT EXISTS user_ips (
      user_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      last_seen TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, ip)
    );
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip TEXT PRIMARY KEY,
      banned_by TEXT,
      reason TEXT DEFAULT '',
      created TEXT DEFAULT (datetime('now'))
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

// ── IP tracking & banning ──

/** Record (or update last_seen for) an IP used by a user */
export function recordUserIP(userId: string, ip: string) {
  if (!ip || ip === '' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return
  db.run(
    'INSERT INTO user_ips (user_id, ip, last_seen) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = datetime(\'now\')',
    [userId, ip]
  )
}

/** Get all IPs ever used by a user */
export function getUserIPs(userId: string): string[] {
  return (db.query('SELECT ip FROM user_ips WHERE user_id = ?').all(userId) as any[]).map(r => r.ip)
}

/** Check if an IP is banned */
export function isIPBanned(ip: string): boolean {
  if (!ip || ip === '' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return false
  const row = db.query('SELECT 1 FROM banned_ips WHERE ip = ?').get(ip)
  return !!row
}

/** Ban a single IP (optionally with reason) */
export function banIP(ip: string, bannedBy?: string, reason?: string) {
  if (!ip || ip === '' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return
  db.run(
    'INSERT OR REPLACE INTO banned_ips (ip, banned_by, reason, created) VALUES (?, ?, ?, datetime(\'now\'))',
    [ip, bannedBy || 'admin', reason || '']
  )
}

/** Unban a single IP */
export function unbanIP(ip: string) {
  db.run('DELETE FROM banned_ips WHERE ip = ?', [ip])
}

/** Ban ALL IPs associated with a user (called when banning a user) */
export function banAllUserIPs(userId: string, bannedBy?: string) {
  const ips = getUserIPs(userId)
  for (const ip of ips) {
    banIP(ip, bannedBy || 'auto-ban', `User banned — all associated IPs`)
  }
  return ips
}

/** Unban all IPs associated with a user (called when unbanning a user) */
export function unbanAllUserIPs(userId: string) {
  const ips = getUserIPs(userId)
  for (const ip of ips) {
    unbanIP(ip)
  }
  return ips
}

/** Get all banned IPs */
export function getAllBannedIPs() {
  return db.query('SELECT * FROM banned_ips ORDER BY created DESC').all() as any[]
}

/** Get banned IP count */
export function getBannedIPCount(): number {
  return (db.query('SELECT COUNT(*) as c FROM banned_ips').get() as any)?.c ?? 0
}

/** Get users sharing an IP (useful for admin to see who else uses same IP) */
export function getUsersByIP(ip: string) {
  return db.query(`
    SELECT u.id, u.username, u.banned, ui.last_seen
    FROM user_ips ui JOIN users u ON u.id = ui.user_id
    WHERE ui.ip = ? ORDER BY ui.last_seen DESC
  `, ip).all() as any[]
}

export function clearDatabase() {
  db.run('DELETE FROM user_installed')
  db.run('DELETE FROM user_ips')
  db.run('DELETE FROM banned_ips')
  db.run('DELETE FROM users')
}
