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


def chunked(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def request_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc}") from exc


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
    haystack = text.lower()
    market_terms = (
        "bursa",
        "market",
        "stock",
        "ringgit",
        "klci",
        "ipo",
        "investment",
        "oil",
        "fed",
        "rate",
        "earnings",
        "dividend",
    )
    malaysia_terms = (
        "malaysia",
        "bnm",
        "bernama",
        "putrajaya",
        "anwar",
        "miti",
        "dosm",
        "mykad",
    )
    if any(term in haystack for term in market_terms):
        return "markets_investment"
    if any(term in haystack for term in malaysia_terms):
        return "malaysia"
    return "world"


def topics_for(text: str) -> list[str]:
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
    return {
        "id": f"social-{platform}-{slugify(source_id)}",
        "category": category,
        "headline": summary[:96].rstrip(".") or f"{source_name} posted a new update",
        "summary": summary,
        "why_it_matters": (
            "This came from a configured social/news source and may indicate a timely "
            "development worth checking against the linked original post."
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
        "importance": 3,
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
    if source_usernames:
        queries.extend(
            f"({' OR '.join('from:' + username.lstrip('@') for username in group)}) -is:retweet -is:reply"
            for group in chunked(source_usernames, 10)
        )
    if not queries:
        queries = [
            "(Malaysia OR Bursa OR ringgit OR BNM OR Bernama OR economy OR oil OR Fed) lang:en -is:retweet"
        ]

    for query in queries:
        remaining = max(10, min(limit - len(stories), 100))
        if remaining <= 0:
            break
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
            user = users.get(item.get("author_id"), {})
            username = user.get("username", "x")
            url = f"https://x.com/{username}/status/{item.get('id')}"
            stories.append(
                make_story(
                    "x",
                    f"X @{username}",
                    url,
                    item.get("text", ""),
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
    per_page = max(1, min(limit, 25))
    fields = "message,story,created_time,permalink_url,from"
    for page in pages:
        params = urllib.parse.urlencode(
            {"fields": fields, "limit": str(per_page), "access_token": token}
        )
        payload = request_json(f"https://graph.facebook.com/{version}/{page}/posts?{params}")
        for item in payload.get("data", []):
            text = item.get("message") or item.get("story") or ""
            if not text:
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
            if not text:
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
            if not text:
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
    additions = [story for story in candidates if story["id"] not in existing_ids]
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge", action="store_true", help="Merge candidates into data/news.json.")
    parser.add_argument("--output", default=str(OUTPUT_PATH), help="Candidate output JSON path.")
    args = parser.parse_args()

    load_dotenv(ENV_PATH)
    limit = int(env("SOCIAL_FETCH_LIMIT", "12"))
    candidates: list[dict[str, Any]] = []
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
            candidates.extend(fetcher(limit))
        except RuntimeError as exc:
            print(f"WARNING: {name} fetch failed: {exc}", file=sys.stderr)

    candidates = sorted(candidates, key=lambda story: story["published_at"], reverse=True)
    output = {
        "generated_at": datetime.now(timezone.utc).astimezone(MYT).isoformat(timespec="seconds"),
        "configured": configured,
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
