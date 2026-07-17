/**
 * tamarind-availability — Cloudflare Worker
 *
 * GET /availability → { busy: [{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }], updatedAt, sample? }
 *
 * Proxies the Airbnb iCal export feed (AIRBNB_ICAL_URL secret) as JSON date
 * ranges, cached at the edge for 10 minutes. `end` is exclusive (iCal DTEND
 * semantics — the checkout day itself is free).
 *
 * The busy/free calendar is public, non-PII data, so CORS is open ("*");
 * anyone could fetch the endpoint with curl regardless, and an open origin
 * keeps local file:// previews of the site working.
 */

const CACHE_TTL_SECONDS = 600; // 10 minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'GET' || url.pathname !== '/availability') {
      return json({ error: 'Not found' }, 404);
    }

    // Edge cache: same URL for every visitor, so one fetch serves everyone
    // for CACHE_TTL_SECONDS per PoP.
    const cacheKey = new Request(url.origin + '/availability');
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let busy;
    let sample = false;

    if (env.AIRBNB_ICAL_URL) {
      let icsText;
      try {
        const res = await fetch(env.AIRBNB_ICAL_URL, {
          headers: { 'User-Agent': 'tamarind-availability-worker' },
        });
        if (!res.ok) throw new Error('feed responded ' + res.status);
        icsText = await res.text();
      } catch (err) {
        return json({ error: 'Calendar feed unavailable' }, 503);
      }
      busy = parseIcs(icsText, todayStr());
    } else {
      // No secret configured yet (local dev / first deploy): sample data so
      // the frontend can be previewed end-to-end.
      busy = sampleBusy();
      sample = true;
    }

    const body = { busy, updatedAt: new Date().toISOString() };
    if (sample) body.sample = true;

    const response = json(body, 200, {
      'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse an Airbnb iCal feed into busy ranges.
 *
 * Airbnb feeds are all-day VEVENTs:
 *   DTSTART;VALUE=DATE:20260801
 *   DTEND;VALUE=DATE:20260803     (exclusive — checkout day)
 *   UID:xxxx@airbnb.com
 *
 * Rules: unfold continuation lines, tolerate property params, normalize
 * YYYYMMDD → YYYY-MM-DD, missing DTEND → start + 1 day, dedupe by UID,
 * drop events that end on/before `today`.
 */
export function parseIcs(icsText, today) {
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = new Map(); // uid → {start, end}
  let current = null;
  let anonCount = 0;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.start) {
        const start = current.start;
        const end = current.end || addDays(start, 1);
        if (end > start && end > today) {
          const uid = current.uid || 'anon-' + anonCount++;
          events.set(uid, { start, end });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const m = line.match(/^(DTSTART|DTEND|UID)(?:;[^:]*)?:(.*)$/);
    if (!m) continue;
    const [, prop, rawValue] = m;
    if (prop === 'UID') {
      current.uid = rawValue.trim();
    } else {
      const date = normalizeDate(rawValue);
      if (!date) continue;
      if (prop === 'DTSTART') current.start = date;
      else current.end = date;
    }
  }

  return [...events.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
}

function normalizeDate(raw) {
  // "20260801" or "20260801T140000Z" → "2026-08-01"
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sampleBusy() {
  // A few plausible blocks relative to today, for frontend preview only.
  const t = todayStr();
  return [
    { start: addDays(t, 4), end: addDays(t, 6) },
    { start: addDays(t, 12), end: addDays(t, 15) },
    { start: addDays(t, 21), end: addDays(t, 22) },
  ];
}
