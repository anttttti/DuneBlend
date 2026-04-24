// DuneBlend Search Proxy — Cloudflare Worker
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// After deploying, set SEARCH_WORKER_URL in agent.js to your worker's URL.
//
// Endpoints:
//   GET /?q=search+terms        → web search via SearXNG (JSON)
//   GET /?url=https://...       → fetch & return page content as plain text

const SEARXNG_INSTANCE = 'https://searx.be';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const { searchParams } = new URL(request.url);
        const query    = searchParams.get('q');
        const fetchUrl = searchParams.get('url');

        try {
            if (query) {
                const url  = `${SEARXNG_INSTANCE}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
                const resp = await fetch(url, { headers: { 'User-Agent': 'DuneBlend/1.0' } });
                if (!resp.ok) return error(`SearXNG returned HTTP ${resp.status}`);

                const data    = await resp.json();
                const results = (data.results || []).slice(0, 6).map(r => ({
                    title:   r.title   || '',
                    url:     r.url     || '',
                    snippet: r.content || '',
                }));

                return new Response(JSON.stringify({ results }), {
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }

            if (fetchUrl) {
                const resp = await fetch(fetchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DuneBlend/1.0)' },
                });
                if (!resp.ok) return error(`Fetch returned HTTP ${resp.status}`);

                // Strip HTML tags for a plain-text approximation
                const html = await resp.text();
                const text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim()
                    .slice(0, 8000);

                return new Response(text, {
                    headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
                });
            }

            return error('Provide ?q= for search or ?url= to fetch a page.', 400);
        } catch (e) {
            return error(e.message);
        }
    },
};

function error(msg, status = 502) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}
