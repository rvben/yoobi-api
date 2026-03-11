# yoobi-api

API for [Yoobi](https://www.yoobi.nl/) timesheets, built with [Playwright](https://playwright.dev/) browser automation.

## Why?

Yoobi is a Dutch project management and timesheet platform. It has no public API for managing timesheet data. This project wraps the Yoobi web UI as a JSON API — read hours, register time entries, close weeks, and extract profile information. Useful for syncing time from other systems, workflow automation, or personal time tracking tools.

## Quick start

```bash
cp .env.example .env    # add your Yoobi credentials
npm install
npx playwright install chromium
npm run dev
```

```bash
# Get this month's timesheet
curl -H "Authorization: Bearer $API_KEY" http://localhost:3001/api/month
```

```json
{
  "year": 2026,
  "month": 3,
  "month_name": "Maart",
  "employee_name": "Jane Doe",
  "total_hours": 128,
  "projects": [{
    "daily_hours": { "3": 8, "4": 8, "5": 8, "6": 8, "7": 8 },
    "monthly_total": 128
  }],
  "validation": {
    "official_total": 128,
    "calculated_total": 128,
    "days_with_data": 16,
    "confidence": 1.0,
    "reason": "Perfect match between official and calculated totals"
  }
}
```

```bash
# Get this week's hours
curl -H "Authorization: Bearer $API_KEY" http://localhost:3001/api/week

# Get a specific day
curl -H "Authorization: Bearer $API_KEY" "http://localhost:3001/api/day?date=2026-03-10"

# Get user profile
curl -H "Authorization: Bearer $API_KEY" http://localhost:3001/api/profile

# Register hours
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"date": "2026-03-10", "hours": 8}, {"date": "2026-03-11", "hours": 7.5}]}' \
  http://localhost:3001/api/hours

# Close a week
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-03-10"}' \
  http://localhost:3001/api/week/close
```

```json
{
  "results": [
    { "date": "2026-03-10", "hours": 8, "status": "created" },
    { "date": "2026-03-11", "hours": 7.5, "status": "already_exists" }
  ]
}
```

## API endpoints

Service info is available at `GET /` and the full OpenAPI 3.0 spec at `GET /api/docs`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | No | Service description and endpoint listing |
| GET | `/api/health` | No | Health check (browser state, uptime) |
| GET | `/api/docs` | No | OpenAPI 3.0 spec |
| GET | `/api/month` | Yes | Monthly timesheet (`?year=&month=`) |
| GET | `/api/week` | Yes | Current week's hours |
| GET | `/api/today` | Yes | Today's hours |
| GET | `/api/day` | Yes | Specific day (`?date=YYYY-MM-DD`) |
| GET | `/api/profile` | Yes | User profile (name, email, phone) |
| POST | `/api/hours` | Yes | Register hours for one or more days |
| POST | `/api/week/close` | Yes | Close/submit a week (`{"date":"YYYY-MM-DD"}`) |

All authenticated endpoints require a `Authorization: Bearer <API_KEY>` header.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | — | Bearer token for API authentication |
| `YOOBI_BASE_URL` | Yes | — | Yoobi instance URL (e.g. `https://yourcompany.yoobi.nl/`) |
| `YOOBI_USERNAME` | Yes | — | Yoobi login username |
| `YOOBI_PASSWORD` | Yes | — | Yoobi login password |
| `PORT` | No | `3001` | Server port |
| `IDLE_TIMEOUT_MS` | No | `300000` | Browser idle timeout (5 min) |
| `HANDLER_TIMEOUT_MS` | No | `120000` | Per-request timeout (2 min) |
| `READONLY` | No | `false` | Set to `true` to disable write endpoints |

## Architecture

The API manages a single headless Chromium browser session:

- **Mutex** — requests are serialized (one browser action at a time) to prevent state corruption
- **Idle timeout** — the browser closes after 5 minutes of inactivity to free resources
- **Retry** — if a request fails due to browser issues, the session is recycled and the request retried once
- **Multi-strategy extraction** — Yoobi uses an iframe-based SPA with a complex grid layout; the extractor tries multiple CSS selector strategies and validates results with confidence scoring
- **Safe writes** — hours are rounded to the nearest quarter, existing entries are never overwritten, and duplicate registrations are detected and skipped

This means the first request after idle takes ~10 seconds (browser launch + login), while subsequent requests take 3-5 seconds.

## CLI

For one-off operations without running the server:

```bash
node src/cli.mjs month              # this month's timesheet
node src/cli.mjs month 2026 1       # January 2026
node src/cli.mjs week               # this week's hours
node src/cli.mjs day 2026-03-10     # specific date
node src/cli.mjs profile            # user profile
node src/cli.mjs hours 2026-03-10 8 # register 8 hours
node src/cli.mjs close-week 2026-03-10  # close the week
node src/cli.mjs --help             # all commands
```

## Docker

```bash
make up      # build and run locally
make down    # stop
```

## Deployment

```bash
# Set HOST in .env (e.g. HOST=root@your-server), then:
make deploy    # scp + docker compose on remote
make logs      # tail production logs
make restart   # restart containers
make stop      # stop containers
```

## Limitations

- **Browser automation is inherently fragile.** If Yoobi changes their UI or iframe structure, selectors may break and need updating.
- **No undo.** Write operations (registering hours, closing weeks) cannot be reversed via the API. Hours can only be written to empty cells — existing entries are not overwritten.
- **Single concurrent request.** The mutex serializes all requests — parallel calls will queue, not fail.
- **One user per instance.** The browser session logs in as the configured user. For multiple users, run separate instances.

## Disclaimer

This project is not affiliated with or endorsed by [Yoobi](https://www.yoobi.nl/). It automates the web UI using your own credentials to access your own data. Use at your own risk — automated access may violate the platform's terms of service.

## License

MIT
