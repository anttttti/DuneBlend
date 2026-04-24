// DuneBlend Search Proxy — Vercel Serverless Function
// Deployed automatically from GitHub when connected to Vercel.
//
// Endpoints:
//   GET /api/search?q=search+terms     → web search via SearXNG (JSON)
//   GET /api/search?url=https://...    → fetch & return page content as plain text

const SEARXNG_INSTANCE = 'https://searx.be';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const { q: query, url: fetchUrl } = req.query;

    try {
        if (query) {
            const searchResp = await fetch(
                `${SEARXNG_INSTANCE}/search?q=${encodeURIComponent(query)}&format=json&language=en`,
                { headers: { 'User-Agent': 'DuneBlend/1.0' } }
            );
            if (!searchResp.ok) {
                return res.status(502).json({ error: `SearXNG returned HTTP ${searchResp.status}` });
            }
            const data    = await searchResp.json();
            const results = (data.results || []).slice(0, 6).map(r => ({
                title:   r.title   || '',
                url:     r.url     || '',
                snippet: r.content || '',
            }));
            return res.status(200).json({ results });
        }

        if (fetchUrl) {
            const pageResp = await fetch(fetchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DuneBlend/1.0)' },
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
