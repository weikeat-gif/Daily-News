#!/usr/bin/env python3
"""Fetch source-linked news candidates from X, Facebook, and Instagram APIs.

The script is credential-safe: missing credentials skip that platform instead of
failing. It writes candidate stories to data/social_candidates.json and can
optionally merge them into data/news.json with --merge.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
OUTPUT_PATH = ROOT / "data" / "social_candidates.json"
NEWS_PATH = ROOT / "data" / "news.json"
PUBLIC_NEWS_PATH = ROOT / "public" / "data" / "news.json"
MYT = timezone(timedelta(hours=8))
DEFAULT_TARGET_KEYWORDS = (
    "Malaysia",
    "Bursa",
    "ringgit",
    "BNM",
    "Bank Negara",
    "Bernama",
    "KLSE",
    "KLCI",
    "investment",
    "markets",
    "economy",
    "inflation",
    "interest rate",
    "oil",
    "palm oil",
    "technology",
    "AI",
    "geopolitics",
    "world news",
)
DEFAULT_EXCLUDE_KEYWORDS = (
    "giveaway",
    "contest",
    "promo code",
    "voucher",
    "sale",
)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def csv_env(name: str) -> list[str]:
    return [item.strip() for item in env(name).split(",") if item.strip()]


def category_keywords() -> dict[str, list[str]]:
    return {
        "malaysia": csv_env("SOCIAL_TOPIC_MALAYSIA")
        or [
            "Malaysia",
            "BNM",
            "Bank Negara",
            "Bernama",
            "Putrajaya",
            "Anwar",
            "MITI",
            "DOSM",
            "parliament",
            "policy",
            "subsidy",
        ],
        "markets_investment": csv_env("SOCIAL_TOPIC_MARKETS")
        or [
            "Bursa",
            "ringgit",
            "KLSE",
            "KLCI",
            "IPO",
            "earnings",
            "dividend",
            "investment",
            "markets",
            "oil",
            "palm oil",
            "gold",
            "Fed",
            "rate",
            "inflation",
        ],
        "world": csv_env("SOCIAL_TOPIC_WORLD")
        or [
            "world news",
            "geopolitics",
            "US",
            "China",
            "ASEAN",
            "EU",
            "war",
            "trade",
            "central bank",
            "technology",
            "AI",
            "oil",
        ],
    }


def target_keywords() -> list[str]:
    configured = csv_env("SOCIAL_TARGET_KEYWORDS")
    combined = configured or list(DEFAULT_TARGET_KEYWORDS)
    for keywords in category_keywords().values():
        combined.extend(keywords)
    return list(dict.fromkeys(combined))


def exclude_keywords() -> list[str]:
    return csv_env("SOCIAL_EXCLUDE_KEYWORDS") or list(DEFAULT_EXCLUDE_KEYWORDS)


def chunked(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def request_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {redact_url(url)}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {redact_url(url)}: {exc}") from exc


def redact_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted_query = urllib.parse.urlencode(
        (key, "REDACTED" if key.lower() in {"access_token", "token"} else value)
        for key, value in query
    )
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, redacted_query, parsed.fragment)
    )


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:72] or "social-story"


def clean_text(value: str) -> str:
    value = re.sub(r"https?://\S+", "", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def short_summary(text: str) -> str:
    text = clean_text(text)
    if len(text) <= 240:
        return text or "Social post update from a configured source."
    return text[:237].rstrip() + "..."


def category_for(text: str) -> str:
    scores = {
        category: sum(matches_term(text, term) for term in keywords)
        for category, keywords in category_keywords().items()
    }
    best_category, best_score = max(scores.items(), key=lambda item: item[1])
    return best_category if best_score > 0 else "world"


def topics_for(text: str) -> list[str]:
    matched = matched_keywords(text)
    if matched:
        return matched[:4]
    words = []
    for candidate in re.findall(r"#?([A-Za-z][A-Za-z0-9]{2,})", text):
        lowered = candidate.lower()
        if lowered in {"the", "and", "for", "with", "from", "this", "that", "are", "you"}:
            continue
        if lowered not in words:
            words.append(lowered)
        if len(words) == 4:
            break
    return words or ["social update"]


def relevance_score(text: str) -> int:
    if not clean_text(text):
        return 0
    if any(matches_term(text, term) for term in exclude_keywords()):
        return 0
    return len(matched_keywords(text))


def matches_term(text: str, term: str) -> bool:
    cleaned = clean_text(text)
    haystack = cleaned.lower()
    raw_needle = term.strip()
    needle = raw_needle.lower()
    if not needle:
        return False
    compact_hashtag = f"#{needle.replace(' ', '')}"
    if compact_hashtag in haystack:
        return True
    case_sensitive = raw_needle.isupper() and len(raw_needle) <= 3
    search_text = cleaned if case_sensitive else haystack
    search_term = raw_needle if case_sensitive else needle
    escaped_words = [re.escape(part) for part in search_term.split()]
    boundary = r"A-Za-z0-9" if case_sensitive else r"a-z0-9"
    pattern = rf"(?<![{boundary}])" + r"\s+".join(escaped_words) + rf"(?![{boundary}])"
    return re.search(pattern, search_text) is not None


def matched_keywords(text: str) -> list[str]:
    return [term for term in target_keywords() if matches_term(text, term)]


def is_target_relevant(text: str) -> bool:
    return relevance_score(text) > 0


def x_query_term(term: str) -> str:
    stripped = term.strip()
    if " " in stripped:
        return f'"{stripped}"'
    return stripped


def to_myt_iso(value: str | None) -> str:
    if not value:
        return datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds")
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).astimezone(MYT).isoformat(timespec="seconds")
    except ValueError:
        return datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds")


def make_story(
    platform: str,
    source_name: str,
    url: str,
    text: str,
    published_at: str | None,
    source_id: str,
) -> dict[str, Any]:
    summary = short_summary(text)
    category = category_for(text)
    score = relevance_score(text)
    matches = matched_keywords(text)
    source_label = source_name.replace(" on Instagram", "")
    headline = summary[:96].rstrip(".")
    if not headline.lower().startswith(source_label.lower()[:20]):
        headline = f"{source_label}: {headline}"[:110].rstrip()
    return {
        "id": f"social-{platform}-{slugify(source_id)}",
        "category": category,
        "headline": headline or f"{source_name} posted a new update",
        "summary": summary,
        "why_it_matters": (
            f"Matched target topic{'s' if len(matches) != 1 else ''}: "
            f"{', '.join(matches[:4])}. This social update may point to a timely "
            "development, so it is linked for checking against the original post."
        ),
        "published_at": to_myt_iso(published_at),
        "source_links": [
            {
                "name": source_name,
                "url": url,
                "publisher_type": "social",
            }
        ],
        "topics": topics_for(text),
        "matched_keywords": matches[:8],
        "importance": min(5, max(3, score + 2)),
        "confidence": "reported_unconfirmed",
    }


def fetch_x(limit: int) -> list[dict[str, Any]]:
    token = env("X_BEARER_TOKEN")
    if not token:
        return []

    stories = []
    explicit_query = env("X_NEWS_QUERY")
    source_usernames = csv_env("X_SOURCE_USERNAMES")
    queries = [explicit_query] if explicit_query else []
    keyword_groups = chunked(target_keywords(), 8)
    for keyword_group in keyword_groups:
        keyword_query = f"({' OR '.join(x_query_term(term) for term in keyword_group)}) lang:en -is:retweet -is:reply"
        queries.append(keyword_query)
    if source_usernames:
        for source_group in chunked(source_usernames, 10):
            source_query = f"({' OR '.join('from:' + username.lstrip('@') for username in source_group)})"
            queries.append(f"{source_query} -is:retweet -is:reply")
            for keyword_group in keyword_groups[:2]:
                keyword_query = f"({' OR '.join(x_query_term(term) for term in keyword_group)})"
                queries.append(f"{source_query} {keyword_query} -is:retweet -is:reply")
    if not queries:
        queries = [
            "(Malaysia OR Bursa OR ringgit OR BNM OR Bernama OR economy OR oil OR Fed) lang:en -is:retweet"
        ]
    queries = list(dict.fromkeys(query for query in queries if query))

    for query in queries:
        remaining_needed = limit - len(stories)
        if remaining_needed <= 0:
            break
        remaining = max(10, min(remaining_needed, 100))
        params = urllib.parse.urlencode(
            {
                "query": query,
                "max_results": str(remaining),
                "tweet.fields": "created_at,author_id,public_metrics",
                "expansions": "author_id",
                "user.fields": "username,name,verified,verified_type",
            }
        )
        payload = request_json(
            f"https://api.x.com/2/tweets/search/recent?{params}",
            {"Authorization": f"Bearer {token}"},
        )
        users = {
            user["id"]: user
            for user in payload.get("includes", {}).get("users", [])
            if isinstance(user, dict) and "id" in user
        }
        for item in payload.get("data", []):
            text = item.get("text", "")
            if not is_target_relevant(text):
                continue
            user = users.get(item.get("author_id"), {})
            username = user.get("username", "x")
            url = f"https://x.com/{username}/status/{item.get('id')}"
            stories.append(
                make_story(
                    "x",
                    f"X @{username}",
                    url,
                    text,
                    item.get("created_at"),
                    str(item.get("id", url)),
                )
            )
    return stories[:limit]


def fetch_facebook(limit: int) -> list[dict[str, Any]]:
    token = env("FACEBOOK_ACCESS_TOKEN")
    pages = csv_env("FACEBOOK_PAGE_IDS")
    if not token or not pages:
        return []

    version = env("SOCIAL_GRAPH_VERSION", "v25.0")
    stories: list[dict[str, Any]] = []
    per_page = max(1, min(limit * 3, 100))
    fields = "message,story,created_time,permalink_url,from"
    for page in pages:
        params = urllib.parse.urlencode(
            {"fields": fields, "limit": str(per_page), "access_token": token}
        )
        payload = request_json(f"https://graph.facebook.com/{version}/{page}/posts?{params}")
        for item in payload.get("data", []):
            text = item.get("message") or item.get("story") or ""
            if not text or not is_target_relevant(text):
                continue
            source_name = item.get("from", {}).get("name") or f"Facebook {page}"
            stories.append(
                make_story(
                    "facebook",
                    source_name,
                    item.get("permalink_url", f"https://www.facebook.com/{page}"),
                    text,
                    item.get("created_time"),
                    str(item.get("id", f"{page}-{len(stories)}")),
                )
            )
            if len(stories) >= limit:
                return stories
    return stories


def fetch_instagram(limit: int) -> list[dict[str, Any]]:
    token = env("INSTAGRAM_ACCESS_TOKEN")
    ig_user_id = env("INSTAGRAM_BUSINESS_ACCOUNT_ID")
    accounts = csv_env("INSTAGRAM_SOURCE_ACCOUNTS")
    hashtags = csv_env("INSTAGRAM_HASHTAGS")
    if not token or not ig_user_id or not (accounts or hashtags):
        return []

    version = env("SOCIAL_GRAPH_VERSION", "v25.0")
    stories: list[dict[str, Any]] = []
    for account in accounts:
        fields = (
            f"business_discovery.username({account.lstrip('@')})"
            f"{{username,name,media.limit({max(1, min(limit, 25))})"
            "{id,caption,permalink,timestamp,media_type}}}"
        )
        params = urllib.parse.urlencode({"fields": fields, "access_token": token})
        payload = request_json(f"https://graph.facebook.com/{version}/{ig_user_id}?{params}")
        discovery = payload.get("business_discovery", {})
        source_username = discovery.get("username") or account.lstrip("@")
        source_name = discovery.get("name") or f"Instagram @{source_username}"
        media_items = discovery.get("media", {}).get("data", [])
        for item in media_items:
            text = item.get("caption", "")
            if not text or not is_target_relevant(text):
                continue
            stories.append(
                make_story(
                    "instagram",
                    f"{source_name} on Instagram",
                    item.get("permalink", f"https://www.instagram.com/{source_username}/"),
                    text,
                    item.get("timestamp"),
                    str(item.get("id", f"{source_username}-{len(stories)}")),
                )
            )
            if len(stories) >= limit:
                return stories

    for hashtag in hashtags:
        search_params = urllib.parse.urlencode(
            {"user_id": ig_user_id, "q": hashtag, "access_token": token}
        )
        hashtag_payload = request_json(
            f"https://graph.facebook.com/{version}/ig_hashtag_search?{search_params}"
        )
        hashtag_id = next(
            (
                item.get("id")
                for item in hashtag_payload.get("data", [])
                if isinstance(item, dict) and item.get("id")
            ),
            None,
        )
        if not hashtag_id:
            continue
        media_params = urllib.parse.urlencode(
            {
                "user_id": ig_user_id,
                "fields": "id,caption,permalink,timestamp,media_type",
                "limit": str(max(1, min(limit, 25))),
                "access_token": token,
            }
        )
        media_payload = request_json(
            f"https://graph.facebook.com/{version}/{hashtag_id}/recent_media?{media_params}"
        )
        for item in media_payload.get("data", []):
            text = item.get("caption", "")
            if not text or not is_target_relevant(text):
                continue
            stories.append(
                make_story(
                    "instagram",
                    f"Instagram #{hashtag}",
                    item.get("permalink", f"https://www.instagram.com/explore/tags/{hashtag}/"),
                    text,
                    item.get("timestamp"),
                    str(item.get("id", f"{hashtag}-{len(stories)}")),
                )
            )
            if len(stories) >= limit:
                return stories
    return stories


def merge_candidates(candidates: list[dict[str, Any]]) -> int:
    if not NEWS_PATH.exists() or not candidates:
        return 0
    data = json.loads(NEWS_PATH.read_text(encoding="utf-8"))
    stories = data.get("stories", [])
    existing_ids = {story.get("id") for story in stories if isinstance(story, dict)}
    existing_urls = {
        link.get("url")
        for story in stories
        if isinstance(story, dict)
        for link in story.get("source_links", [])
        if isinstance(link, dict)
    }
    existing_text_keys = {
        normalized_text_key(story.get("headline", "") + " " + story.get("summary", ""))
        for story in stories
        if isinstance(story, dict)
    }
    additions = []
    for story in candidates:
        story_urls = {
            link.get("url")
            for link in story.get("source_links", [])
            if isinstance(link, dict) and link.get("url")
        }
        text_key = normalized_text_key(story.get("headline", "") + " " + story.get("summary", ""))
        if story["id"] in existing_ids or story_urls & existing_urls or text_key in existing_text_keys:
            continue
        additions.append(story)
        existing_ids.add(story["id"])
        existing_urls.update(story_urls)
        existing_text_keys.add(text_key)
    if not additions:
        return 0
    data["stories"] = sorted(
        additions + stories,
        key=lambda story: story.get("published_at", ""),
        reverse=True,
    )
    data["generated_at"] = datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds")
    NEWS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PUBLIC_NEWS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_NEWS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return len(additions)


def normalized_text_key(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", clean_text(text).lower())
    return " ".join(words[:16])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge", action="store_true", help="Merge candidates into data/news.json.")
    parser.add_argument("--output", default=str(OUTPUT_PATH), help="Candidate output JSON path.")
    args = parser.parse_args()

    load_dotenv(ENV_PATH)
    limit = int(env("SOCIAL_FETCH_LIMIT", "12"))
    candidates: list[dict[str, Any]] = []
    platform_counts: dict[str, int] = {}
    configured = {
        "x": bool(env("X_BEARER_TOKEN")),
        "facebook": bool(env("FACEBOOK_ACCESS_TOKEN") and csv_env("FACEBOOK_PAGE_IDS")),
        "instagram": bool(
            env("INSTAGRAM_ACCESS_TOKEN")
            and env("INSTAGRAM_BUSINESS_ACCOUNT_ID")
            and (csv_env("INSTAGRAM_SOURCE_ACCOUNTS") or csv_env("INSTAGRAM_HASHTAGS"))
        ),
    }

    for name, fetcher in (
        ("x", fetch_x),
        ("facebook", fetch_facebook),
        ("instagram", fetch_instagram),
    ):
        try:
            platform_stories = fetcher(limit)
            platform_counts[name] = len(platform_stories)
            candidates.extend(platform_stories)
        except RuntimeError as exc:
            platform_counts[name] = 0
            print(f"WARNING: {name} fetch failed: {exc}", file=sys.stderr)

    candidates = sorted(candidates, key=lambda story: story["published_at"], reverse=True)
    output = {
        "generated_at": datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds"),
        "configured": configured,
        "target_keywords": target_keywords(),
        "platform_counts": platform_counts,
        "count": len(candidates),
        "stories": candidates,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    merged = merge_candidates(candidates) if args.merge else 0
    print(
        json.dumps(
            {
                "configured": configured,
                "platform_counts": platform_counts,
                "candidates": len(candidates),
                "merged": merged,
                "output": str(output_path),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
