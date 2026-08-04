import { create } from 'zustand'

export interface HealthData {
  status: string
  jvmVersion: string
  javaVersion: string
  osName: string
  uptime: number
  aniyomiExtensionCount: number
  csProviderCount: number
  kotatsuExtensionCount: number
}

export interface AniyomiExtension {
  name: string
  pkgName: string
  lang: string
  isNsfw: boolean
  isAnime: boolean
  versionName: string
  iconUrl?: string
  baseUrl?: string
  sourceId?: number
  downloadUrl?: string
}

export interface CloudStreamProvider {
  name: string
  apiName: string
  mainUrl?: string
  lang?: string
  version?: string
  iconUrl?: string
  downloadUrl?: string
  type?: string
}

export interface KotatsuExtension {
  name: string
  sourceId: number
  lang: string
  version: string
  isNsfw: boolean
  iconUrl?: string
  baseUrl?: string
  downloadUrl?: string
}

export interface SearchResult {
  name?: string
  url?: string
  imageUrl?: string
  type?: string
  author?: string
  artist?: string
  description?: string
  genre?: string[]
  status?: string
  [key: string]: unknown
}

interface BridgeState {
  // Connection
  isConnected: boolean
  serverUrl: string
  setServerUrl: (url: string) => void
  setIsConnected: (connected: boolean) => void

  // Health
  health: HealthData | null
  healthLoading: boolean
  setHealth: (health: HealthData | null) => void
  setHealthLoading: (loading: boolean) => void

  // Extensions
  aniyomiExtensions: AniyomiExtension[]
  csProviders: CloudStreamProvider[]
  kotatsuExtensions: KotatsuExtension[]
  extensionsLoading: boolean
  setAniyomiExtensions: (exts: AniyomiExtension[]) => void
  setCsProviders: (providers: CloudStreamProvider[]) => void
  setKotatsuExtensions: (exts: KotatsuExtension[]) => void
  setExtensionsLoading: (loading: boolean) => void

  // Search
  searchResults: SearchResult[]
  searchLoading: boolean
  setSearchResults: (results: SearchResult[]) => void
  setSearchLoading: (loading: boolean) => void

  // Active tab
  activeTab: string
  setActiveTab: (tab: string) => void
}

export const useBridgeStore = create<BridgeState>((set) => ({
  // Connection
  isConnected: false,
  serverUrl: '',
  setServerUrl: (url) => set({ serverUrl: url }),
  setIsConnected: (connected) => set({ isConnected: connected }),

  // Health
  health: null,
  healthLoading: false,
  setHealth: (health) => set({ health }),
  setHealthLoading: (loading) => set({ healthLoading: loading }),

  // Extensions
  aniyomiExtensions: [],
  csProviders: [],
  kotatsuExtensions: [],
  extensionsLoading: false,
  setAniyomiExtensions: (exts) => set({ aniyomiExtensions: exts }),
  setCsProviders: (providers) => set({ csProviders: providers }),
  setKotatsuExtensions: (exts) => set({ kotatsuExtensions: exts }),
  setExtensionsLoading: (loading) => set({ extensionsLoading: loading }),

  // Search
  searchResults: [],
  searchLoading: false,
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchLoading: (loading) => set({ searchLoading: loading }),

  // Active tab
  activeTab: 'aniyomi',
  setActiveTab: (tab) => set({ activeTab: tab }),
}))
