import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RotateCcw, Search } from 'lucide-react'

type Category = 'malaysia' | 'markets_investment' | 'world'
type Confidence = 'verified' | 'cross_checked' | 'reported_unconfirmed'

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

const categoryOrder: Array<Category | 'all'> = ['all', 'malaysia', 'markets_investment', 'world']
const confidenceOrder: Array<Confidence | 'all'> = [
  'all',
  'verified',
  'cross_checked',
  'reported_unconfirmed',
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

function getImportanceLabel(score: number) {
  const normalizedScore = normalizeImportance(score)
  if (normalizedScore >= 85) return 'High signal'
  if (normalizedScore >= 65) return 'Worth tracking'
  return 'Developing'
}

function normalizeImportance(score: number) {
  if (!Number.isFinite(score)) return 0
  const scaledScore = score <= 5 ? score * 20 : score
  return Math.max(0, Math.min(Math.round(scaledScore), 100))
}

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all')
  const [activeConfidence, setActiveConfidence] = useState<Confidence | 'all'>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadNews() {
      try {
        const response = await fetch('/data/news.json', {
          cache: 'no-store',
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`News feed returned ${response.status}`)
        }

        const json = (await response.json()) as unknown
        if (!isNewsPayload(json)) {
          throw new Error('News feed shape does not match the shared contract')
        }

        setLoadState({ status: 'loaded', data: json })
      } catch (error) {
        if (controller.signal.aborted) return
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the briefing',
        })
      }
    }

    loadNews()

    return () => controller.abort()
  }, [])

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

  const stories = loadState.status === 'loaded' ? loadState.data.stories : []
  const normalizedQuery = query.trim().toLowerCase()

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
      .sort((a, b) => normalizeImportance(b.importance) - normalizeImportance(a.importance))
  }, [activeCategory, activeConfidence, normalizedQuery, stories])

  const data = loadState.status === 'loaded' ? loadState.data : null
  const topStory = filteredStories[0]

  return (
    <main className="app-shell">
      <section className="briefing-header" aria-labelledby="page-title">
        <div className="brand-row">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <span className="brand-name">Daily News</span>
        </div>

        <div className="headline-grid">
          <div className="headline-copy">
            <p className="section-kicker">Morning briefing</p>
            <h1 id="page-title">A calmer read on the stories moving today.</h1>
            <p className="lede">
              Scan the most important Malaysia, markets, and world updates with clear context,
              confidence labels, and direct source access.
            </p>
          </div>

          <aside className="briefing-status" aria-label="Briefing status">
            {data ? (
              <>
                <span>Generated</span>
                <strong>{formatDateTime(data.generated_at, data.timezone)}</strong>
                <span>Refresh rhythm</span>
                <strong>Every {data.refresh_interval_hours} hours</strong>
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

      <section className="controls-band" aria-label="Story controls">
        <label className="search-field">
          <span>Search</span>
          <div className="search-input-wrap">
            <Search aria-hidden="true" size={18} strokeWidth={2.2} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Headline, topic, source..."
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

      {loadState.status === 'loading' && <LoadingState />}
      {loadState.status === 'error' && <ErrorState message={loadState.message} />}

      {loadState.status === 'loaded' && (
        <>
          <section className="summary-strip" aria-label="Briefing summary">
            <Metric label="Stories" value={stories.length.toString()} />
            <Metric label="Showing" value={filteredStories.length.toString()} />
            <Metric label="Top signal" value={topStory ? getImportanceLabel(topStory.importance) : 'None'} />
          </section>

          {filteredStories.length > 0 ? (
            <section className="story-grid" aria-label="Filtered stories">
              {filteredStories.map((story) => (
                <StoryCard key={story.id} story={story} timezone={loadState.data.timezone} />
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

function StoryCard({ story, timezone }: { story: Story; timezone: string }) {
  const importance = normalizeImportance(story.importance)

  return (
    <article className="story-card">
      <div className="story-meta">
        <span className={`confidence-pill ${confidenceTone[story.confidence]}`}>
          {confidenceLabels[story.confidence]}
        </span>
        <span className={`category-pill category-${categoryTone[story.category]}`}>
          {categoryLabels[story.category]}
        </span>
        <time dateTime={story.published_at}>{formatDateTime(story.published_at, timezone)}</time>
      </div>

      <h2>{story.headline}</h2>
      <p className="story-summary">{story.summary}</p>

      <div className="matter-panel">
        <span>Why it matters</span>
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

        <div className="source-row" aria-label="Sources">
          {story.source_links.map((source) => (
            <a
              href={source.url}
              key={`${story.id}-${source.url}`}
              rel="noreferrer"
              target="_blank"
              title={`${source.name} via ${getSourceHost(source.url)}`}
            >
              {source.name}
              <ExternalLink aria-hidden="true" size={15} strokeWidth={2.3} />
            </a>
          ))}
        </div>
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
