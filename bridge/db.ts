import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DIR = join(import.meta.dir, 'data')
mkdirSync(DIR, { recursive: true })

export const db = new Database(join(DIR, 'bridge.db'))
db.exec('PRAGMA journal_mode=WAL')

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created TEXT DEFAULT (datetime('now'))
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

export function getAllUsers() {
  return db.query('SELECT id, username, created FROM users ORDER BY username').all() as any[]
}
