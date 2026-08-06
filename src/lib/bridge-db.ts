import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const DB_PATH = join(process.cwd(), 'mini-services', 'data', 'bridge.db')
let cachedDb: any = null

export async function getBridgeDb(): Promise<any> {
  if (cachedDb) return cachedDb
  if (!existsSync(DB_PATH)) return null

  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const fileBuffer = readFileSync(DB_PATH)
  const db = new SQL.Database(fileBuffer)
  cachedDb = db
  return db
}

export async function queryBridgeData(section: string, type?: string) {
  const db = await getBridgeDb()
  if (!db) return null

  try {
    switch (section) {
      case 'health': {
        const r = db.exec('SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM repos) as repos, (SELECT COUNT(*) FROM extensions) as extensions, (SELECT COUNT(*) FROM user_extensions) as installs')
        const row = r[0]?.values[0]
        return { users: row?.[0] || 0, repos: row?.[1] || 0, extensions: row?.[2] || 0, installs: row?.[3] || 0, dbPresent: true }
      }

      case 'users': {
        const r = db.exec(`
          SELECT u.id, u.username,
            (SELECT COUNT(*) FROM user_extensions WHERE user_id = u.id) as ext_count,
            (SELECT COUNT(*) FROM repos WHERE added_by = u.id) as repo_count
          FROM users u ORDER BY u.username
        `)
        return sqlResultToObjects(r)
      }

      case 'repos': {
        const r = db.exec(`
          SELECT r.id, r.url, r.type, r.added_by, r.created, u.username as added_by_name,
            (SELECT COUNT(*) FROM extensions WHERE repo_id = r.id) as ext_count
          FROM repos r LEFT JOIN users u ON r.added_by = u.id
          ORDER BY r.created DESC
        `)
        return sqlResultToObjects(r)
      }

      case 'extensions': {
        let sql = `
          SELECT e.id, e.name, e.type, e.version, e.icon_url, e.lang, e.is_nsfw,
            (SELECT COUNT(*) FROM user_extensions WHERE ext_id = e.id) as install_count,
            r.url as repo_url, e.extra
          FROM extensions e LEFT JOIN repos r ON e.repo_id = r.id
        `
        const params: any[] = []
        if (type) {
          sql += ' WHERE e.type = ?'
          params.push(type)
        }
        sql += ' ORDER BY e.name'
        const r = db.exec(sql, params)
        const rows = sqlResultToObjects(r)
        rows.forEach((row: any) => {
          try { row.extra = row.extra ? JSON.parse(row.extra) : null } catch { row.extra = null }
        })
        return rows
      }

      case 'installs': {
        const r = db.exec(`
          SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type
          FROM user_extensions ue
          JOIN users u ON ue.user_id = u.id
          JOIN extensions e ON ue.ext_id = e.id
          ORDER BY u.username, e.name
        `)
        return sqlResultToObjects(r)
      }

      default:
        return null
    }
  } finally {
    // Don't close — keep cached
  }
}

function sqlResultToObjects(result: any[]) {
  if (!result[0]) return []
  const columns = result[0].columns
  return result[0].values.map((row: any[]) => {
    const obj: Record<string, any> = {}
    columns.forEach((col: string, i: number) => { obj[col] = row[i] })
    return obj
  })
}
