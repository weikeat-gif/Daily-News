#!/usr/bin/env python3
"""Validate Daily News source-linked data."""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "news.json"
PUBLIC_DATA_PATH = ROOT / "public" / "data" / "news.json"
EXPECTED_TIMEZONE = "Asia/Kuala_Lumpur"
EXPECTED_REFRESH_INTERVAL_HOURS = 4
ALLOWED_CATEGORIES = {"malaysia", "markets_investment", "world"}
ALLOWED_CONFIDENCE = {"verified", "cross_checked", "reported_unconfirmed"}
REQUIRED_STORY_FIELDS = {
    "id",
    "category",
    "headline",
    "summary",
    "why_it_matters",
    "published_at",
    "source_links",
    "topics",
    "importance",
    "confidence",
}


def console_safe(value: object) -> str:
    encoding = sys.stdout.encoding or "utf-8"
    return str(value).encode(encoding, errors="backslashreplace").decode(encoding)


def parse_datetime(value: object, label: str, errors: list[str]) -> datetime | None:
    if not isinstance(value, str):
        errors.append(f"{label} must be a string")
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        errors.append(f"{label} must be ISO 8601: {value}")
        return None
    if parsed.tzinfo is None:
        errors.append(f"{label} must include a timezone offset")
        return None
    return parsed


def is_https_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    try:
        data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"ERROR: Missing data file: {console_safe(DATA_PATH)}")
        return 1
    except json.JSONDecodeError as exc:
        print(f"ERROR: Invalid JSON: {exc}")
        return 1

    if PUBLIC_DATA_PATH.exists():
        try:
            public_data = json.loads(PUBLIC_DATA_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"public/data/news.json is invalid JSON: {exc}")
        else:
            if public_data != data:
                errors.append("public/data/news.json must match data/news.json")

    for key in ("generated_at", "timezone", "refresh_interval_hours", "stories"):
        if key not in data:
            errors.append(f"Missing top-level field: {key}")

    generated_at = parse_datetime(data.get("generated_at"), "generated_at", errors)
    if generated_at is not None:
        now = datetime.now(generated_at.tzinfo)
        age_hours = (now - generated_at).total_seconds() / 3600
        if age_hours > EXPECTED_REFRESH_INTERVAL_HOURS:
            warnings.append(
                f"generated_at is {age_hours:.1f} hours old; refresh interval is "
                f"{EXPECTED_REFRESH_INTERVAL_HOURS} hours"
            )

    if data.get("timezone") != EXPECTED_TIMEZONE:
        errors.append(f"timezone must be {EXPECTED_TIMEZONE}")

    refresh_interval_hours = data.get("refresh_interval_hours")
    if (
        not isinstance(refresh_interval_hours, int)
        or isinstance(refresh_interval_hours, bool)
        or refresh_interval_hours != EXPECTED_REFRESH_INTERVAL_HOURS
    ):
        errors.append(
            f"refresh_interval_hours must be {EXPECTED_REFRESH_INTERVAL_HOURS}"
        )

    stories = data.get("stories")
    if not isinstance(stories, list):
        errors.append("stories must be a list")
        stories = []

    ids: set[str] = set()
    categories: Counter[str] = Counter()

    for index, story in enumerate(stories):
        prefix = f"stories[{index}]"
        if not isinstance(story, dict):
            errors.append(f"{prefix} must be an object")
            continue

        missing = REQUIRED_STORY_FIELDS - set(story)
        for field in sorted(missing):
            errors.append(f"{prefix} missing required field: {field}")

        story_id = story.get("id")
        if not isinstance(story_id, str) or not story_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif story_id in ids:
            errors.append(f"Duplicate story id: {story_id}")
        else:
            ids.add(story_id)

        category = story.get("category")
        if category not in ALLOWED_CATEGORIES:
            errors.append(f"{prefix}.category invalid: {category}")
        else:
            categories[category] += 1

        confidence = story.get("confidence")
        if confidence not in ALLOWED_CONFIDENCE:
            errors.append(f"{prefix}.confidence invalid: {confidence}")

        parse_datetime(story.get("published_at"), f"{prefix}.published_at", errors)

        sources = story.get("source_links")
        if not isinstance(sources, list) or not sources:
            errors.append(f"{prefix}.source_links must contain at least one source")
            continue

        for source_index, source in enumerate(sources):
            source_prefix = f"{prefix}.source_links[{source_index}]"
            if not isinstance(source, dict):
                errors.append(f"{source_prefix} must be an object")
                continue
            if not source.get("name"):
                errors.append(f"{source_prefix}.name is required")
            url = source.get("url")
            if not is_https_url(url):
                errors.append(f"{source_prefix}.url must be a valid https URL")
            if not source.get("publisher_type"):
                errors.append(f"{source_prefix}.publisher_type is required")

    for category in sorted(ALLOWED_CATEGORIES):
        if categories[category] < 3:
            errors.append(f"Expected at least 3 stories for category: {category}")

    for warning in warnings:
        print(f"WARNING: {warning}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(
        "OK: validated "
        f"{len(stories)} stories "
        f"({', '.join(f'{k}={categories[k]}' for k in sorted(ALLOWED_CATEGORIES))})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
