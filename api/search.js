// DuneBlend Search Proxy — Vercel Serverless Function
// Deployed automatically from GitHub when connected to Vercel.
//
// Endpoints:
//   GET /api/search?q=search+terms     → web search via SearXNG (JSON)
//   GET /api/search?url=https://...    → fetch & return page content as plain text
//
// Optional env vars (set in Vercel dashboard):
//   SEARXNG_INSTANCE  — override the default SearXNG base URL
//   BRAVE_API_KEY     — use Brave Search API instead of SearXNG (recommended)

const BRAVE_API_KEY    = process.env.BRAVE_API_KEY    || '';
const SEARXNG_OVERRIDE = process.env.SEARXNG_INSTANCE || '';

const SEARXNG_INSTANCES = SEARXNG_OVERRIDE
    ? [SEARXNG_OVERRIDE]
    : [
        'https://searx.tiekoetter.com',
        'https://etsi.me',
        'https://searxng.site',
        'https://searx.be',
    ];

async function braveSearch(query) {
    const resp = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY } }
    );
    if (!resp.ok) throw new Error(`Brave API returned HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.web?.results || []).slice(0, 6).map(r => ({
        title:   r.title       || '',
        url:     r.url         || '',
        snippet: r.description || '',
    }));
}

async function ddgSearch(query) {
    // DuckDuckGo HTML search scraper — no API key needed
    const url  = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`DDG returned HTTP ${resp.status}`);
    const html = await resp.text();

    const results = [];
    // Extract result blocks: <a class="result__a" href="...">title</a> and <a class="result__snippet">snippet</a>
    const blockRe = /<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|<\/div>\s*<\/div>\s*<\/div>)/g;
    const titleRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // Simpler approach: find all result__a links and result__snippets
    const linkRe    = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe    = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links     = [...html.matchAll(linkRe)].map(m => ({ url: m[1], title: stripTags(m[2]) }));
    const snippets  = [...html.matchAll(snipRe)].map(m => stripTags(m[1]));

    for (let i = 0; i < Math.min(links.length, 6); i++) {
        let url = links[i].url;
        // DDG wraps URLs — decode if needed
        if (url.startsWith('//duckduckgo.com/l/?')) {
            const uddg = new URL('https:' + url).searchParams.get('uddg');
            if (uddg) url = decodeURIComponent(uddg);
        }
        results.push({ title: links[i].title, url, snippet: snippets[i] || '' });
    }
    if (results.length === 0) throw new Error('DDG returned no results');
    return results;
}

async function searxngSearch(query) {
    let lastErr = null;
    for (const instance of SEARXNG_INSTANCES) {
        try {
            const url  = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'DuneBlend/1.0', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status} from ${instance}`); continue; }
            const data = await resp.json();
            if (!data.results) { lastErr = new Error(`No results from ${instance}`); continue; }
            return data.results.slice(0, 6).map(r => ({
                title:   r.title   || '',
                url:     r.url     || '',
                snippet: r.content || '',
            }));
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('All SearXNG instances failed');
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const { q: query, url: fetchUrl } = req.query;

    try {
        if (query) {
            let results;
            if (BRAVE_API_KEY) {
                results = await braveSearch(query);
            } else {
                // Try SearXNG first, fall back to DDG scraping
                try {
                    results = await searxngSearch(query);
                } catch (e) {
                    results = await ddgSearch(query);
                }
            }
            return res.status(200).json({ results });
        }

        if (fetchUrl) {
            const pageResp = await fetch(fetchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DuneBlend/1.0)' },
                signal: AbortSignal.timeout(10000),
            });
            if (!pageResp.ok) {
                return res.status(502).json({ error: `Fetch returned HTTP ${pageResp.status}` });
            }
            const html = await pageResp.text();
            const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 8000);
            return res.status(200).send(text);
        }

        return res.status(400).json({ error: 'Provide ?q= for search or ?url= to fetch a page.' });
    } catch (e) {
        return res.status(502).json({ error: e.message });
    }
}
