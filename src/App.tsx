import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Bookmark,
  ExternalLink,
  Palette,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'

type Category = 'malaysia' | 'markets_investment' | 'world'
type Confidence = 'verified' | 'cross_checked' | 'reported_unconfirmed'
type HeatFilter = 'all' | 'rising'
type ThemeMode = 'calm' | 'focus' | 'night'
type SearchMode = 'all' | 'latest' | 'malaysia' | 'markets' | 'world' | 'social' | 'official' | 'high'

type SourceLink = {
  name: string
  url: string
  publisher_type: string
}

type Story = {
  id: string
  category: Category
  headline: string
  summary: string
  why_it_matters: string
  published_at: string
  source_links: SourceLink[]
  topics: string[]
  importance: number
  confidence: Confidence
}

type NewsPayload = {
  generated_at: string
  timezone: string
  refresh_interval_hours: number
  stories: Story[]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: NewsPayload }
  | { status: 'error'; message: string }

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'loaded'; query: string; generatedAt: string; stories: Story[] }
  | { status: 'error'; query: string; message: string }

type SearchPayload = {
  generated_at: string
  timezone: string
  stories: Story[]
  error?: string
}

const categoryLabels: Record<Category | 'all', string> = {
  all: 'All',
  malaysia: 'Malaysia',
  markets_investment: 'Markets',
  world: 'World',
}

const heatFilterLabels: Record<HeatFilter, string> = {
  all: 'All heat',
  rising: 'Rising Heat',
}

const categoryTone: Record<Category | 'all', string> = {
  all: 'all',
  malaysia: 'malaysia',
  markets_investment: 'markets',
  world: 'world',
}

const themeLabels: Record<ThemeMode, string> = {
  calm: 'Calm',
  focus: 'Focus',
  night: 'Night',
}

const searchModeLabels: Record<SearchMode, string> = {
  all: 'All',
  latest: 'Latest',
  malaysia: 'Malaysia',
  markets: 'Markets',
  world: 'World',
  social: 'Social',
  official: 'Official',
  high: 'High heat',
}

const categoryOrder: Array<Category | 'all'> = ['all', 'malaysia', 'markets_investment', 'world']
const themeOrder: ThemeMode[] = ['calm', 'focus', 'night']
const searchModeOrder: SearchMode[] = ['all', 'latest', 'malaysia', 'markets', 'world', 'social', 'official', 'high']
const AUTO_REFRESH_MS = 5 * 60 * 1000
const WATCHLIST_STORAGE_KEY = 'daily-news-watchlist'
const STORY_VIEWS_STORAGE_KEY = 'daily-news-story-views'
const THEME_STORAGE_KEY = 'daily-news-theme'
const DEFAULT_WATCHLIST = ['Tesla', 'Nvidia', 'Ringgit', 'Malaysia economy']
const LIVE_DASHBOARD_QUERIES = [
  'Malaysia latest news politics economy',
  'Malaysia markets investment ringgit Bursa',
  'world latest news markets geopolitics',
]

function isNewsPayload(value: unknown): value is NewsPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as NewsPayload
  return (
    typeof payload.generated_at === 'string' &&
    typeof payload.timezone === 'string' &&
    typeof payload.refresh_interval_hours === 'number' &&
    Array.isArray(payload.stories)
  )
}

function isSearchPayload(value: unknown): value is SearchPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as SearchPayload
  return typeof payload.generated_at === 'string' && Array.isArray(payload.stories)
}

async function fetchDashboardLiveNews() {
  const results = await Promise.allSettled(
    LIVE_DASHBOARD_QUERIES.map(async (query) => {
      const response = await fetch(`/api/news-search?q=${encodeURIComponent(query)}`, {
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`Live search returned ${response.status}`)
      }

      const json = (await response.json()) as unknown
      if (!isSearchPayload(json)) {
        throw new Error('Live search shape does not match the shared contract')
      }
      if (json.error) {
        throw new Error(json.error)
      }
      return json
    }),
  )

  const payloads: SearchPayload[] = []
  let failedCount = 0
  for (const result of results) {
    if (result.status === 'fulfilled') {
      payloads.push(result.value)
    } else {
      failedCount += 1
    }
  }

  return { failedCount, payloads }
}

function mergeLiveDashboardNews(savedPayload: NewsPayload, livePayloads: SearchPayload[]): NewsPayload {
  if (livePayloads.length === 0) return savedPayload

  return {
    ...savedPayload,
    generated_at: newestIso([
      savedPayload.generated_at,
      ...livePayloads.map((payload) => payload.generated_at),
    ]),
    stories: mergeStoriesBySource([
      ...livePayloads.flatMap((payload) => payload.stories),
      ...savedPayload.stories,
    ]),
  }
}

