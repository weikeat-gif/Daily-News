#!/usr/bin/env python3
"""Refresh Daily News from free public RSS/news feeds.

This script is intentionally dependency-free so it can run in GitHub Actions.
It does not use paid social APIs. Social links are added as public verified
source pages when a newsroom has a curated social profile in
data/public_social_sources.json.
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "news.json"
PUBLIC_DATA_PATH = ROOT / "public" / "data" / "news.json"
SOCIAL_SOURCES_PATH = ROOT / "data" / "public_social_sources.json"
MYT = timezone(timedelta(hours=8))
MAX_STORIES = 60
MIN_CATEGORY_STORIES = 3


@dataclass(frozen=True)
class Feed:
    name: str
    url: str
    category_hint: str
    publisher_type: str = "news"


FEEDS = [
    Feed("CNA Latest", "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml", "world"),
    Feed(
        "CNA Business",
        "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936",
        "markets_investment",
    ),
    Feed(
        "CNA World",
        "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6311",
        "world",
    ),
    Feed(
        "CNA Asia",
        "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
        "world",
    ),
    Feed("Malay Mail Malaysia", "https://www.malaymail.com/feed/rss/malaysia", "malaysia"),
    Feed("Malay Mail Money", "https://www.malaymail.com/feed/rss/money", "markets_investment"),
    Feed("Malay Mail World", "https://www.malaymail.com/feed/rss/world", "world"),
    Feed(
        "BERNAMA via Google News",
        "https://news.google.com/rss/search?q=site%3Abernama.com%20Malaysia%20OR%20markets%20OR%20world&hl=en-MY&gl=MY&ceid=MY%3Aen",
        "malaysia",
    ),
    Feed(
        "The Edge Malaysia via Google News",
        "https://news.google.com/rss/search?q=site%3Atheedgemalaysia.com%20Bursa%20OR%20ringgit%20OR%20Malaysia&hl=en-MY&gl=MY&ceid=MY%3Aen",
        "markets_investment",
    ),
]

CATEGORY_KEYWORDS = {
    "malaysia": [
        "malaysia",
        "kuala lumpur",
        "putrajaya",
        "anwar",
        "bnm",
        "bank negara",
        "bursa",
        "ringgit",
        "johor",
        "selangor",
    ],
    "markets_investment": [
        "market",
        "markets",
        "bursa",
        "ringgit",
        "stock",
        "shares",
        "oil",
        "gas",
        "investment",
        "earnings",
        "bank",
        "central bank",
        "inflation",
        "rate",
    ],
    "world": [
        "world",
        "asia",
        "china",
        "u.s.",
        "united states",
        "europe",
        "iran",
        "russia",
        "war",
        "trade",
        "geopolitics",
    ],
}

WHY_IT_MATTERS = {
    "malaysia": "This is a Malaysia-focused development that can affect policy, public services, business conditions or local sentiment.",
    "markets_investment": "This can influence markets, currency, rates, corporate earnings or investor positioning.",
    "world": "This is a global or regional development that may affect risk appetite, trade, energy, technology or geopolitics.",
}


def request_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Daily-News-RSS-Refresher/1.0 (+https://github.com/weikeat-gif/Daily-News)"
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def text_of(element: ET.Element, tag: str) -> str:
    child = element.find(tag)
    return (child.text or "").strip() if child is not None else ""


def strip_html(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def parse_date(value: str) -> datetime:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(MYT)
        except (TypeError, ValueError):
            pass
    return datetime.now(timezone.utc).astimezone(MYT)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:82] or "story"


def canonical_link(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=False)
    query = [(key, value) for key, value in query if not key.lower().startswith("utm_")]
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), "")
    )


def category_for(text: str, fallback: str) -> str:
    haystack = text.lower()
    scores = {
        category: sum(1 for keyword in keywords if re.search(rf"\b{re.escape(keyword)}\b", haystack))
        for category, keywords in CATEGORY_KEYWORDS.items()
    }
    if fallback == "markets_investment" and scores.get("markets_investment", 0) > 0:
        return fallback
    best_category, best_score = max(scores.items(), key=lambda item: item[1])
    return best_category if best_score > 0 else fallback


def topics_for(text: str) -> list[str]:
    topics: list[str] = []
    haystack = text.lower()
    for keywords in CATEGORY_KEYWORDS.values():
        for keyword in keywords:
            if keyword in haystack and keyword not in topics:
                topics.append(keyword)
            if len(topics) >= 4:
                return topics
    return ["latest update"]


def social_links_by_source() -> dict[str, list[dict[str, str]]]:
    if not SOCIAL_SOURCES_PATH.exists():
        return {}
    payload = json.loads(SOCIAL_SOURCES_PATH.read_text(encoding="utf-8"))
    links: dict[str, list[dict[str, str]]] = {}
    for source in payload.get("sources", []):
        name = source.get("name", "")
        if not name:
            continue
        key = normalize_source_name(name)
        links[key] = [
            {
                "name": f"{platform.get('platform')} {name}",
                "url": platform.get("url"),
                "publisher_type": "social",
            }
            for platform in source.get("platforms", [])
            if platform.get("url")
        ][:2]
    return links


def normalize_source_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def social_links_for(feed_name: str, mapping: dict[str, list[dict[str, str]]]) -> list[dict[str, str]]:
    normalized = normalize_source_name(feed_name)
    aliases = {
        "cnalatest": "channelnewsasia",
        "cnabusiness": "channelnewsasia",
        "cnaworld": "channelnewsasia",
        "cnaasia": "channelnewsasia",
        "bernamaviagooglenews": "bernama",
        "theedgemalaysiaviagooglenews": "theedgemalaysia",
    }
    return mapping.get(aliases.get(normalized, normalized), [])


def item_to_story(item: ET.Element, feed: Feed, social_mapping: dict[str, list[dict[str, str]]]) -> dict[str, Any] | None:
    title = strip_html(text_of(item, "title"))
    link = canonical_link(text_of(item, "link"))
    description = strip_html(text_of(item, "description"))
    pub_date = parse_date(text_of(item, "pubDate"))
    if not title or not link.startswith("https://"):
        return None

    combined_text = f"{title} {description}"
    category = category_for(combined_text, feed.category_hint)
    summary = description or title
    if len(summary) > 280:
        summary = summary[:277].rstrip() + "..."

    source_links = [
        {
            "name": feed.name,
            "url": link,
            "publisher_type": feed.publisher_type,
        }
    ]
    source_links.extend(social_links_for(feed.name, social_mapping))

    return {
        "id": f"{pub_date.strftime('%Y-%m-%d')}-{slugify(title)}",
        "category": category,
        "headline": title[:130],
        "summary": summary,
        "why_it_matters": WHY_IT_MATTERS[category],
        "published_at": pub_date.isoformat(timespec="seconds"),
        "source_links": source_links,
        "topics": topics_for(combined_text),
        "importance": 4 if category in {"markets_investment", "world"} else 3,
        "confidence": "reported_unconfirmed" if len(source_links) == 1 else "cross_checked",
    }


def fetch_feed(feed: Feed, social_mapping: dict[str, list[dict[str, str]]]) -> list[dict[str, Any]]:
    try:
        xml_text = request_text(feed.url)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"WARNING: {feed.name} failed: {exc}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        print(f"WARNING: {feed.name} invalid XML: {exc}", file=sys.stderr)
        return []

    stories = []
    for item in root.findall(".//item"):
        story = item_to_story(item, feed, social_mapping)
        if story:
            stories.append(story)
    return stories


def merge_stories(fresh: list[dict[str, Any]], existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for story in fresh + existing:
        urls = {
            link.get("url")
            for link in story.get("source_links", [])
            if isinstance(link, dict) and link.get("url")
        }
        if story.get("id") in seen_ids or urls & seen_urls:
            continue
        seen_ids.add(story.get("id", ""))
        seen_urls.update(urls)
        deduped.append(story)

    deduped.sort(key=lambda story: story.get("published_at", ""), reverse=True)

    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    for category in CATEGORY_KEYWORDS:
        for story in (story for story in deduped if story.get("category") == category):
            if len([item for item in selected if item.get("category") == category]) >= MIN_CATEGORY_STORIES:
                break
            selected.append(story)
            selected_ids.add(story.get("id", ""))

    for story in deduped:
        if len(selected) >= MAX_STORIES:
            break
        if story.get("id") in selected_ids:
            continue
        selected.append(story)
        selected_ids.add(story.get("id", ""))

    selected.sort(key=lambda story: story.get("published_at", ""), reverse=True)
    return selected[:MAX_STORIES]


def main() -> int:
    current = json.loads(DATA_PATH.read_text(encoding="utf-8")) if DATA_PATH.exists() else {}
    social_mapping = social_links_by_source()
    fresh: list[dict[str, Any]] = []
    for feed in FEEDS:
        fresh.extend(fetch_feed(feed, social_mapping))

    if not fresh:
        print("ERROR: no stories fetched from public feeds", file=sys.stderr)
        return 1

    updated = {
        "generated_at": datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds"),
        "timezone": "Asia/Kuala_Lumpur",
        "refresh_interval_hours": 4,
        "stories": merge_stories(fresh, current.get("stories", [])),
    }

    DATA_PATH.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PUBLIC_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA_PATH.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"refreshed {len(fresh)} fetched stories; kept {len(updated['stories'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
