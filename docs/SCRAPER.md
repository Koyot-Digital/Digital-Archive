# Feeding the archive

Your scraper already produces JSON. This is what to do with it.

## The contract

`POST /digitalarchive/v1/ingress` with a bearer token holding the
`ingress:write` scope.

```jsonc
{
  "batchId": "nightly-2026-10-17",   // optional; strongly recommended
  "onConflict": "merge",             // merge | replace | skip
  "dryRun": false,                   // validate without writing
  "records": [ /* 1-500 records */ ]
}
```

A record:

| Field | Required | Notes |
| --- | --- | --- |
| `robloxId` | ✅ | Number or string. The subject is created on first sight. |
| `title` | ✅ | ≤ 300 chars. |
| `source` | ✅ | Your scraper's name. Half of the dedupe key. |
| `body` | | Markdown, ≤ 100KB. Links in here become embed cards. |
| `sourceId` | | Your id for this record. Derived from content if omitted. |
| `action` | | `ban` `temp_ban` `kick` `warning` `mute` `content_deletion` `account_deletion` `termination` `note` `other`. Default `other`. |
| `severity` | | `info` `low` `medium` `high` `critical`. Default `info`. |
| `reason` | | Short, ≤ 2000 chars. Shown above the body. |
| `occurredAt` | | ISO-8601, epoch seconds, or epoch millis — all accepted. |
| `sourceUrl` | | Where you found it. |
| `username`, `displayName`, `avatarUrl` | | Used to fill in the subject. A blank field never overwrites a known one. |
| `tags` | | ≤ 24, lowercased server-side. |
| `evidence` | | Arbitrary JSON object, ≤ 64KB serialised. |
| `imageUrls` | | ≤ 24. Fetched, converted to WebP and attached after the response. |
| `imageIds` | | ≤ 24 already-uploaded image ids to attach. |

### Conflict policy

Dedupe is on `source` + `sourceId`.

- **`merge`** (default) — update the record, *unless* a human has edited it.
  Use this for a recurring scrape: it keeps your data fresh without ever
  reverting a moderator's correction.
- **`replace`** — always overwrite. The old state still lands in the revision
  history, labelled as an ingress replace.
- **`skip`** — never touch an existing record. Use for a backfill where you
  only want the rows you do not already have.

### Response

```jsonc
{
  "batchId": "nightly-2026-10-17",
  "dryRun": false,
  "replayed": false,
  "counts": { "received": 50, "created": 12, "updated": 31, "skipped": 7, "failed": 0, "imagesQueued": 18 },
  "created": [{ "id": "7f3kq2m8xhv40bre", "robloxId": "156", "url": "https://archive.domain.com/..." }],
  "errors": []
}
```

Status codes: `200` normally, `207` if every record failed, `401`/`403` for
credential problems, `422` with per-field `details` for a schema failure,
`429` with `retryAfterMs` when rate limited.

`"replayed": true` means this `batchId` was already processed — the response is
the original result, nothing was written. That is the behaviour you want from a
cron that timed out and retried.

---

## A client that handles the awkward parts

Batching, retries with backoff, idempotency keys and optional HMAC signing.