function mergeStoriesBySource(stories: Story[]) {
  const seenUrls = new Set<string>()
  const seenHeadlines = new Set<string>()
  const merged: Story[] = []

  for (const story of stories) {
    const urls = story.source_links.map((source) => canonicalStoryUrl(source.url)).filter(Boolean)
    const headlineKey = story.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (urls.some((url) => seenUrls.has(url)) || seenHeadlines.has(headlineKey)) {
      continue
    }

    urls.forEach((url) => seenUrls.add(url))
    seenHeadlines.add(headlineKey)
    merged.push(story)
  }

  return merged
    .sort((a, b) => storyTimestamp(b) - storyTimestamp(a))
    .slice(0, 60)
}

function canonicalStoryUrl(value: string) {
  try {
    const url = new URL(value)
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key)
      }
    }
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function newestIso(values: string[]) {
  const newest = values.reduce((currentNewest, value) => {
    const timestamp = new Date(value).getTime()
    return Number.isNaN(timestamp) ? currentNewest : Math.max(currentNewest, timestamp)
  }, 0)

  return newest > 0 ? new Date(newest).toISOString() : new Date().toISOString()
}

function formatDateTime(value: string, timezone?: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'

  return new Intl.DateTimeFormat('en-MY', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone || undefined,
  }).format(date)
}

function getSourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function getStoryPath(story: Story) {
  return `/story/${encodeURIComponent(story.id)}`
}

