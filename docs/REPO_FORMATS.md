# Repository Formats

The bridge server auto-detects three different extension repo formats. This doc shows the exact JSON shape of each, with real-world examples.

---

## 1. Aniyomi (yuzono-style bare array)

**Example repo:** `https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json`

The repo URL points to a **bare JSON array** of extension objects. Each object has a `name` prefixed with `Aniyomi:` (anime) or `Tachiyomi:` (manga).

```json
[
  {
    "name": "Aniyomi: AnimeOnsen",
    "pkg": "eu.kanade.tachiyomi.animeextension.all.animeonsen",
    "apk": "aniyomi-all.animeonsen-v14.10.apk",
    "lang": "all",
    "code": 10,
    "version": "14.10",
    "nsfw": 0,
    "sources": [
      {
        "name": "AnimeOnsen",
        "lang": "all",
        "id": "8542735178285060053",
        "baseUrl": "https://www.animeonsen.xyz"
      }
    ]
  },
  {
    "name": "Tachiyomi: AHottie",
    "pkg": "eu.kanade.tachiyomi.extension.all.ahottie",
    "apk": "tachiyomi-all.ahottie-v1.4.3.apk",
    "lang": "all",
    "code": 3,
    "version": "1.4.3",
    "sources": [
      {
        "name": "AHottie",
        "lang": "all",
        "id": "6289731484943315811",
        "baseUrl": "https://ahottie.top"
      }
    ],
    "nsfw": 1
  }
]
```

### Type detection

The runtime (and the bridge) split by **name prefix**:
- `name.startsWith('Aniyomi: ')` → `itemType: 1` (anime)
- `name.startsWith('Tachiyomi: ')` → `itemType: 0` (manga)

So a single yuzono repo URL produces **both** anime and manga extensions. Use `listAvailable(type: 'anime')` or `listAvailable(type: 'manga')` to filter.

### File URL resolution

The repo is structured as:
```
<repo-base>/
├── index.min.json          ← the URL you addRepo()
├── apk/
│   └── aniyomi-all.animetsu-v14.6.apk
└── icon/
    └── eu.kanade.tachiyomi.animeextension.all.animetsu.png
```

The bridge resolves `apk/<file>` for the .apk URL and `icon/<pkg>.png` for the icon URL.

### Known Aniyomi repos

| Repo | URL | Type |
|---|---|---|
| yuzono anime | `https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json` | anime |
| yuzono manga | `https://raw.githubusercontent.com/yuzono/manga-repo/repo/index.min.json` | manga |

---

## 2. Aniyomi / Mangayomi (wrapped format)

Some repos wrap the array in an object with an `extensions` key:

```json
{
  "extensions": [
    {
      "name": "Aniyomi: Animetsu",
      "package": "eu.kanade.tachiyomi.animeextension.all.animetsu",
      "fileName": "aniyomi-all.animetsu-v14.6.apk",
      "version": "14.6",
      "lang": "all",
      "isNsfw": true,
      "type": "anime",
      "sources": [...]
    }
  ]
}
```

The bridge handles this format too — same fields, slightly different key names (`package` vs `pkg`, `fileName` vs `apk`). Type detection still uses the name prefix.

---

## 3. CloudStream (phisher98-style meta-repo)

**Example repo:** `https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/repo/repo.json`

CloudStream uses a **two-level structure**. The top-level `repo.json` is a meta-repo that points to one or more plugin lists:

```json
{
  "name": "CloudStream Phisher Repo",
  "iconUrl": "https://...",
  "pluginLists": [
    "https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/repo/plugins.json"
  ]
}
```

Each `pluginLists` URL returns a **bare JSON array** of plugin objects:

```json
[
  {
    "name": "AllMovieLandProvider",
    "internalName": "AllMovieLandProvider",
    "url": "https://.../AllMovieLandProvider.cs3",
    "jarUrl": "https://.../AllMovieLandProvider.jar",
    "language": "en",
    "tvTypes": ["Movie", "TvSeries", "Anime"],
    "version": 19,
    "iconUrl": "https://...",
    "authors": ["phisher98"]
  },
  {
    "name": "Anichi",
    "internalName": "Anichi",
    "url": "https://.../Anichi.cs3",
    "jarUrl": "https://.../Anichi.jar",
    "language": "en",
    "tvTypes": ["Anime", "Movie"],
    "version": 20,
    "iconUrl": "https://...",
    "authors": ["phisher98"]
  }
]
```

### Type detection

CloudStream plugins are always `itemType: 1` (anime). The runtime's `CloudStreamExtensions.dart` hardcodes `supportsManga: false` and `supportsNovel: false`.

### File URL resolution

Both `url` (.cs3) and `jarUrl` (.jar) are resolved against the plugin list's base URL.

### Install flow (special!)

CloudStream plugins ship with a pre-converted `.jar` (the `jarUrl`), BUT the bridge JAR requires each `.jar` to contain a bridge-format `manifest.json`:

```json
{
  "pluginClassName": "com.AllMovieLandProvider",
  "name": "AllMovieLandProvider",
  "version": "19",
  "authors": ["phisher98"],
  "requires": 1
}
```