```python
"""Post scraped moderation records to the Digital Archive."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from datetime import date
from typing import Any, Iterable, Iterator

import requests

API = os.environ["ARCHIVE_API"]          # https://api.domain.com/digitalarchive/v1
TOKEN = os.environ["ARCHIVE_TOKEN"]      # da_...
HMAC_SECRET = os.environ.get("ARCHIVE_HMAC_SECRET")  # only if the server enforces it
SOURCE = "my-scraper"
BATCH_SIZE = 200                          # server cap is 500; smaller retries cheaper


def chunked(items: list[Any], size: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def post_batch(records: list[dict], batch_id: str, on_conflict: str = "merge") -> dict:
    payload = {"batchId": batch_id, "onConflict": on_conflict, "records": records}

    # Sign the exact bytes we send: the server verifies against the raw body,
    # so re-serialising with different key order or spacing would not match.
    body = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode()

    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        # Second line of defence if batchId is ever omitted.
        "X-Idempotency-Key": batch_id,
    }
    if HMAC_SECRET:
        digest = hmac.new(HMAC_SECRET.encode(), body, hashlib.sha256).hexdigest()
        headers["X-Archive-Signature"] = f"sha256={digest}"

    backoff = 2.0
    for attempt in range(5):
        res = requests.post(f"{API}/ingress", data=body, headers=headers, timeout=180)

        if res.status_code in (200, 207):
            return res.json()

        # Honour the server's own retry hint rather than guessing.
        if res.status_code == 429:
            wait = res.json().get("error", {}).get("retryAfterMs", backoff * 1000) / 1000
            time.sleep(wait)
            continue

        # 4xx other than 429 will not succeed on retry; surface it now.
        if 400 <= res.status_code < 500:
            raise RuntimeError(f"ingress rejected the batch: {res.status_code} {res.text}")

        # 5xx / 503 under load: back off and try again. The batchId makes this
        # safe even if the server actually committed the first attempt.
        time.sleep(backoff)
        backoff *= 2

    raise RuntimeError("ingress unreachable after 5 attempts")


def to_record(scraped: dict) -> dict:
    """Map one row of your scraper's output onto the archive's schema."""
    return {
        "robloxId": scraped["user_id"],
        "username": scraped.get("username"),
        "displayName": scraped.get("display_name"),
        "title": scraped["headline"][:300],
        "body": scraped.get("details", ""),
        "action": scraped.get("action", "other"),
        "severity": scraped.get("severity", "info"),
        "reason": scraped.get("reason"),
        "occurredAt": scraped.get("timestamp"),
        "source": SOURCE,
        # A stable id from the source system is what makes re-scrapes idempotent.
        "sourceId": str(scraped["case_id"]),
        "sourceUrl": scraped.get("url"),
        "tags": scraped.get("tags", []),
        "evidence": scraped.get("extra", {}),
        "imageUrls": scraped.get("screenshots", []),
    }


def push(scraped_rows: Iterable[dict]) -> None:
    records = [to_record(row) for row in scraped_rows]
    totals = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}

    for index, batch in enumerate(chunked(records, BATCH_SIZE)):
        # Deterministic per run *and* per batch, so a retry of batch 3 does not
        # look like batch 4.
        batch_id = f"{SOURCE}-{date.today().isoformat()}-{index:04d}"
        result = post_batch(batch, batch_id)

        for key in totals:
            totals[key] += result["counts"][key]

        if result["replayed"]:
            print(f"batch {index}: already ingested, skipped")
        for err in result["errors"]:
            print(f"  record {err['index']} (roblox {err['robloxId']}): {err['message']}")

    print(f"done: {totals}")


if __name__ == "__main__":
    # Verify the credential before doing any work.
    who = requests.get(
        f"{API}/ingress/whoami",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    )
    who.raise_for_status()
    print("authenticated as", who.json()["key"]["name"])

    push(load_your_scraped_rows())  # your function
```

### Uploading images directly

If your scraper holds the bytes rather than a URL, upload them first and pass
the returned ids as `imageIds`:

```sh
curl -X POST https://api.domain.com/digitalarchive/v1/images \
  -H "Authorization: Bearer da_…" \
  -F "modlogId=7f3kq2m8xhv40bre" \
  -F "caption=Chat log, 09:48" \
  -F "file=@evidence.png"
```

Send the `modlogId` field **before** the file parts — the server reads the
stream in order and needs to know where the image belongs before it starts
converting it.

---

## Running it on a schedule

A cron entry on the homeserver is enough. The idempotency guard means overlap
and retries are harmless:

```cron
# every night at 03:15
15 3 * * *  cd /srv/scraper && ./venv/bin/python push.py >> /var/log/archive-scrape.log 2>&1
```

Point your monitoring at `GET /digitalarchive/v1/ingress/whoami` rather than at
`/ingress` — it confirms the credential, its scopes and its rate budget without
writing anything.

Ingest runs are visible afterwards in the moderation log, as
`ingress.batch` entries carrying the counts, and the dashboard's "last ingest"
figure comes from the newest record.
