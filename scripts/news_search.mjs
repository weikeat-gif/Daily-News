const MYT_OFFSET = "+08:00";
const SEARCH_WINDOW = "when:14d";

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/<\/?[^>\s]+[^>]*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function extractTag(itemXml, tagName) {
  const match = itemXml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(decodeEntities(rawUrl));
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sourceFromTitle(title) {
  const parts = title.split(/\s+[-–—]\s+/);
  return parts.length > 1 ? cleanSourceName(parts.at(-1)?.trim() || "News source") : "News source";
}

function cleanSourceName(value) {
  return value.split(/\s+[-–—]\s+/)[0]?.trim() || "News source";
}

function cleanTitle(rawTitle, sourceName) {
  let title = rawTitle.trim();
  if (sourceName && sourceName !== "News source") {
    title = title.replace(new RegExp(`\\s+[-–—]\\s+${escapeRegExp(sourceName)}\\s*$`, "i"), "");
  }
  title = title.replace(/\s+\|\s+[^|]{2,60}$/, "").trim();
  title = title.replace(/\s+[-–—]\s+[^-–—]{2,80}$/, "").trim();
  if (sourceName && sourceName !== "News source") {
    title = title.replace(new RegExp(`\\s+[-–—]\\s+${escapeRegExp(sourceName)}\\s*$`, "i"), "");
  }
  return title.trim() || rawTitle;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMytIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  const mytDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return mytDate.toISOString().replace("Z", MYT_OFFSET);
}

function classify(text) {
  const haystack = text.toLowerCase();
  if (
    /\b(stock|shares|market|markets|earnings|revenue|profit|investment|investor|nasdaq|nyse|bursa|ringgit|rate|inflation|tariff|oil|ev|deliveries|returns|valuation)\b/.test(
      haystack,
    )
    || /\b(bull case|bear case)\b/.test(haystack)
  ) {
    return "markets_investment";
  }
  if (/\b(malaysia|kuala lumpur|putrajaya|bursa malaysia|bank negara|ringgit)\b/.test(haystack)) {
    return "malaysia";
  }
  return "world";
}

function topicsFor(text, query) {
  const topics = [query];
  const candidates = text.match(/\b[A-Z][A-Za-z0-9&.-]{2,}\b/g) || [];
  for (const candidate of candidates) {
    if (topics.some((topic) => topic.toLowerCase() === candidate.toLowerCase())) continue;
    topics.push(candidate);
    if (topics.length >= 4) break;
  }
  return topics;
}

function summarize(description, title, sourceName, query) {
  const fallback = summaryFromTitle(title, sourceName, query);
  const cleanedDescription = description.replace(/\s+/g, " ").trim();
  const repeatedTitle = title.toLowerCase();
  const normalizedDescription = cleanedDescription.toLowerCase();
  const normalizedSource = sourceName.toLowerCase();
  const base =
    cleanedDescription &&
    !cleanedDescription.includes("href=") &&
    !cleanedDescription.includes("&nbsp;") &&
    normalizedDescription !== repeatedTitle &&
    !normalizedDescription.startsWith(`${repeatedTitle} `) &&
    !(normalizedDescription.includes(repeatedTitle) && normalizedDescription.includes(normalizedSource))
      ? cleanedDescription
      : fallback;

  return truncateText(base, 220);
}

function whyItMatters(category, query) {
  if (category === "markets_investment") {
    return `This may affect investors, related stocks, supplier demand, sector sentiment, and market risk around ${query}. Watch for follow-up moves in share prices, regulation, earnings, and competitor reactions.`;
  }
  if (category === "malaysia") {
    return `This may affect Malaysia-focused businesses, consumers, policy decisions, or local market sentiment connected to ${query}. It is worth tracking for practical spillovers at home.`;
  }
  return `This may affect public safety, regulation, consumer trust, market confidence, or the wider discussion around ${query}. It helps show what risk or opportunity people may need to watch next.`;
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength - 3);
  const lastBreak = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("."), clipped.lastIndexOf(","));
  const safeClip = lastBreak > 120 ? clipped.slice(0, lastBreak) : clipped;
  return `${safeClip.trim()}...`;
}

function summaryFromTitle(title, sourceName, query) {
  const lowerTitle = title.toLowerCase();
  if (/\bcrash|fatal|killed|death|accident|autopilot|recall|probe|investigat/.test(lowerTitle)) {
    return `${sourceName} reports that ${title}. The update appears to involve safety, responsibility, or regulatory questions connected to ${query}.`;
  }
  if (/\bearnings|revenue|profit|stock|shares|market|deliveries|sales|price|returns|bull|bear|valuation\b/.test(lowerTitle)) {
    return `${sourceName} reports that ${title}. The story may be relevant for investors watching ${query}, demand trends, and market expectations.`;
  }
  if (/\blaunch|reveals|announces|unveils|plans|coming soon|expands\b/.test(lowerTitle)) {
    return `${sourceName} reports that ${title}. The news points to a product, strategy, or expansion update related to ${query}.`;
  }
  return `${sourceName} reports that ${title}. The update adds new context to the latest public discussion around ${query}.`;
}

