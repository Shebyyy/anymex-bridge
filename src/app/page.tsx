'use client'

import { useEffect, useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  Server, Wifi, WifiOff, Users, FolderGit2, Package,
  Activity, Shield, Terminal, RefreshCw, Plus, Trash2,
  UserPlus, Key, Database, Copy, Check
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

// ── Types ──────────────────────────────────────────────

interface HealthData {
  ok: boolean
  jar: boolean
  jarReady: boolean
  ssh: number
  http: number
  users?: number
  repos?: number
  extensions?: number
  installs?: number
}

interface User {
  id: string
  username: string
  ext_count: number
  repo_count: number
}

interface Repo {
  id: string
  url: string
  type: string
  added_by_name: string
  ext_count: number
  created: string
}

interface Extension {
  id: string
  name: string
  type: string
  version: string | null
  icon_url: string | null
  lang: string | null
  is_nsfw: number
  install_count: number
  repo_url: string | null
}

interface Install {
  user_id: string
  username: string
  ext_id: string
  ext_name: string
  type: string
}

// ── Helpers ────────────────────────────────────────────

async function fetchBridge<T>(section: string): Promise<T> {
  const res = await fetch(`/api/bridge-data?section=${section}`)
  if (res.status === 503) throw new Error('Bridge service not running')
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data as T
}

async function fetchProxy<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/bridge?path=${path}`, opts)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data as T
}

const TYPE_COLORS: Record<string, string> = {
  'aniyomi-anime': 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
  'aniyomi-manga': 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  'cloudstream': 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
  'kotatsu': 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20',
}

const TYPE_LABELS: Record<string, string> = {
  'aniyomi-anime': 'Aniyomi Anime',
  'aniyomi-manga': 'Aniyomi Manga',
  'cloudstream': 'CloudStream',
  'kotatsu': 'Kotatsu',
}

// ── Component ──────────────────────────────────────────

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [repos, setRepos] = useState<Repo[]>([])
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [installs, setInstalls] = useState<Install[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [h, u, r, e, i] = await Promise.all([
        fetchBridge<HealthData>('health'),
        fetchBridge<User[]>('users'),
        fetchBridge<Repo[]>('repos'),
        fetchBridge<Extension[]>('extensions'),
        fetchBridge<Install[]>('installs'),
      ])
      setHealth(h)
      setUsers(u)
      setRepos(r)
      setExtensions(e)
      setInstalls(i)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const online = health?.ok && !error

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Server className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">AnymeX Bridge</h1>
            <p className="text-xs text-muted-foreground">SSH + JAR proxy server for iOS users</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={online ? 'default' : 'destructive'} className="text-xs gap-1.5">
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {online ? 'Online' : 'Offline'}
            </Badge>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Error */}
        {error && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-4 flex items-center gap-3">
              <WifiOff className="h-5 w-5 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {loading && !health ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}><CardContent className="p-4"><Skeleton className="h-8 w-20" /></CardContent></Card>
            ))
          ) : (
            <>
              <StatCard icon={<Users className="h-4 w-4" />} label="Users" value={users.length} />
              <StatCard icon={<FolderGit2 className="h-4 w-4" />} label="Repos" value={repos.length} />
              <StatCard icon={<Package className="h-4 w-4" />} label="Extensions" value={extensions.length} />
              <StatCard icon={<Key className="h-4 w-4" />} label="Installs" value={installs.length} />
              <StatCard icon={<Activity className="h-4 w-4" />} label="SSH Port" value={health?.ssh ?? '-'} />
            </>
          )}
        </div>

        {/* Tabs */}
        <Tabs defaultValue="users">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="users" className="gap-1.5"><Users className="h-3.5 w-3.5" /> Users</TabsTrigger>
            <TabsTrigger value="repos" className="gap-1.5"><FolderGit2 className="h-3.5 w-3.5" /> Repos</TabsTrigger>
            <TabsTrigger value="extensions" className="gap-1.5"><Package className="h-3.5 w-3.5" /> Extensions</TabsTrigger>
            <TabsTrigger value="installs" className="gap-1.5"><Key className="h-3.5 w-3.5" /> Installs</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-4">
            <Card>
              <CardHeader className="pb-3 flex-row items-center justify-between">
                <CardTitle className="text-base">Registered Users</CardTitle>
                <RegisterUserForm onRegistered={refresh} />
              </CardHeader>
              <CardContent>
                {users.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No users registered yet</p>
                ) : (
                  <div className="space-y-2">
                    {users.map(u => (
                      <div key={u.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
                          {u.username[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{u.username}</p>
                          <p className="text-xs text-muted-foreground">{u.ext_count} extensions · {u.repo_count} repos</p>
                        </div>
                        <Badge variant="outline" className="text-xs shrink-0">{u.id.slice(0, 8)}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="repos" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Global Repos</CardTitle>
                <CardDescription className="text-xs">One user adds a repo, everyone sees it</CardDescription>
              </CardHeader>
              <CardContent>
                {repos.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No repos added yet. Users add repos via SSH.</p>
                ) : (
                  <div className="space-y-2">
                    {repos.map(r => (
                      <div key={r.id} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                        <FolderGit2 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-mono truncate text-foreground/80">{r.url}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className={`text-xs ${TYPE_COLORS[r.type] || ''}`}>{TYPE_LABELS[r.type] || r.type}</Badge>
                            <span className="text-xs text-muted-foreground">{r.ext_count} extensions</span>
                            {r.added_by_name && <span className="text-xs text-muted-foreground">by {r.added_by_name}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="extensions" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Available Extensions</CardTitle>
                <CardDescription className="text-xs">One file per extension, no duplicates</CardDescription>
              </CardHeader>
              <CardContent>
                {extensions.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No extensions available. Add a repo first.</p>
                ) : (
                  <ScrollArea className="max-h-96">
                    <div className="space-y-1.5">
                      {extensions.map(ext => (
                        <div key={ext.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/30 transition-colors">
                          {ext.icon_url ? (
                            <img src={ext.icon_url} alt="" className="h-6 w-6 rounded" onError={e => (e.currentTarget.style.display = 'none')} />
                          ) : (
                            <div className="h-6 w-6 rounded bg-muted flex items-center justify-center text-xs">📦</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate">{ext.name}</p>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-[10px] ${TYPE_COLORS[ext.type] || ''}`}>{TYPE_LABELS[ext.type] || ext.type}</Badge>
                              {ext.lang && <span className="text-[10px] text-muted-foreground">{ext.lang}</span>}
                              {ext.version && <span className="text-[10px] text-muted-foreground">v{ext.version}</span>}
                            </div>
                          </div>
                          <Badge variant="secondary" className="text-xs shrink-0">{ext.install_count} user{ext.install_count !== 1 ? 's' : ''}</Badge>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="installs" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Install Records</CardTitle>
                <CardDescription className="text-xs">Per-user extension tracking</CardDescription>
              </CardHeader>
              <CardContent>
                {installs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">No installs yet</p>
                ) : (
                  <ScrollArea className="max-h-96">
                    <div className="space-y-1.5">
                      {installs.map(inst => (
                        <div key={`${inst.user_id}-${inst.ext_id}`} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/30 transition-colors">
                          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-primary text-[10px] font-medium">
                            {inst.username[0].toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate">{inst.ext_name}</p>
                          </div>
                          <Badge variant="outline" className={`text-[10px] shrink-0 ${TYPE_COLORS[inst.type] || ''}`}>{TYPE_LABELS[inst.type] || inst.type}</Badge>
                          <span className="text-xs text-muted-foreground shrink-0">{inst.username}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Server Info */}
        {health && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Terminal className="h-4 w-4" /> Server Info
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">SSH Port</p>
                  <p className="font-mono">{health.ssh}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">HTTP Port</p>
                  <p className="font-mono">{health.http}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Runtime JAR</p>
                  <Badge variant={health.jar ? 'default' : 'destructive'} className="text-xs mt-1">
                    {health.jar ? 'Present' : 'Not Found'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">JAR Ready</p>
                  <Badge variant={health.jarReady ? 'default' : 'destructive'} className="text-xs mt-1">
                    {health.jarReady ? 'Ready' : 'Not Running'}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-auto">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>AnymeX Bridge Server v2</span>
          <span>SSH + anymex_desktop_runtime.jar</span>
        </div>
      </footer>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="text-muted-foreground">{icon}</div>
        <div>
          <p className="text-xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function RegisterUserForm({ onRegistered }: { onRegistered: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) return
    setLoading(true)
    try {
      const res = await fetch('/api/bridge?path=/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(`User "${username}" registered`)
        setUsername('')
        setPassword('')
        onRegistered()
      } else {
        toast.error(data.error || 'Registration failed')
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to connect to bridge')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <Input
        placeholder="username"
        value={username}
        onChange={e => setUsername(e.target.value)}
        className="h-8 w-28 text-xs"
        minLength={3}
      />
      <div className="relative">
        <Input
          type={showPass ? 'text' : 'password'}
          placeholder="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="h-8 w-28 text-xs pr-7"
          minLength={4}
        />
        <button
          type="button"
          onClick={() => setShowPass(!showPass)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {showPass ? '🙈' : '👁️'}
        </button>
      </div>
      <Button type="submit" size="sm" className="h-8 text-xs gap-1" disabled={loading}>
        <UserPlus className="h-3 w-3" />
        {loading ? '...' : 'Add'}
      </Button>
    </form>
  )
}