function getRouteStoryId() {
  const match = window.location.pathname.match(/^\/story\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function getSourceKind(source: SourceLink) {
  const host = getSourceHost(source.url).toLowerCase()
  const type = source.publisher_type.toLowerCase()
  const name = source.name.toLowerCase()

  if (/(^|\.)x\.com$|twitter\.com|facebook\.com|instagram\.com|threads\.net/.test(host)) {
    return 'Social'
  }
  if (
    type.includes('government') ||
    type.includes('official') ||
    type.includes('regulator') ||
    host.includes('.gov') ||
    host.endsWith('gov.my') ||
    host.includes('bnm.gov') ||
    host.includes('sec.gov') ||
    name.includes('official')
  ) {
    return 'Official'
  }
  if (
    type.includes('exchange') ||
    type.includes('market') ||
    name.includes('bursa') ||
    name.includes('bank negara') ||
    host.includes('bursamalaysia') ||
    host.includes('tradingeconomics')
  ) {
    return 'Market data'
  }
  if (type.includes('news') || type.includes('media') || type.includes('publisher')) {
    return 'Newsroom'
  }
  return 'Public source'
}

function hasSourceKind(story: Story, kind: string) {
  return story.source_links.some((source) => getSourceKind(source) === kind)
}

function topicScore(topic: string, stories: Story[]) {
  return stories.reduce((score, story) => {
    if (!story.topics.some((storyTopic) => storyTopic.toLowerCase() === topic.toLowerCase())) {
      return score
    }
    return score + 1 + normalizeImportance(story.importance) / 100
  }, 0)
}

function getTrendingTopics(stories: Story[]) {
  const topics = Array.from(new Set(stories.flatMap((story) => story.topics)))
  return topics
    .map((topic) => ({
      name: topic,
      count: stories.filter((story) =>
        story.topics.some((storyTopic) => storyTopic.toLowerCase() === topic.toLowerCase()),
      ).length,
      score: topicScore(topic, stories),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
}

function loadSavedWatchlist() {
  try {
    const storedValue = window.localStorage.getItem(WATCHLIST_STORAGE_KEY)
    if (!storedValue) return DEFAULT_WATCHLIST
    const parsed = JSON.parse(storedValue) as unknown
    if (!Array.isArray(parsed)) return DEFAULT_WATCHLIST
    const topics = parsed
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.trim())
      .filter(Boolean)
    return topics.length > 0 ? topics.slice(0, 10) : DEFAULT_WATCHLIST
  } catch {
    return DEFAULT_WATCHLIST
  }
}

function loadSavedStoryViews() {
  try {
    const storedValue = window.localStorage.getItem(STORY_VIEWS_STORAGE_KEY)
    if (!storedValue) return {}
    const parsed = JSON.parse(storedValue) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.entries(parsed).reduce<Record<string, number>>((views, [storyId, count]) => {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        views[storyId] = count
      }
      return views
    }, {})
  } catch {
    return {}
  }
}

function loadSavedTheme() {
  try {
    const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY)
    return themeOrder.includes(storedValue as ThemeMode) ? (storedValue as ThemeMode) : 'calm'
  } catch {
    return 'calm'
  }
}

function getImportanceLabel(score: number) {
  const normalizedScore = normalizeImportance(score)
  if (normalizedScore >= 85) return 'Hot signal'
  if (normalizedScore >= 65) return 'Rising heat'
  return 'Developing'
}

function storyTimestamp(story: Story) {
  const timestamp = new Date(story.published_at).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function normalizeImportance(score: number) {
  if (!Number.isFinite(score)) return 0
  const scaledScore = score <= 5 ? score * 20 : score
  return Math.max(0, Math.min(Math.round(scaledScore), 100))
}

function getCategoryBrief(category: Category) {
  if (category === 'malaysia') {
    return 'A Malaysia-focused update that may affect local policy, companies, public services, or daily decisions.'
  }
  if (category === 'markets_investment') {
    return 'A markets and investment update worth watching for price moves, earnings expectations, rates, currencies, or sector sentiment.'
  }
  return 'A world update that may shape geopolitics, business confidence, supply chains, technology, or public safety.'
}

function getWatchNote(story: Story) {
  const topicText = story.topics.slice(0, 3).join(', ')
  if (story.category === 'markets_investment') {
    return `Watch whether this changes investor sentiment around ${topicText || 'the related market'}, especially through price action, company statements, analyst notes, or regulator updates.`
  }
  if (story.category === 'malaysia') {
    return `Watch for official follow-up, local policy response, and practical effects around ${topicText || 'the affected Malaysia topic'}.`
  }
  return `Watch for follow-up confirmation, official response, and wider effects around ${topicText || 'the affected global issue'}.`
}

function getDetailPoints(story: Story) {
  return dedupeDetailPoints([
    story.why_it_matters,
    getWatchNote(story),
  ], story.summary)
}

function recencyBoost(story: Story) {
  const ageHours = (Date.now() - storyTimestamp(story)) / 36e5
  if (!Number.isFinite(ageHours) || ageHours < 0) return 8
  if (ageHours <= 6) return 10
  if (ageHours <= 24) return 7
  if (ageHours <= 72) return 4
  return 0
}

function topicMomentum(story: Story, stories: Story[]) {
  const normalizedTopics = story.topics.map((topic) => topic.toLowerCase())
  const matchingStories = stories.filter((candidate) =>
    candidate.topics.some((topic) => normalizedTopics.includes(topic.toLowerCase())),
  ).length
  return Math.min(matchingStories * 3, 18)
}

function getHeatScore(story: Story, stories: Story[], storyViews: Record<string, number>) {
  const baseScore = normalizeImportance(story.importance)
  const sourceSignal = Math.min(Math.max(story.source_links.length - 1, 0) * 6, 18)
  const viewSignal = Math.min((storyViews[story.id] || 0) * 8, 24)
  return Math.max(
    0,
    Math.min(Math.round(baseScore * 0.72 + sourceSignal + topicMomentum(story, stories) + recencyBoost(story) + viewSignal), 100),
  )
}

function normalizePointText(value: string) {
  return value
    .toLowerCase()
    .replace(/^key points:\s*/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pointSimilarity(left: string, right: string) {
  const leftTerms = new Set(normalizePointText(left).split(' ').filter((term) => term.length > 3))
  const rightTerms = new Set(normalizePointText(right).split(' ').filter((term) => term.length > 3))
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0
  const sharedTerms = Array.from(leftTerms).filter((term) => rightTerms.has(term)).length
  return sharedTerms / Math.min(leftTerms.size, rightTerms.size)
}

function dedupeDetailPoints(points: string[], alreadyShown: string) {
  const uniquePoints: string[] = []
  for (const point of points) {
    const trimmedPoint = point.trim()
    if (!trimmedPoint) continue
    const duplicatesExisting =
      pointSimilarity(trimmedPoint, alreadyShown) > 0.72 ||
      uniquePoints.some((existingPoint) => pointSimilarity(trimmedPoint, existingPoint) > 0.72)
    if (!duplicatesExisting) {
      uniquePoints.push(trimmedPoint)
    }
  }
  return uniquePoints
}

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all')
  const [activeHeatFilter, setActiveHeatFilter] = useState<HeatFilter>('all')
  const [query, setQuery] = useState('')
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false)
  const [liveQuery, setLiveQuery] = useState('')
  const [activeSearchMode, setActiveSearchMode] = useState<SearchMode>('all')
  const [theme, setTheme] = useState<ThemeMode>(() => loadSavedTheme())
  const [isThemeChanging, setIsThemeChanging] = useState(false)
  const [watchlistTopics, setWatchlistTopics] = useState<string[]>(() => loadSavedWatchlist())
  const [storyViews, setStoryViews] = useState<Record<string, number>>(() => loadSavedStoryViews())
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle' })
  const [selectedStory, setSelectedStory] = useState<{ story: Story; timezone: string } | null>(null)

  const loadNews = useCallback(async (background = false) => {
    if (background) {
      setIsRefreshing(true)
    } else {
      setLoadState({ status: 'loading' })
    }

    try {
      const response = await fetch(`/data/news.json?refresh=${Date.now()}`, {
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`News feed returned ${response.status}`)
      }

      const json = (await response.json()) as unknown
      if (!isNewsPayload(json)) {
        throw new Error('News feed shape does not match the shared contract')
      }

      const liveResult = await fetchDashboardLiveNews()
      const mergedPayload = mergeLiveDashboardNews(json, liveResult.payloads)

      setLoadState({ status: 'loaded', data: mergedPayload })
      setLastCheckedAt(new Date().toISOString())
      setRefreshError(
        liveResult.payloads.length === 0 && liveResult.failedCount > 0
          ? 'Live update unavailable; showing saved feed'
          : null,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the briefing'
      if (background) {
        setRefreshError(message)
      } else {
        setLoadState({ status: 'error', message })
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadNews()
    const intervalId = window.setInterval(() => loadNews(true), AUTO_REFRESH_MS)

    function handleFocus() {
      loadNews(true)
    }

    window.addEventListener('focus', handleFocus)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadNews])

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const x = Math.round((event.clientX / window.innerWidth) * 100)
      const y = Math.round((event.clientY / window.innerHeight) * 100)
      document.documentElement.style.setProperty('--pointer-x', `${x}%`)
      document.documentElement.style.setProperty('--pointer-y', `${y}%`)
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    return () => window.removeEventListener('pointermove', handlePointerMove)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlistTopics))
  }, [watchlistTopics])

  useEffect(() => {
    window.localStorage.setItem(STORY_VIEWS_STORAGE_KEY, JSON.stringify(storyViews))
  }, [storyViews])

  const runLiveSearch = useCallback(async (searchTerm: string) => {
    const trimmedTerm = searchTerm.trim()
    if (trimmedTerm.length < 2) {
      setSearchState({
        status: 'error',
        query: trimmedTerm,
        message: 'Search at least two characters.',
      })
      return
    }

    setSearchState({ status: 'loading', query: trimmedTerm })
    try {
      const response = await fetch(`/api/news-search?q=${encodeURIComponent(trimmedTerm)}`, {
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`Search returned ${response.status}`)
      }

      const json = (await response.json()) as unknown
      if (!isSearchPayload(json)) {
        throw new Error('Search result shape does not match the shared contract')
      }

      if (json.error) {
        throw new Error(json.error)
      }

      setSearchState({
        status: 'loaded',
        query: trimmedTerm,
        generatedAt: json.generated_at,
        stories: json.stories,
      })
    } catch (error) {
      setSearchState({
        status: 'error',
        query: trimmedTerm,
        message: error instanceof Error ? error.message : 'Search failed',
      })
    }
  }, [])

  const stories = loadState.status === 'loaded' ? loadState.data.stories : []
  const normalizedQuery = query.trim().toLowerCase()
  const allSelectableStories = useMemo(() => {
    const searchStories = searchState.status === 'loaded' ? searchState.stories : []
    const storyMap = new Map<string, Story>()
    ;[...stories, ...searchStories].forEach((story) => storyMap.set(story.id, story))
    return Array.from(storyMap.values())
  }, [searchState, stories])

  const heatScores = useMemo(() => {
    const allStories = allSelectableStories.length > 0 ? allSelectableStories : stories
    return new Map(allStories.map((story) => [story.id, getHeatScore(story, allStories, storyViews)]))
  }, [allSelectableStories, stories, storyViews])

  const filteredStories = useMemo(() => {
    return stories
      .filter((story) => activeCategory === 'all' || story.category === activeCategory)
      .filter((story) => activeHeatFilter === 'all' || (heatScores.get(story.id) || 0) >= 65)
      .filter((story) => {
        if (!normalizedQuery) return true
        const haystack = [
          story.headline,
          story.summary,
          story.why_it_matters,
          story.category,
          story.confidence,
          ...story.topics,
          ...story.source_links.map((source) => `${source.name} ${source.publisher_type}`),
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(normalizedQuery)
      })
      .sort((a, b) => {
        const byReleaseTime = storyTimestamp(b) - storyTimestamp(a)
        if (byReleaseTime !== 0) return byReleaseTime
        return (heatScores.get(b.id) || 0) - (heatScores.get(a.id) || 0)
      })
  }, [activeCategory, activeHeatFilter, heatScores, normalizedQuery, stories])

  const filteredSearchStories = useMemo(() => {
    if (searchState.status !== 'loaded') return []

    return searchState.stories
      .filter((story) => {
        if (activeSearchMode === 'all' || activeSearchMode === 'latest') return true
        if (activeSearchMode === 'malaysia') return story.category === 'malaysia'
        if (activeSearchMode === 'markets') return story.category === 'markets_investment'
        if (activeSearchMode === 'world') return story.category === 'world'
        if (activeSearchMode === 'social') return hasSourceKind(story, 'Social')
        if (activeSearchMode === 'official') return hasSourceKind(story, 'Official')
        if (activeSearchMode === 'high') return (heatScores.get(story.id) || 0) >= 80
        return true
      })
      .sort((a, b) => storyTimestamp(b) - storyTimestamp(a) || (heatScores.get(b.id) || 0) - (heatScores.get(a.id) || 0))
      .slice(0, activeSearchMode === 'latest' ? 10 : undefined)
  }, [activeSearchMode, heatScores, searchState])

  const trendingTopics = useMemo(() => getTrendingTopics(stories), [stories])
  const watchlistMatches = useMemo(() => {
    return watchlistTopics.map((topic) => {
      const normalizedTopic = topic.toLowerCase()
      const count = stories.filter((story) =>
        [story.headline, story.summary, story.why_it_matters, ...story.topics]
          .join(' ')
          .toLowerCase()
          .includes(normalizedTopic),
      ).length
      return { topic, count }
    })
  }, [stories, watchlistTopics])

  const data = loadState.status === 'loaded' ? loadState.data : null
  const topStory = filteredStories[0]
  const activeFilterCount =
    (activeCategory !== 'all' ? 1 : 0) +
    (activeHeatFilter !== 'all' ? 1 : 0) +
    (normalizedQuery ? 1 : 0)

  useEffect(() => {
    function syncRouteStory() {
      const storyId = getRouteStoryId()
      if (!storyId) {
        setSelectedStory(null)
        return
      }

      const matchedStory = allSelectableStories.find((story) => story.id === storyId)
      if (matchedStory) {
        setSelectedStory({ story: matchedStory, timezone: data?.timezone || 'Asia/Kuala_Lumpur' })
      }
    }

    syncRouteStory()
    window.addEventListener('popstate', syncRouteStory)
    return () => window.removeEventListener('popstate', syncRouteStory)
  }, [allSelectableStories, data?.timezone])

  function openStory(story: Story, timezone: string) {
    setStoryViews((currentViews) => ({
      ...currentViews,
      [story.id]: (currentViews[story.id] || 0) + 1,
    }))
    setSelectedStory({ story, timezone })
    window.history.pushState(null, '', getStoryPath(story))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function closeStory() {
    setSelectedStory(null)
    window.history.pushState(null, '', '/')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function runTopicSearch(topic: string) {
    setLiveQuery(topic)
    runLiveSearch(topic)
  }

  function saveCurrentTopic() {
    const topic = (liveQuery || query).trim()
    if (topic.length < 2) return
    setWatchlistTopics((currentTopics) => {
      const withoutDuplicate = currentTopics.filter(
        (currentTopic) => currentTopic.toLowerCase() !== topic.toLowerCase(),
      )
      return [topic, ...withoutDuplicate].slice(0, 10)
    })
  }

  function removeWatchlistTopic(topic: string) {
    setWatchlistTopics((currentTopics) =>
      currentTopics.filter((currentTopic) => currentTopic.toLowerCase() !== topic.toLowerCase()),
    )
  }

  function resetDashboardFilters() {
    setActiveCategory('all')
    setActiveHeatFilter('all')
    setQuery('')
  }

  function changeTheme(nextTheme: ThemeMode) {
    if (nextTheme === theme) return
    document.documentElement.classList.add('theme-changing')
    setIsThemeChanging(true)
    setTheme(nextTheme)
    window.setTimeout(() => {
      setIsThemeChanging(false)
      document.documentElement.classList.remove('theme-changing')
    }, 760)
  }

  if (selectedStory) {
    return (
      <main className={`app-shell ${isThemeChanging ? 'theme-transitioning' : ''}`}>
        <StoryDetail
          heatScore={heatScores.get(selectedStory.story.id) || normalizeImportance(selectedStory.story.importance)}
          onBack={closeStory}
          story={selectedStory.story}
          timezone={selectedStory.timezone}
        />
      </main>
    )
  }

  return (
    <main className={`app-shell ${isThemeChanging ? 'theme-transitioning' : ''}`}>
      <section className="briefing-header" aria-labelledby="page-title">
        <div className="header-top">
          <div className="brand-row">
            <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
            <span className="brand-name">Daily News</span>
          </div>
          <ThemeSwitcher theme={theme} onThemeChange={changeTheme} />
        </div>

        <div className="headline-grid">
          <div className="headline-copy">
            <p className="section-kicker">Live news search</p>
            <h1 id="page-title">Search what is happening now.</h1>
            <p className="lede">
              Ask for any topic and get latest public news results with short summaries,
              impact notes, published times, and direct source links.
            </p>
          </div>

          <aside className="briefing-status" aria-label="Briefing status">
            {data ? (
              <>
                <span>Updated</span>
                <strong>{formatDateTime(lastCheckedAt || data.generated_at, data.timezone)}</strong>
                <span>Auto check</span>
                <strong>{isRefreshing ? 'Checking now' : 'Live every 5 minutes'}</strong>
                {refreshError && (
                  <>
                    <span>Latest check</span>
                    <strong>{refreshError}</strong>
                  </>
                )}
                <button className="status-refresh" type="button" onClick={() => loadNews(true)}>
                  <RotateCcw aria-hidden="true" size={16} strokeWidth={2.4} />
                  Refresh
                </button>
              </>
            ) : (
              <>
                <span>Status</span>
                <strong>{loadState.status === 'loading' ? 'Loading briefing' : 'Feed unavailable'}</strong>
                <span>Source</span>
                <strong>/data/news.json</strong>
              </>
            )}
          </aside>
        </div>
      </section>

      <section className="ai-search-panel" aria-label="Latest online news search">
        <div>
          <p className="section-kicker">Search AI</p>
          <h2>Search latest online news</h2>
        </div>
        <form
          className="ai-search-form"
          onSubmit={(event) => {
            event.preventDefault()
            runLiveSearch(liveQuery)
          }}
        >
          <label className="search-field">
            <span>Topic</span>
            <div className="search-input-wrap">
              <Search aria-hidden="true" size={18} strokeWidth={2.2} />
              <input
                type="search"
                value={liveQuery}
                onChange={(event) => setLiveQuery(event.target.value)}
                placeholder="Tesla, Nvidia, ringgit, oil..."
              />
            </div>
          </label>
          <button type="submit" disabled={searchState.status === 'loading'}>
            {searchState.status === 'loading' ? 'Searching' : 'Search latest'}
          </button>
        </form>
      </section>

      <FloatingFilters
        activeCategory={activeCategory}
        activeHeatFilter={activeHeatFilter}
        activeFilterCount={activeFilterCount}
        isOpen={isFilterPanelOpen}
        onCategoryChange={setActiveCategory}
        onClose={() => setIsFilterPanelOpen(false)}
        onHeatFilterChange={setActiveHeatFilter}
        onQueryChange={setQuery}
        onReset={resetDashboardFilters}
        onToggle={() => setIsFilterPanelOpen((isOpen) => !isOpen)}
        query={query}
      />

      {loadState.status === 'loaded' && (
        <section className="insights-band" aria-label="Watchlist and trending topics">
          <div className="insight-panel">
            <div className="panel-heading">
              <span>Watchlist</span>
              <button className="mini-action" onClick={saveCurrentTopic} type="button">
                <Bookmark aria-hidden="true" size={15} strokeWidth={2.4} />
                Save topic
              </button>
            </div>
            <div className="topic-cloud">
              {watchlistMatches.map(({ topic, count }) => (
                <span className="watch-chip" key={topic}>
                  <button onClick={() => runTopicSearch(topic)} type="button">
                    {topic}
                    <small>{count}</small>
                  </button>
                  <button
                    aria-label={`Remove ${topic}`}
                    className="chip-remove"
                    onClick={() => removeWatchlistTopic(topic)}
                    type="button"
                  >
                    <X aria-hidden="true" size={13} strokeWidth={2.5} />
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="insight-panel">
            <div className="panel-heading">
              <span>Trending now</span>
              <strong>{trendingTopics.length} signals</strong>
            </div>
            <div className="topic-cloud">
              {trendingTopics.map((topic) => (
                <button className="trend-chip" key={topic.name} onClick={() => runTopicSearch(topic.name)} type="button">
                  {topic.name}
                  <small>{topic.count}</small>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {searchState.status !== 'idle' && (
        <section className="search-results" aria-live="polite">
          <div className="search-results-head">
            <div>
              <span>Online search</span>
              <h2>
                {searchState.status === 'loading'
                  ? `Searching ${searchState.query}`
                  : searchState.status === 'loaded'
                    ? `Latest on ${searchState.query}`
                    : `Search issue for ${searchState.query || 'topic'}`}
              </h2>
            </div>
            {searchState.status === 'loaded' && (
              <strong>{formatDateTime(searchState.generatedAt, 'Asia/Kuala_Lumpur')}</strong>
            )}
          </div>

          {searchState.status === 'loaded' && (
            <div className="search-mode-row" aria-label="Search result filters">
              {searchModeOrder.map((mode) => (
                <button
                  className={activeSearchMode === mode ? 'is-active' : ''}
                  key={mode}
                  onClick={() => setActiveSearchMode(mode)}
                  type="button"
                >
                  {searchModeLabels[mode]}
                </button>
              ))}
            </div>
          )}

          {searchState.status === 'loading' && <span className="loading-bar" />}
          {searchState.status === 'error' && <p className="search-error">{searchState.message}</p>}
          {searchState.status === 'loaded' && filteredSearchStories.length > 0 && (
            <div className="story-grid search-grid">
              {filteredSearchStories.map((story) => (
                <StoryCard
                  heatScore={heatScores.get(story.id) || normalizeImportance(story.importance)}
                  key={story.id}
                  onOpen={() => openStory(story, 'Asia/Kuala_Lumpur')}
                  story={story}
                  timezone="Asia/Kuala_Lumpur"
                />
              ))}
            </div>
          )}
          {searchState.status === 'loaded' && filteredSearchStories.length === 0 && (
            <p className="search-error">No recent public news results found for this search filter.</p>
          )}
        </section>
      )}

      {loadState.status === 'loading' && <LoadingState />}
      {loadState.status === 'error' && <ErrorState message={loadState.message} />}

      {loadState.status === 'loaded' && (
        <>
          <section className="summary-strip" aria-label="Briefing summary">
            <Metric label="Stories" value={stories.length.toString()} />
            <Metric label="Showing" value={filteredStories.length.toString()} />
            <Metric label="Sorted by" value={topStory ? 'Latest first' : 'None'} />
          </section>

          {filteredStories.length > 0 ? (
            <section className="story-grid" aria-label="Filtered stories">
              {filteredStories.map((story) => (
                <StoryCard
                  heatScore={heatScores.get(story.id) || normalizeImportance(story.importance)}
                  key={story.id}
                  onOpen={() => openStory(story, loadState.data.timezone)}
                  story={story}
                  timezone={loadState.data.timezone}
                />
              ))}
            </section>
          ) : (
            <section className="empty-state" aria-live="polite">
              <h2>No stories match this view.</h2>
              <p>Try widening the category, heat, or search filter.</p>
              <button
                type="button"
                onClick={resetDashboardFilters}
              >
                <RotateCcw aria-hidden="true" size={17} strokeWidth={2.4} />
                Reset filters
              </button>
            </section>
          )}
        </>
      )}
    </main>
  )
}

function StoryCard({
  heatScore,
  onOpen,
  story,
  timezone,
}: {
  heatScore: number
  onOpen: () => void
  story: Story
  timezone: string
}) {
  const heatClass = heatScore >= 85 ? 'heat-hot' : heatScore >= 65 ? 'heat-warm' : 'heat-cool'

  return (
    <article
      aria-label={`Open details for ${story.headline}`}
      className={`story-card ${heatClass}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="story-meta">
        <span className={`category-pill category-${categoryTone[story.category]}`}>
          {categoryLabels[story.category]}
        </span>
        <time dateTime={story.published_at}>Published {formatDateTime(story.published_at, timezone)}</time>
      </div>
      <SourceProof story={story} />

      <h2>{story.headline}</h2>
      <div className="summary-panel">
        <span>Summary</span>
        <p className="story-summary">{story.summary}</p>
      </div>

      <div className="matter-panel">
        <span>How it may affect us</span>
        <p>{story.why_it_matters}</p>
      </div>

      <div className="topic-row" aria-label="Topics">
        {story.topics.map((topic) => (
          <span key={topic}>{topic}</span>
        ))}
      </div>

      <div className="story-footer">
        <div className="importance-meter" aria-label={`Heat ${heatScore} out of 100`}>
          <span>{getImportanceLabel(heatScore)}</span>
          <div>
            <i style={{ width: `${heatScore}%` }} />
          </div>
        </div>
      </div>
    </article>
  )
}

function ThemeSwitcher({
  onThemeChange,
  theme,
}: {
  onThemeChange: (theme: ThemeMode) => void
  theme: ThemeMode
}) {
  return (
    <div className="theme-switcher" aria-label="Theme">
      <Palette aria-hidden="true" size={17} strokeWidth={2.3} />
      {themeOrder.map((themeMode) => (
        <button
          className={theme === themeMode ? 'is-active' : ''}
          key={themeMode}
          onClick={() => onThemeChange(themeMode)}
          type="button"
        >
          {themeLabels[themeMode]}
        </button>
      ))}
    </div>
  )
}

function FloatingFilters({
  activeCategory,
  activeHeatFilter,
  activeFilterCount,
  isOpen,
  onCategoryChange,
  onClose,
  onHeatFilterChange,
  onQueryChange,
  onReset,
  onToggle,
  query,
}: {
  activeCategory: Category | 'all'
  activeHeatFilter: HeatFilter
  activeFilterCount: number
  isOpen: boolean
  onCategoryChange: (category: Category | 'all') => void
  onClose: () => void
  onHeatFilterChange: (heatFilter: HeatFilter) => void
  onQueryChange: (query: string) => void
  onReset: () => void
  onToggle: () => void
  query: string
}) {
  return (
    <aside className="floating-filter" aria-label="Dashboard filters">
      <button
        aria-label="Open dashboard filters"
        aria-expanded={isOpen}
        className="floating-filter-button"
        onClick={onToggle}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" size={18} strokeWidth={2.4} />
        {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
      </button>

      {isOpen && (
        <div className="floating-filter-panel">
          <div className="floating-filter-search">
            <label className="search-input-wrap">
              <Search aria-hidden="true" size={17} strokeWidth={2.2} />
              <input
                aria-label="Search dashboard"
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search stories"
              />
            </label>
            <button aria-label="Close filters" onClick={onClose} type="button">
              <X aria-hidden="true" size={16} strokeWidth={2.5} />
            </button>
          </div>

          <div className="filter-group" aria-label="Category filter">
            {categoryOrder.map((category) => (
              <button
                className={[
                  'filter-button',
                  `category-${categoryTone[category]}`,
                  activeCategory === category ? 'is-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={category}
                onClick={() => onCategoryChange(category)}
                type="button"
              >
                {categoryLabels[category]}
              </button>
            ))}
          </div>

          <div className="heat-filter-group" aria-label="Heat filter">
            <button
              className={`filter-button heat-filter ${activeHeatFilter === 'rising' ? 'is-active' : ''}`}
              onClick={() => onHeatFilterChange(activeHeatFilter === 'rising' ? 'all' : 'rising')}
              type="button"
            >
              {heatFilterLabels.rising}
            </button>
          </div>

          <div className="floating-filter-bottom">
            <button className="floating-filter-reset" onClick={onReset} type="button">
              <RotateCcw aria-hidden="true" size={15} strokeWidth={2.4} />
              Reset
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

function SourceProof({ story }: { story: Story }) {
  const sourceKinds = Array.from(new Set(story.source_links.map((source) => getSourceKind(source))))

  return (
    <div className="source-proof" aria-label="Source evidence">
      {sourceKinds.map((kind) => (
        <span className={`source-kind source-kind-${kind.toLowerCase().replace(/\s+/g, '-')}`} key={kind}>
          {kind}
        </span>
      ))}
      <span className="source-count">{story.source_links.length} source link{story.source_links.length === 1 ? '' : 's'}</span>
    </div>
  )
}

function StoryDetail({
  heatScore,
  onBack,
  story,
  timezone,
}: {
  heatScore: number
  onBack: () => void
  story: Story
  timezone: string
}) {
  const heatClass = heatScore >= 85 ? 'heat-hot' : heatScore >= 65 ? 'heat-warm' : 'heat-cool'
  const detailPoints = getDetailPoints(story)

  return (
    <article className={`detail-page ${heatClass}`}>
      <button className="back-button" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={18} strokeWidth={2.4} />
        Back to home
      </button>

      <div className="story-meta">
        <span className={`category-pill category-${categoryTone[story.category]}`}>
          {categoryLabels[story.category]}
        </span>
        <time dateTime={story.published_at}>Published {formatDateTime(story.published_at, timezone)}</time>
      </div>
      <SourceProof story={story} />

      <h1>{story.headline}</h1>

      <div className="detail-grid">
        <section className="detail-main">
          <div className="detail-section detail-lead">
            <span>What happened</span>
            <p>{story.summary}</p>
          </div>

          <div className="detail-section">
            <span>Key takeaways</span>
            <ul className="detail-list">
              {detailPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>

          <div className="summary-panel">
            <span>Context</span>
            <p className="story-summary">{getCategoryBrief(story.category)}</p>
          </div>

          <div className="topic-row" aria-label="Topics">
            {story.topics.map((topic) => (
              <span key={topic}>{topic}</span>
            ))}
          </div>
        </section>

        <aside className="detail-side">
          <div className="importance-meter" aria-label={`Heat ${heatScore} out of 100`}>
            <span>{getImportanceLabel(heatScore)}</span>
            <div>
              <i style={{ width: `${heatScore}%` }} />
            </div>
          </div>

          <dl className="detail-facts">
            <div>
              <dt>Published</dt>
              <dd>{formatDateTime(story.published_at, timezone)}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{categoryLabels[story.category]}</dd>
            </div>
            <div>
              <dt>Source links found</dt>
              <dd>{story.source_links.map((source) => source.name).join(', ')}</dd>
            </div>
          </dl>

          <div className="source-row detail-sources" aria-label="Sources">
            <span className="source-label">Article source</span>
            {story.source_links.map((source) => (
              <a
                href={source.url}
                key={`${story.id}-${source.url}`}
                rel="noreferrer"
                target="_blank"
                title={`${source.name} via ${getSourceHost(source.url)}`}
              >
                <span>{source.name}</span>
                <small>{getSourceKind(source)}</small>
                <ExternalLink aria-hidden="true" size={15} strokeWidth={2.3} />
              </a>
            ))}
          </div>
        </aside>
      </div>
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function LoadingState() {
  return (
    <section className="status-panel" aria-live="polite">
      <span className="loading-bar" />
      <h2>Loading today&apos;s briefing</h2>
      <p>Looking for the latest generated news file.</p>
    </section>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <section className="status-panel error" role="alert">
      <h2>Briefing could not be loaded</h2>
      <p>{message}</p>
      <p>Place the shared feed at <code>public/data/news.json</code> or serve it from <code>/data/news.json</code>.</p>
    </section>
  )
}

export default App