The raw CloudStream `.jar` doesn't have this. So the bridge:
1. Downloads the `.cs3` file (it's a ZIP)
2. Extracts `manifest.json` from the `.cs3` to get `pluginClassName`
3. Downloads the `.jar` from `jarUrl`
4. Strips the `.jar`'s existing manifest, injects the bridge-format manifest
5. Saves to `data/exts-jar-cs/<internalName>.jar`
6. Calls `csLoadExtensions` to register the source

### Known CloudStream repos

| Repo | URL |
|---|---|
| phisher98 | `https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/repo/repo.json` |

---

## 4. CloudStream (wrapped format)

Some CloudStream repos wrap the array in an object with a `plugins` key:

```json
{
  "plugins": [
    {
      "name": "Anichi",
      "internalName": "Anichi",
      "url": "https://.../Anichi.cs3",
      "jarUrl": "https://.../Anichi.jar",
      "tvTypes": ["Anime"],
      "version": 20
    }
  ]
}
```

The bridge handles this the same way as the bare-array CloudStream format.

---

## 5. Kotatsu (direct .jar URL)

**Example repo:** `https://github.com/dragonx943/manga-repo/releases/download/c54deeb/vn.jar`

Kotatsu is fundamentally different — the repo URL **IS a direct .jar download**. There's no index.json. The `.jar` is actually an APK containing `classes.dex` with multiple source classes under `org/koitharu/kotatsu/parsers/site/*`.

### Detection

The bridge detects Kotatsu repos by:
- URL ending in `.jar`, OR
- HTTP `content-type: application/java-archive`

### Install flow (special!)

```
addRepo(kotatsuJarUrl)
   1. download .jar (it's an APK with classes.dex)
   2. dex2jar → data/exts-jar-kotatsu/plugin.jar
      (MUST be named exactly "plugin.jar" — the JAR looks for this filename)
   3. delete data/exts-jar-kotatsu/kotatsu_extensions_cache.json (force rescan)
   4. JAR kotatsuLoadExtensions → returns ~57 sources
   5. synthesize RepoIndex from loaded sources
```

The synthesized index looks like:

```json
{
  "url": "https://.../vn.jar",
  "name": "Kotatsu Manga Repo",
  "extensions": [
    {
      "id": "kotatsu_hitomila",
      "name": "Hitomi.La",
      "type": "manga",
      "itemType": 0,
      "managerId": "kotatsu",
      "runtime": "kotatsu",
      "lang": "all",
      "baseUrl": "hitomi.la"
    },
    {
      "id": "kotatsu_mangadex",
      "name": "MangaDex",
      "type": "manga",
      "itemType": 0,
      "managerId": "kotatsu",
      "runtime": "kotatsu",
      "lang": "all",
      "baseUrl": "mangadex.org"
    }
  ]
}
```

### Type detection

All Kotatsu sources are `itemType: 0` (manga). The runtime's `KotatsuExtensions.dart` hardcodes `supportsAnime: false`.

### Per-source install

Installing a Kotatsu source does **NOT** download anything — the jar is already loaded. It just marks the source as "active" for this user in the `user_exts` table.

### Known Kotatsu repos

| Repo | URL |
|---|---|
| dragonx943 (Vietnamese) | `https://github.com/dragonx943/manga-repo/releases/download/c54deeb/vn.jar` |

---

## 6. Auto-detection flowchart

```
fetch repo URL
   │
   ├── HTTP content-type is java-archive OR URL ends in .jar
   │   → KOTATSU
   │   (download jar, dex2jar, kotatsuLoadExtensions, synthesize index)
   │
   ├── response is JSON object with "pluginLists": [...]
   │   → CLOUDSTREAM META-REPO
   │   (follow each pluginList URL, merge results)
   │
   ├── response is JSON object with "plugins": [...]
   │   → CLOUDSTREAM WRAPPED
   │
   ├── response is JSON object with "extensions": [...]
   │   → ANIYOMI / MANGAYOMI WRAPPED
   │
   └── response is a bare JSON array
       │
       ├── each item has "tvTypes" / "internalName" / "jarUrl" / ".cs3" URL
       │   → CLOUDSTREAM BARE ARRAY (phisher98-style)
       │
       └── otherwise
           → ANIYOMI BARE ARRAY (yuzono-style)
```

---

## 7. Runtime summary

| Format | Runtime | Type(s) | Install downloads | Sources per install |
|---|---|---|---|---|
| Aniyomi bare array | `aniyomi` | anime + manga | .apk → dex2jar → .jar | 1 source per .apk |
| Aniyomi wrapped | `aniyomi` | anime + manga | same | same |
| CloudStream meta-repo | `cloudstream` | anime | .cs3 + .jar → repackage | 1 source per plugin |
| CloudStream bare array | `cloudstream` | anime | same | same |
| CloudStream wrapped | `cloudstream` | anime | same | same |
| Kotatsu direct .jar | `kotatsu` | manga | .jar → dex2jar (once per repo) | N sources per jar |

---

## 8. Adding all three (recommended)

For the best experience, add one of each:

```dart
await bridge.addRepo('https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json');
await bridge.addRepo('https://raw.githubusercontent.com/yuzono/manga-repo/repo/index.min.json');
await bridge.addRepo('https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/repo/repo.json');
await bridge.addRepo('https://github.com/dragonx943/manga-repo/releases/download/c54deeb/vn.jar');

// Now listAvailable returns extensions from all 4 repos:
final anime = await bridge.listAvailable(type: 'anime');  // ~259 Aniyomi + ~77 CloudStream
final manga = await bridge.listAvailable(type: 'manga');  // ~1380 Tachiyomi + ~57 Kotatsu
```

The server caches each repo's index for 6 hours, so subsequent `listAvailable` calls are instant.
