# WorldMonitor Development Notes

## CRITICAL: Git Branch Rules

**NEVER push to a different branch than the one you're working on without explicit user permission.**

- If on `beta`, only push to `beta`
- If on `main`, only push to `main`
- NEVER merge branches or push to `main` without asking first
- NEVER assume deployment is wanted - always ask

## Critical: RSS Proxy Allowlist

When adding new RSS feeds in `src/config/feeds.ts`, you **MUST** also add the feed domains to the allowlist in `api/rss-proxy.js`.

### Why
The RSS proxy has a security allowlist (`ALLOWED_DOMAINS`) that blocks requests to domains not explicitly listed. Feeds from unlisted domains will return HTTP 403 "Domain not allowed" errors.

### How to Add New Feeds

1. Add the feed to `src/config/feeds.ts`
2. Extract the domain from the feed URL (e.g., `https://www.ycombinator.com/blog/rss/` → `www.ycombinator.com`)
3. Add the domain to `ALLOWED_DOMAINS` array in `api/rss-proxy.js`
4. Deploy changes to Vercel

### Example
```javascript
// In api/rss-proxy.js
const ALLOWED_DOMAINS = [
  // ... existing domains
  'www.ycombinator.com',  // Add new domain here
];
```

### Debugging Feed Issues
If a panel shows "No news available":
1. Open browser DevTools → Console
2. Look for `HTTP 403` or "Domain not allowed" errors
3. Check if the domain is in `api/rss-proxy.js` allowlist

## Site Variants

Two variants controlled by `VITE_VARIANT` environment variable:

- `full` (default): Geopolitical focus - worldmonitor.app
- `tech`: Tech/startup focus - startups.worldmonitor.app

### Running Locally
```bash
npm run dev        # Full variant
npm run dev:tech   # Tech variant
```

### Building
```bash
npm run build:full  # Production build for worldmonitor.app
npm run build:tech  # Production build for startups.worldmonitor.app
```

## Custom Feed Scrapers

Some sources don't provide RSS feeds. Custom scrapers are in `/api/`:

| Endpoint | Source | Notes |
|----------|--------|-------|
| `/api/fwdstart` | FwdStart Newsletter (Beehiiv) | Scrapes archive page, 30min cache |

### Adding New Scrapers
1. Create `/api/source-name.js` edge function
2. Scrape source, return RSS XML format
3. Add to feeds.ts: `{ name: 'Source', url: '/api/source-name' }`
4. No need to add to rss-proxy allowlist (direct API, not proxied)

## AI Summarization & Caching

The AI Insights panel uses a server-side Redis cache to deduplicate API calls across users.

### Required Environment Variables

```bash
# Groq API (primary summarization)
GROQ_API_KEY=gsk_xxx

# OpenRouter API (fallback)
OPENROUTER_API_KEY=sk-or-xxx

# Upstash Redis (cross-user caching)
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
```

### How It Works

1. User visits → `/api/groq-summarize` receives headlines
2. Server hashes headlines → checks Redis cache
3. **Cache hit** → return immediately (no API call)
4. **Cache miss** → call Groq API → store in Redis (24h TTL) → return

### Model Selection

- **llama-3.1-8b-instant**: 14,400 req/day (used for summaries)
- **llama-3.3-70b-versatile**: 1,000 req/day (quality but limited)

### Fallback Chain

1. Groq (fast, 14.4K/day) → Redis cache
2. OpenRouter (50/day) → Redis cache
3. Browser T5 (unlimited, slower, no cache)

### Setup Upstash

1. Create free account at [upstash.com](https://upstash.com)
2. Create a new Redis database
3. Copy REST URL and Token to Vercel env vars

## Service Status Panel

Status page URLs in `api/service-status.js` must match the actual status page endpoint. Common formats:
- Statuspage.io: `https://status.example.com/api/v2/status.json`
- Atlassian: `https://example.status.atlassian.com/api/v2/status.json`
- incident.io: Same endpoint but returns HTML, handled by `incidentio` parser

Current known URLs:
- Anthropic: `https://status.claude.com/api/v2/status.json`
- Zoom: `https://www.zoomstatus.com/api/v2/status.json`
- Notion: `https://www.notion-status.com/api/v2/status.json`

## Bash Guidelines

### IMPORTANT: Avoid commands that cause output buffering issues
- DO NOT pipe output through `head`, `tail`, `less`, or `more` when monitoring or checking command output
- DO NOT use `| head -n X` or `| tail -n X` to truncate output - these cause buffering problems
- Instead, let commands complete fully, or use `--max-lines` flags if the command supports them
- For log monitoring, prefer reading files directly rather than piping through filters

### When checking command output:
- Run commands directly without pipes when possible
- If you need to limit output, use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can cause output to buffer indefinitely
