import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ExternalLink,
  Palette,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'

type Category = 'malaysia' | 'markets_investment' | 'world'
type Confidence = 'verified' | 'cross_checked' | 'reported_unconfirmed'
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

const categoryTone: Record<Category | 'all', string> = {
  all: 'all',
  malaysia: 'malaysia',
  markets_investment: 'markets',
  world: 'world',
}

const confidenceLabels: Record<Confidence | 'all', string> = {
  all: 'All confidence',
  verified: 'Verified',
  cross_checked: 'Cross-checked',
  reported_unconfirmed: 'Reported',
}

const confidenceTone: Record<Confidence, string> = {
  verified: 'good',
  cross_checked: 'steady',
  reported_unconfirmed: 'watch',
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
const confidenceOrder: Array<Confidence | 'all'> = [
  'all',
  'verified',
  'cross_checked',
  'reported_unconfirmed',
]
const themeOrder: ThemeMode[] = ['calm', 'focus', 'night']
const searchModeOrder: SearchMode[] = ['all', 'latest', 'malaysia', 'markets', 'world', 'social', 'official', 'high']
const AUTO_REFRESH_MS = 5 * 60 * 1000
const WATCHLIST_STORAGE_KEY = 'daily-news-watchlist'
const THEME_STORAGE_KEY = 'daily-news-theme'
const DEFAULT_WATCHLIST = ['Tesla', 'Nvidia', 'Ringgit', 'Malaysia economy']

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

function getConfidenceDescription(confidence: Confidence) {
  if (confidence === 'verified') {
    return 'The item is treated as verified from a credible public source in the current feed.'
  }
  if (confidence === 'cross_checked') {
    return 'The item has supporting coverage or source context, so it is stronger than a single isolated report.'
  }
  return 'The item is reported from public sources but should be read with extra caution until more confirmation appears.'
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
  return [
    story.summary,
    story.why_it_matters,
    getWatchNote(story),
  ]
}

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all')
  const [activeConfidence, setActiveConfidence] = useState<Confidence | 'all'>('all')
  const [query, setQuery] = useState('')
  const [liveQuery, setLiveQuery] = useState('')
  const [activeSearchMode, setActiveSearchMode] = useState<SearchMode>('all')
  const [theme, setTheme] = useState<ThemeMode>(() => loadSavedTheme())
  const [isThemeChanging, setIsThemeChanging] = useState(false)
  const [watchlistTopics, setWatchlistTopics] = useState<string[]>(() => loadSavedWatchlist())
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

      setLoadState({ status: 'loaded', data: json })
      setLastCheckedAt(new Date().toISOString())
      setRefreshError(null)
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

  const filteredStories = useMemo(() => {
    return stories
      .filter((story) => activeCategory === 'all' || story.category === activeCategory)
      .filter((story) => activeConfidence === 'all' || story.confidence === activeConfidence)
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
        return normalizeImportance(b.importance) - normalizeImportance(a.importance)
      })
  }, [activeCategory, activeConfidence, normalizedQuery, stories])

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
        if (activeSearchMode === 'high') return normalizeImportance(story.importance) >= 80
        return true
      })
      .sort((a, b) => storyTimestamp(b) - storyTimestamp(a))
      .slice(0, activeSearchMode === 'latest' ? 10 : undefined)
  }, [activeSearchMode, searchState])

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

  function changeTheme(nextTheme: ThemeMode) {
    if (nextTheme === theme) return
    document.documentElement.classList.add('theme-changing')
    setIsThemeChanging(true)
    setTheme(nextTheme)
    window.setTimeout(() => {
      setIsThemeChanging(false)
      document.documentElement.classList.remove('theme-changing')
    }, 520)
  }

  if (selectedStory) {
    return (
      <main className={`app-shell ${isThemeChanging ? 'theme-transitioning' : ''}`}>
        <StoryDetail
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
                <span>Generated</span>
                <strong>{formatDateTime(data.generated_at, data.timezone)}</strong>
                <span>Last checked</span>
                <strong>{lastCheckedAt ? formatDateTime(lastCheckedAt, data.timezone) : 'Checking'}</strong>
                <span>Auto check</span>
                <strong>{isRefreshing ? 'Checking now' : 'Every 5 minutes'}</strong>
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

      <section className="controls-band" aria-label="Story controls">
        <label className="search-field">
          <span>Filter dashboard</span>
          <div className="search-input-wrap">
            <Search aria-hidden="true" size={18} strokeWidth={2.2} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter headline, topic, source..."
            />
          </div>
        </label>

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
              onClick={() => setActiveCategory(category)}
              type="button"
            >
              {categoryLabels[category]}
            </button>
          ))}
        </div>

        <label className="select-field">
          <span>Confidence</span>
          <select
            value={activeConfidence}
            onChange={(event) => setActiveConfidence(event.target.value as Confidence | 'all')}
          >
            {confidenceOrder.map((confidence) => (
              <option key={confidence} value={confidence}>
                {confidenceLabels[confidence]}
              </option>
            ))}
          </select>
        </label>
      </section>

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
              <p>Try widening the category, confidence, or search filter.</p>
              <button
                type="button"
                onClick={() => {
                  setActiveCategory('all')
                  setActiveConfidence('all')
                  setQuery('')
                }}
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
  onOpen,
  story,
  timezone,
}: {
  onOpen: () => void
  story: Story
  timezone: string
}) {
  const importance = normalizeImportance(story.importance)
  const heatClass = importance >= 85 ? 'heat-hot' : importance >= 65 ? 'heat-warm' : 'heat-cool'

  return (
    <article className={`story-card ${heatClass}`}>
      <div className="story-meta">
        <span className={`confidence-pill ${confidenceTone[story.confidence]}`}>
          {confidenceLabels[story.confidence]}
        </span>
        <span className={`category-pill category-${categoryTone[story.category]}`}>
          {categoryLabels[story.category]}
        </span>
        <time dateTime={story.published_at}>
          Published by source {formatDateTime(story.published_at, timezone)}
        </time>
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
        <div className="importance-meter" aria-label={`Importance ${importance} out of 100`}>
          <span>{getImportanceLabel(story.importance)}</span>
          <div>
            <i style={{ width: `${importance}%` }} />
          </div>
        </div>
        <button className="details-button" onClick={onOpen} type="button">
          Open details
          <ArrowRight aria-hidden="true" size={15} strokeWidth={2.4} />
        </button>
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

function SourceProof({ story }: { story: Story }) {
  const sourceKinds = Array.from(new Set(story.source_links.map((source) => getSourceKind(source))))

  return (
    <div className="source-proof" aria-label="Source proof">
      {sourceKinds.map((kind) => (
        <span className={`source-kind source-kind-${kind.toLowerCase().replace(/\s+/g, '-')}`} key={kind}>
          {kind}
        </span>
      ))}
      <span className="source-count">{story.source_links.length} source{story.source_links.length === 1 ? '' : 's'}</span>
    </div>
  )
}

function StoryDetail({
  onBack,
  story,
  timezone,
}: {
  onBack: () => void
  story: Story
  timezone: string
}) {
  const importance = normalizeImportance(story.importance)
  const heatClass = importance >= 85 ? 'heat-hot' : importance >= 65 ? 'heat-warm' : 'heat-cool'
  const detailPoints = getDetailPoints(story)

  return (
    <article className={`detail-page ${heatClass}`}>
      <button className="back-button" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={18} strokeWidth={2.4} />
        Back to home
      </button>

      <div className="story-meta">
        <span className={`confidence-pill ${confidenceTone[story.confidence]}`}>
          {confidenceLabels[story.confidence]}
        </span>
        <span className={`category-pill category-${categoryTone[story.category]}`}>
          {categoryLabels[story.category]}
        </span>
        <time dateTime={story.published_at}>
          Published by source {formatDateTime(story.published_at, timezone)}
        </time>
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

          <div className="matter-panel">
            <span>How it may affect us</span>
            <p>{story.why_it_matters}</p>
          </div>

          <div className="detail-section">
            <span>What to watch next</span>
            <p>{getWatchNote(story)}</p>
          </div>

          <div className="topic-row" aria-label="Topics">
            {story.topics.map((topic) => (
              <span key={topic}>{topic}</span>
            ))}
          </div>
        </section>

        <aside className="detail-side">
          <div className="importance-meter" aria-label={`Importance ${importance} out of 100`}>
            <span>{getImportanceLabel(story.importance)}</span>
            <div>
              <i style={{ width: `${importance}%` }} />
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
              <dt>Confidence</dt>
              <dd>{getConfidenceDescription(story.confidence)}</dd>
            </div>
            <div>
              <dt>Sources found</dt>
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