function impactFromTitle(title, category, query) {
  const lowerTitle = title.toLowerCase();
  if (/\bcrash|fatal|killed|death|accident|autopilot|recall|probe|investigat/.test(lowerTitle)) {
    return `This may affect public safety, consumer trust, insurance risk, and regulator attention around ${query}. It can also influence how people judge autonomous-driving claims and brand reliability.`;
  }
  if (/\bearnings|revenue|profit|stock|shares|market|deliveries|sales|price|returns|bull|bear|valuation\b/.test(lowerTitle)) {
    return `This may affect investors, related stocks, demand expectations, and market sentiment around ${query}. It is worth watching for price moves and analyst reactions.`;
  }
  if (/\blaunch|reveals|announces|unveils|plans|coming soon|expands\b/.test(lowerTitle)) {
    return `This may affect customer interest, competitor response, future revenue expectations, and the product roadmap around ${query}.`;
  }
  return whyItMatters(category, query);
}

function importanceForTitle(title, category) {
  const lowerTitle = title.toLowerCase();
  if (/\bfatal|killed|death|crash|recall|probe|investigat/.test(lowerTitle)) return 5;
  if (/\bstock|shares|earnings|revenue|profit|deliveries|market|returns|bull|bear|valuation\b/.test(lowerTitle)) return 4;
  if (/\blaunch|reveals|announces|unveils|plans\b/.test(lowerTitle)) return 4;
  return category === "markets_investment" ? 4 : 3;
}

function parseGoogleNews(xmlText, query) {
  const items = [...xmlText.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const stories = [];

  for (const [index, match] of items.entries()) {
    const itemXml = match[1];
    const rawTitle = stripHtml(extractTag(itemXml, "title"));
    const link = canonicalUrl(stripHtml(extractTag(itemXml, "link")));
    const description = stripHtml(extractTag(itemXml, "description"));
    const publishedAt = toMytIso(stripHtml(extractTag(itemXml, "pubDate")));
    const sourceName = cleanSourceName(stripHtml(extractTag(itemXml, "source")) || sourceFromTitle(rawTitle));
    const title = cleanTitle(rawTitle, sourceName);
    const category = classify(`${title} ${description}`);

    if (!title || !link.startsWith("https://")) continue;

    stories.push({
      id: `search-${Date.parse(publishedAt) || Date.now()}-${index}-${slugify(title)}`,
      category,
      headline: title,
      summary: summarize(description, title, sourceName, query),
      why_it_matters: impactFromTitle(title, category, query),
      published_at: publishedAt,
      source_links: [
        {
          name: sourceName,
          url: link,
          publisher_type: "news_search",
        },
      ],
      topics: topicsFor(`${title} ${description}`, query),
      importance: importanceForTitle(title, category),
      confidence: "reported_unconfirmed",
    });
  }

  return stories;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "story";
}

function dedupeStories(stories) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const unique = [];

  for (const story of stories) {
    const url = story.source_links[0]?.url;
    const titleKey = story.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!url || seenUrls.has(url) || seenTitles.has(titleKey)) continue;
    seenUrls.add(url);
    seenTitles.add(titleKey);
    unique.push(story);
  }

  return unique.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

export async function searchNews(query, options = {}) {
  const trimmedQuery = String(query || "").trim().slice(0, 120);
  if (trimmedQuery.length < 2) {
    return {
      query: trimmedQuery,
      generated_at: new Date().toISOString(),
      timezone: "Asia/Kuala_Lumpur",
      stories: [],
      error: "Please search at least two characters.",
    };
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 18, 30));
  const encodedQuery = encodeURIComponent(`${trimmedQuery} ${SEARCH_WINDOW}`);
  const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-MY&gl=MY&ceid=MY:en`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Daily-News-AI-Search/1.0 (+https://github.com/weikeat-gif/Daily-News)",
    },
  });

  if (!response.ok) {
    throw new Error(`News search returned ${response.status}`);
  }

  const xmlText = await response.text();
  return {
    query: trimmedQuery,
    generated_at: new Date().toISOString(),
    timezone: "Asia/Kuala_Lumpur",
    source: "Google News public RSS search",
    stories: dedupeStories(parseGoogleNews(xmlText, trimmedQuery)).slice(0, limit),
  };
}
