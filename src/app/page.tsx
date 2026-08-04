'use client'

import { useEffect, useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  Server, Wifi, WifiOff, Search, Download, Trash2, Activity,
  Clock, Cpu, BookOpen, Tv, Package, Loader2, RefreshCw, Globe
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'

import { useBridgeStore, type AniyomiExtension, type CloudStreamProvider, type KotatsuExtension } from '@/stores/bridge-store'

// ─── Helper: format uptime ─────────────────────────────
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ─── Skeleton Loaders ───────────────────────────────────
function StatCardSkeleton() {
  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-28" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ExtensionCardSkeleton() {
  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Skeleton className="h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-2 min-w-0">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-full" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Stat Card ───────────────────────────────────────────
function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType
  label: string
  value: string
  color: string
}) {
  return (
    <Card className="border-border/50 transition-shadow hover:shadow-md">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${color}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground font-medium truncate">{label}</p>
            <p className="text-sm font-semibold truncate">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Extension Card ──────────────────────────────────────
function AniyomiExtCard({ ext }: { ext: AniyomiExtension }) {
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)

  const handleUninstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ext.pkgName) return
    setUninstalling(true)
    try {
      const res = await fetch('/api/bridge/api/aniyomi/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pkgName: ext.pkgName })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Uninstalled ${ext.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Uninstall failed')
      }
    } catch {
      toast.error('Failed to uninstall extension')
    } finally {
      setUninstalling(false)
    }
  }

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ext.downloadUrl) {
      toast.error('No download URL available')
      return
    }
    setInstalling(true)
    try {
      const res = await fetch('/api/bridge/api/aniyomi/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl: ext.downloadUrl, pkgName: ext.pkgName })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Installed ${ext.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Install failed')
      }
    } catch {
      toast.error('Failed to install extension')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Card className="border-border/50 transition-all hover:shadow-md group">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            {ext.iconUrl && <AvatarImage src={ext.iconUrl} alt={ext.name} />}
            <AvatarFallback className="bg-emerald-100 text-emerald-700 text-sm font-semibold">
              {ext.name?.charAt(0)?.toUpperCase() || '?'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold truncate leading-tight">{ext.name}</h3>
              <div className="flex gap-1 shrink-0">
                {ext.downloadUrl && !ext.versionName && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                    onClick={handleInstall}
                    disabled={installing}
                  >
                    {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {ext.versionName && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-rose-500 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleUninstall}
                    disabled={uninstalling}
                  >
                    {uninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{ext.pkgName}</p>
            {ext.baseUrl && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                <Globe className="h-3 w-3 shrink-0" />
                {ext.baseUrl}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {ext.lang && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-medium">
                  {ext.lang.toUpperCase()}
                </Badge>
              )}
              <Badge variant={ext.isAnime ? "default" : "outline"} className="text-[10px] px-1.5 py-0 h-5">
                {ext.isAnime ? (
                  <span className="flex items-center gap-0.5"><Tv className="h-2.5 w-2.5" />Anime</span>
                ) : (
                  <span className="flex items-center gap-0.5"><BookOpen className="h-2.5 w-2.5" />Manga</span>
                )}
              </Badge>
              {ext.isNsfw && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-5">18+</Badge>
              )}
              {ext.versionName && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-emerald-600 border-emerald-200 bg-emerald-50">
                  v{ext.versionName}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CloudStreamProviderCard({ provider }: { provider: CloudStreamProvider }) {
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)

  const handleUninstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!provider.apiName) return
    setUninstalling(true)
    try {
      const res = await fetch('/api/bridge/api/cloudstream/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiName: provider.apiName })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Uninstalled ${provider.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Uninstall failed')
      }
    } catch {
      toast.error('Failed to uninstall provider')
    } finally {
      setUninstalling(false)
    }
  }

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!provider.downloadUrl) {
      toast.error('No download URL available')
      return
    }
    setInstalling(true)
    try {
      const res = await fetch('/api/bridge/api/cloudstream/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl: provider.downloadUrl, fileName: provider.name })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Installed ${provider.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Install failed')
      }
    } catch {
      toast.error('Failed to install provider')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Card className="border-border/50 transition-all hover:shadow-md group">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            {provider.iconUrl && <AvatarImage src={provider.iconUrl} alt={provider.name} />}
            <AvatarFallback className="bg-amber-100 text-amber-700 text-sm font-semibold">
              {provider.name?.charAt(0)?.toUpperCase() || '?'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold truncate leading-tight">{provider.name}</h3>
              <div className="flex gap-1 shrink-0">
                {provider.downloadUrl && !provider.version && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                    onClick={handleInstall}
                    disabled={installing}
                  >
                    {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {provider.version && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-rose-500 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleUninstall}
                    disabled={uninstalling}
                  >
                    {uninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{provider.apiName}</p>
            {provider.mainUrl && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                <Globe className="h-3 w-3 shrink-0" />
                {provider.mainUrl}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {provider.lang && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-medium">
                  {provider.lang.toUpperCase()}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                <span className="flex items-center gap-0.5"><Tv className="h-2.5 w-2.5" />Stream</span>
              </Badge>
              {provider.version && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-emerald-600 border-emerald-200 bg-emerald-50">
                  v{provider.version}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function KotatsuExtCard({ ext }: { ext: KotatsuExtension }) {
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)

  const handleUninstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ext.sourceId) return
    setUninstalling(true)
    try {
      const res = await fetch('/api/bridge/api/kotatsu/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: ext.sourceId })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Uninstalled ${ext.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Uninstall failed')
      }
    } catch {
      toast.error('Failed to uninstall extension')
    } finally {
      setUninstalling(false)
    }
  }

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ext.downloadUrl) {
      toast.error('No download URL available')
      return
    }
    setInstalling(true)
    try {
      const res = await fetch('/api/bridge/api/kotatsu/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl: ext.downloadUrl, sourceId: ext.sourceId })
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Installed ${ext.name}`)
        window.location.reload()
      } else {
        toast.error(data.error || 'Install failed')
      }
    } catch {
      toast.error('Failed to install extension')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Card className="border-border/50 transition-all hover:shadow-md group">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            {ext.iconUrl && <AvatarImage src={ext.iconUrl} alt={ext.name} />}
            <AvatarFallback className="bg-violet-100 text-violet-700 text-sm font-semibold">
              {ext.name?.charAt(0)?.toUpperCase() || '?'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold truncate leading-tight">{ext.name}</h3>
              <div className="flex gap-1 shrink-0">
                {ext.downloadUrl && !ext.version && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                    onClick={handleInstall}
                    disabled={installing}
                  >
                    {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {ext.version && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-rose-500 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleUninstall}
                    disabled={uninstalling}
                  >
                    {uninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Source #{ext.sourceId}</p>
            {ext.baseUrl && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                <Globe className="h-3 w-3 shrink-0" />
                {ext.baseUrl}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {ext.lang && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-medium">
                  {ext.lang.toUpperCase()}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                <span className="flex items-center gap-0.5"><BookOpen className="h-2.5 w-2.5" />Manga</span>
              </Badge>
              {ext.isNsfw && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-5">18+</Badge>
              )}
              {ext.version && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-emerald-600 border-emerald-200 bg-emerald-50">
                  v{ext.version}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Empty State ─────────────────────────────────────────
function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Package className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

// ─── Main Dashboard ──────────────────────────────────────
export default function Dashboard() {
  const store = useBridgeStore()
  const [urlInput, setUrlInput] = useState('')
  const [connecting, setConnecting] = useState(false)

  // Search state
  const [searchType, setSearchType] = useState('aniyomi')
  const [searchSourceId, setSearchSourceId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)

  // Load saved config on mount
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/bridge-config')
      const data = await res.json()
      if (data.success && data.data) {
        if (data.data.serverUrl) {
          store.setServerUrl(data.data.serverUrl)
          setUrlInput(data.data.serverUrl)
          store.setIsConnected(true)
        }
      }
    } catch {
      // Config not available yet
    }
  }, [store])

  // Fetch health data
  const fetchHealth = useCallback(async () => {
    if (!store.isConnected) return
    store.setHealthLoading(true)
    try {
      const res = await fetch('/api/bridge/api/health')
      const data = await res.json()
      if (data.success && data.data) {
        store.setHealth(data.data)
      } else {
        store.setHealth(null)
      }
    } catch {
      store.setHealth(null)
    } finally {
      store.setHealthLoading(false)
    }
  }, [store.isConnected, store])

  // Fetch extensions
  const fetchExtensions = useCallback(async () => {
    if (!store.isConnected) return
    store.setExtensionsLoading(true)
    try {
      const [aniyomiRes, csRes, kotatsuRes] = await Promise.allSettled([
        fetch('/api/bridge/api/aniyomi/extensions').then(r => r.json()),
        fetch('/api/bridge/api/cloudstream/providers').then(r => r.json()),
        fetch('/api/bridge/api/kotatsu/extensions').then(r => r.json()),
      ])

      if (aniyomiRes.status === 'fulfilled' && aniyomiRes.value.success) {
        store.setAniyomiExtensions(aniyomiRes.value.data || [])
      }
      if (csRes.status === 'fulfilled' && csRes.value.success) {
        store.setCsProviders(csRes.value.data || [])
      }
      if (kotatsuRes.status === 'fulfilled' && kotatsuRes.value.success) {
        store.setKotatsuExtensions(kotatsuRes.value.data || [])
      }
    } catch {
      // silently fail
    } finally {
      store.setExtensionsLoading(false)
    }
  }, [store.isConnected, store])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (store.isConnected) {
      fetchHealth()
      fetchExtensions()
    } else {
      store.setHealth(null)
      store.setAniyomiExtensions([])
      store.setCsProviders([])
      store.setKotatsuExtensions([])
    }
  }, [store.isConnected])

  // Connect handler
  const handleConnect = async () => {
    const url = urlInput.trim()
    if (!url) {
      toast.error('Please enter a server URL')
      return
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      toast.error('URL must start with http:// or https://')
      return
    }
    setConnecting(true)
    try {
      // First save and activate
      const configRes = await fetch('/api/bridge-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: url, action: 'connect' })
      })
      const configData = await configRes.json()
      if (!configData.success) {
        toast.error(configData.error || 'Failed to save configuration')
        setConnecting(false)
        return
      }

      // Test the connection
      const healthRes = await fetch('/api/bridge/api/health')
      const healthData = await healthRes.json()
      if (healthData.success) {
        store.setServerUrl(url)
        store.setIsConnected(true)
        store.setHealth(healthData.data)
        toast.success('Connected to bridge server!')
        // Fetch extensions after successful connection
        fetchExtensions()
      } else {
        toast.error(healthData.error || 'Server responded with an error')
        // Still activate but warn
        store.setServerUrl(url)
        store.setIsConnected(true)
      }
    } catch {
      toast.error('Failed to connect. Check the server URL and try again.')
    } finally {
      setConnecting(false)
    }
  }

  // Disconnect handler
  const handleDisconnect = async () => {
    try {
      await fetch('/api/bridge-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: store.serverUrl, action: 'disconnect' })
      })
    } catch {
      // ignore
    }
    store.setIsConnected(false)
    store.setHealth(null)
    store.setAniyomiExtensions([])
    store.setCsProviders([])
    store.setKotatsuExtensions([])
    store.setSearchResults([])
    toast.info('Disconnected from bridge server')
  }

  // Refresh handler
  const handleRefresh = () => {
    fetchHealth()
    fetchExtensions()
    toast.success('Refreshing data...')
  }

  // Search handler
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      toast.error('Please enter a search query')
      return
    }

    setSearching(true)
    store.setSearchResults([])

    try {
      let endpoint = ''
      let body: Record<string, unknown> = { query: searchQuery.trim(), page: 1 }

      if (searchType === 'aniyomi') {
        if (!searchSourceId) {
          toast.error('Please select an extension')
          setSearching(false)
          return
        }
        const ext = store.aniyomiExtensions.find(e => String(e.sourceId) === searchSourceId)
        endpoint = '/api/bridge/api/aniyomi/search'
        body.sourceId = Number(searchSourceId)
        body.isAnime = ext?.isAnime ?? true
      } else if (searchType === 'cloudstream') {
        if (!searchSourceId) {
          toast.error('Please select a provider')
          setSearching(false)
          return
        }
        endpoint = '/api/bridge/api/cloudstream/search'
        body.apiName = searchSourceId
      } else if (searchType === 'kotatsu') {
        if (!searchSourceId) {
          toast.error('Please select an extension')
          setSearching(false)
          return
        }
        endpoint = '/api/bridge/api/kotatsu/search'
        body.sourceId = Number(searchSourceId)
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()

      if (data.success) {
        const results = data.data || []
        store.setSearchResults(Array.isArray(results) ? results : (results.list || []))
        if (Array.isArray(results) ? results.length === 0 : (results.list || []).length === 0) {
          toast.info('No results found')
        }
      } else {
        toast.error(data.error || 'Search failed')
      }
    } catch {
      toast.error('Search request failed')
    } finally {
      setSearching(false)
    }
  }

  // Compute totals
  const totalExtensions =
    (store.health?.aniyomiExtensionCount || 0) +
    (store.health?.csProviderCount || 0) +
    (store.health?.kotatsuExtensionCount || 0)

  const animeExts = store.aniyomiExtensions.filter(e => e.isAnime)
  const mangaExts = store.aniyomiExtensions.filter(e => !e.isAnime)

  // Search source options
  const searchSourceOptions = searchType === 'aniyomi'
    ? store.aniyomiExtensions.map(e => ({ value: String(e.sourceId), label: e.name }))
    : searchType === 'cloudstream'
      ? store.csProviders.map(p => ({ value: p.apiName, label: p.name }))
      : store.kotatsuExtensions.map(e => ({ value: String(e.sourceId), label: e.name }))

  return (
    <div className="min-h-screen bg-background">
      {/* ─── Header / Config Bar ──────────────────── */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 py-3 sm:py-4">
            {/* Title + Status */}
            <div className="flex items-center gap-2.5 shrink-0 w-full sm:w-auto">
              <div className="p-1.5 rounded-lg bg-primary text-primary-foreground">
                <Server className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm sm:text-base font-bold tracking-tight truncate">
                  AnymeX Bridge Server
                </h1>
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${store.isConnected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-rose-400'}`} />\n                  <span className="text-[11px] text-muted-foreground">
                    {store.isConnected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
              </div>
            </div>

            {/* URL Input + Buttons */}
            <div className="flex items-center gap-2 flex-1 w-full sm:w-auto sm:max-w-md">
              <Input
                placeholder="http://your-server:8080"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !store.isConnected && handleConnect()}
                className="h-9 text-sm flex-1"
                disabled={connecting}
              />
              {store.isConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 shrink-0 text-rose-600 border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                  onClick={handleDisconnect}
                >
                  <WifiOff className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Disconnect</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-9 gap-1.5 shrink-0"
                  onClick={handleConnect}
                  disabled={connecting}
                >
                  {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">Connect</span>
                </Button>
              )}
              {store.isConnected && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={handleRefresh}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* ─── Not Connected State ──────────────────── */}
        {!store.isConnected && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="p-4 rounded-2xl bg-muted/50 mb-6">
              <Server className="h-12 w-12 text-muted-foreground/50" />
            </div>
            <h2 className="text-xl font-semibold mb-2">No Bridge Server Connected</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Enter your AnymeX JVM Bridge Server URL above and click Connect to start managing your extensions.
            </p>
          </div>
        )}

        {/* ─── Connected State ──────────────────── */}
        {store.isConnected && (
          <>
            {/* ─── Health Stats ──────────────── */}
            <section aria-label="Server Health Statistics">
              {store.healthLoading && !store.health ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                </div>
              ) : store.health ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <StatCard
                    icon={Cpu}
                    label="JVM Version"
                    value={store.health.jvmVersion || 'Unknown'}
                    color="bg-zinc-100 text-zinc-700"
                  />
                  <StatCard
                    icon={Clock}
                    label="Uptime"
                    value={formatUptime(store.health.uptime)}
                    color="bg-amber-100 text-amber-700"
                  />
                  <StatCard
                    icon={Package}
                    label="Total Extensions"
                    value={`${totalExtensions} installed`}
                    color="bg-emerald-100 text-emerald-700"
                  />
                  <StatCard
                    icon={Activity}
                    label="Server Status"
                    value={store.health.status || 'Running'}
                    color="bg-emerald-100 text-emerald-700"
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <StatCard icon={Cpu} label="JVM Version" value="—" color="bg-zinc-100 text-zinc-400" />
                  <StatCard icon={Clock} label="Uptime" value="—" color="bg-zinc-100 text-zinc-400" />
                  <StatCard icon={Package} label="Total Extensions" value="—" color="bg-zinc-100 text-zinc-400" />
                  <StatCard icon={Activity} label="Server Status" value="Unreachable" color="bg-rose-100 text-rose-600" />
                </div>
              )}

              {/* OS Info row */}
              {store.health && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" /> {store.health.osName || 'Unknown OS'}
                  </span>
                  {store.health.javaVersion && (
                    <span className="font-mono">Java {store.health.javaVersion}</span>
                  )}
                </div>
              )}
            </section>

            {/* ─── Extensions Tabs ──────────── */}
            <section aria-label="Extensions">
              <Tabs value={store.activeTab} onValueChange={store.setActiveTab}>
                <TabsList className="w-full sm:w-auto grid grid-cols-3 sm:inline-flex">
                  <TabsTrigger value="aniyomi" className="gap-1.5 text-xs sm:text-sm">
                    <Tv className="h-3.5 w-3.5" />
                    Aniyomi
                    {store.aniyomiExtensions.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5 text-[10px]">
                        {store.aniyomiExtensions.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="cloudstream" className="gap-1.5 text-xs sm:text-sm">
                    <Activity className="h-3.5 w-3.5" />
                    CloudStream
                    {store.csProviders.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5 text-[10px]">
                        {store.csProviders.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="kotatsu" className="gap-1.5 text-xs sm:text-sm">
                    <BookOpen className="h-3.5 w-3.5" />
                    Kotatsu
                    {store.kotatsuExtensions.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5 text-[10px]">
                        {store.kotatsuExtensions.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>

                {/* Aniyomi Tab */}
                <TabsContent value="aniyomi" className="mt-4">
                  {store.extensionsLoading && store.aniyomiExtensions.length === 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <ExtensionCardSkeleton key={i} />
                      ))}
                    </div>
                  ) : (
                    <>
                      {/* Anime section */}
                      {animeExts.length > 0 && (
                        <div className="mb-6">
                          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Tv className="h-3.5 w-3.5" />
                            Anime Sources ({animeExts.length})
                          </h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {animeExts.map((ext) => (
                              <AniyomiExtCard key={ext.pkgName || ext.sourceId} ext={ext} />
                            ))}
                          </div>
                        </div>
                      )}
                      {/* Manga section */}
                      {mangaExts.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <BookOpen className="h-3.5 w-3.5" />
                            Manga Sources ({mangaExts.length})
                          </h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {mangaExts.map((ext) => (
                              <AniyomiExtCard key={ext.pkgName || ext.sourceId} ext={ext} />
                            ))}
                          </div>
                        </div>
                      )}
                      {store.aniyomiExtensions.length === 0 && (
                        <EmptyState message="No Aniyomi extensions found on the server." />
                      )}
                    </>
                  )}
                </TabsContent>

                {/* CloudStream Tab */}
                <TabsContent value="cloudstream" className="mt-4">
                  {store.extensionsLoading && store.csProviders.length === 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <ExtensionCardSkeleton key={i} />
                      ))}
                    </div>
                  ) : store.csProviders.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {store.csProviders.map((provider) => (
                        <CloudStreamProviderCard key={provider.apiName} provider={provider} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState message="No CloudStream providers found on the server." />
                  )}
                </TabsContent>

                {/* Kotatsu Tab */}
                <TabsContent value="kotatsu" className="mt-4">
                  {store.extensionsLoading && store.kotatsuExtensions.length === 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <ExtensionCardSkeleton key={i} />
                      ))}
                    </div>
                  ) : store.kotatsuExtensions.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {store.kotatsuExtensions.map((ext) => (
                        <KotatsuExtCard key={ext.sourceId} ext={ext} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState message="No Kotatsu extensions found on the server." />
                  )}
                </TabsContent>
              </Tabs>
            </section>

            {/* ─── Quick Search / Test Panel ──── */}
            <section aria-label="Extension Search">
              <Card className="border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    Quick Search &amp; Test
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    {/* Extension Type */}
                    <Select value={searchType} onValueChange={(v) => {
                      setSearchType(v)
                      setSearchSourceId('')
                    }}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Extension Type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="aniyomi">Aniyomi</SelectItem>
                        <SelectItem value="cloudstream">CloudStream</SelectItem>
                        <SelectItem value="kotatsu">Kotatsu</SelectItem>
                      </SelectContent>
                    </Select>

                    {/* Specific Extension */}
                    <Select value={searchSourceId} onValueChange={setSearchSourceId}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="Select extension..." />
                      </SelectTrigger>
                      <SelectContent>
                        {searchSourceOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                        {searchSourceOptions.length === 0 && (
                          <SelectItem value="_none" disabled>
                            No extensions available
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>

                    {/* Search Input */}
                    <Input
                      placeholder="Search query..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      className="h-9 text-sm sm:col-span-1"
                    />

                    {/* Search Button */}
                    <Button
                      onClick={handleSearch}
                      disabled={searching || !searchSourceId || !searchQuery.trim()}
                      className="h-9 gap-1.5"
                    >
                      {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                      Search
                    </Button>
                  </div>

                  {/* Search Results */}
                  {store.searchResults.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        Results ({store.searchResults.length})
                      </h4>
                      <ScrollArea className="max-h-96">
                        <div className="space-y-2 pr-4">
                          {store.searchResults.map((result, idx) => (
                            <Card key={idx} className="border-border/40">
                              <CardContent className="p-3">
                                <div className="flex items-start gap-3">
                                  {result.imageUrl && (
                                    <img
                                      src={result.imageUrl}
                                      alt=""
                                      className="h-16 w-12 object-cover rounded shrink-0 bg-muted"
                                    />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <h5 className="text-sm font-medium truncate">{result.name || 'Untitled'}</h5>
                                    {result.url && (
                                      <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">
                                        {result.url}
                                      </p>
                                    )}
                                    {result.type && (
                                      <Badge variant="secondary" className="text-[10px] mt-1.5 h-5">
                                        {result.type}
                                      </Badge>
                                    )}
                                    {result.author && (
                                      <p className="text-xs text-muted-foreground mt-1">By {result.author}</p>
                                    )}
                                    {result.genre && result.genre.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-1.5">
                                        {result.genre.slice(0, 5).map((g, gi) => (
                                          <Badge key={gi} variant="outline" className="text-[10px] h-5 px-1.5">
                                            {String(g)}
                                          </Badge>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
