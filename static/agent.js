// ========================================
// AI Agent Tab — DuneBlend
// Supports Google Gemini and Mistral AI
// API keys stored in localStorage: 'geminiApiKey', 'mistralApiKey'
// ========================================

const AGENT_MODEL_DEFAULT = 'gemma-4-31b-it';
const MAX_TOOL_ROUNDS     = 1000;

function gcTrack(path, title) {
    try { window.goatcounter?.count({ path, title, event: true }); } catch {}
}

const SEARCH_PROXY_URL = 'https://duneblend.antti-puurula.workers.dev';

// ----------------------------------------
// Session state  (reset on agentClear)
// ----------------------------------------
let geminiHistory    = []; // [{role:'user'|'model', parts:[...]}]
let mistralHistory   = []; // [{role:'user'|'assistant'|'tool', content, tool_calls?}]
let agentStreaming        = false;
let fetchedResourceTypes  = new Set();
let activePlaceholder     = null;
let activeAbortController = null;
let lastProvider           = null; // tracks previous provider to detect switches
let lastUserMessageText    = '';   // for regenerate
let interactionLog         = [];   // manual UI changes since last message
let suppressInteractionLog = false;

// ----------------------------------------
// Provider / model helpers
// ----------------------------------------
function getAgentModel() {
    return localStorage.getItem('agentModel') || AGENT_MODEL_DEFAULT;
}

function getModelMaxTokens() {
    const m = getAgentModel();
    if (m.startsWith('gemini') || m.startsWith('gemma')) return 1000000;
    return 128000; // mistral
}

function updateTokenLabel() {
    const el = document.getElementById('agent-token-label');
    if (!el) return;
    const history = getProvider() === 'mistral' ? mistralHistory : geminiHistory;
    const tokens  = estimateTokens(history);
    const max     = getModelMaxTokens();
    el.textContent = tokens > 0 ? `${tokens.toLocaleString()}/${(max/1000).toFixed(0)}k` : '';
}

function getProvider() {
    const m = getAgentModel();
    if (m.startsWith('mistral') || m.startsWith('open-mistral') || m.startsWith('codestral'))
        return 'mistral';
    return 'google';
}

function getActiveApiKey() {
    const p = getProvider();
    if (p === 'mistral') return localStorage.getItem('mistralApiKey') || '';
    return localStorage.getItem('geminiApiKey') || '';
}

// ----------------------------------------
// Tool definitions
// ----------------------------------------
const TOOL_DESCRIPTION = [
    'Returns the available resources for a given type as an array of selection strings,',
    'ready to paste directly into set_resources. Strings with a "N× " prefix mean N physical copies.',
    'Same-name cards from the same set are disambiguated with "#N" suffixes.',
    'Call this before calling set_resources for any type.'
].join(' ');

const TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        resource_type: {
            type: 'string',
            enum: ['imperium', 'intrigue', 'tleilax', 'reserve', 'tech',
                   'contracts', 'leader', 'sardaukar', 'starter', 'conflict'],
            description: 'The resource category to retrieve.'
        }
    },
    required: ['resource_type']
};

const SET_RESOURCES_DESCRIPTION =
    'Set selected counts for one resource type. Pass the exact "sel" strings from get_available_resources. ' +
    'Only listed cards are modified; unlisted cards in the same type are left unchanged. ' +
    'Use "0× Name (Source)" to remove a card.';

const SET_RESOURCES_PARAMETERS = {
    type: 'object',
    properties: {
        resource_type: {
            type: 'string',
            enum: ['imperium', 'intrigue', 'tleilax', 'reserve', 'tech',
                   'contracts', 'leader', 'sardaukar', 'starter', 'conflict'],
            description: 'The resource type to modify.'
        },
        selections: {
            type: 'array',
            items: { type: 'string' },
            description: 'Selection strings copied verbatim from the "sel" field of get_available_resources. Use "0× Name (Source)" to remove.'
        }
    },
    required: ['resource_type', 'selections']
};

const CLEAR_BLEND_DESCRIPTION = 'Reset ALL resource selections to 0. Call this before rebuilding a blend from scratch.';

const SET_BOARD_DESCRIPTION =
    'Set the Board tab selection to match the requested expansions. ' +
    'Call this when building a blend. Pass all expansions in the blend as the sets array.';

const SET_BOARD_PARAMETERS = {
    type: 'object',
    properties: {
        sets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Expansion names in the blend, e.g. ["Uprising", "Immortality"]. ' +
                'Valid values: "Imperium", "Uprising", "Rise of Ix", "Immortality", "Bloodlines".'
        }
    },
    required: ['sets']
};

const LOAD_BLEND_DESCRIPTION =
    'Load a saved blend file by filename and apply it to the current session, ' +
    'replacing board, overview, and all resource selections. ' +
    'Call get_blend without a filename first to list available filenames.';

const LOAD_BLEND_PARAMETERS = {
    type: 'object',
    properties: {
        filename: {
            type: 'string',
            description: 'Blend filename to load, e.g. "Anttis_House_Blend.md". Must exist in the blends/ directory.'
        }
    },
    required: ['filename']
};

const GET_BOARD_DESCRIPTION =
    'Returns the current Board tab state: which main board is selected and which expansion boards/overlays are enabled.';

const GET_OVERVIEW_DESCRIPTION =
    'Returns the current contents of the Overview tab text fields: description, leader selection, and house rules.';

const SET_OVERVIEW_DESCRIPTION =
    'Set one or more Overview tab text fields. Omit any field to leave it unchanged.';

const SET_OVERVIEW_PARAMETERS = {
    type: 'object',
    properties: {
        description: {
            type: 'string',
            description: 'Blend description text. Leave unset to keep the current value.'
        },
        leader_selection: {
            type: 'string',
            description: 'Leader selection notes. Leave unset to keep the current value.'
        },
        house_rules: {
            type: 'string',
            description: 'House rules text. Leave unset to keep the current value.'
        }
    },
    required: []
};

const STATS_TOOL_DESCRIPTION =
    'Returns the current blend\'s calculated statistics as percentages: ' +
    'imperium cost distribution, mechanic coverage, and affiliation breakdown; ' +
    'intrigue mechanic coverage; totals and source breakdown for other resource types. ' +
    'Call this to verify or compare percentages instead of calculating them yourself.';

const BLEND_TOOL_DESCRIPTION =
    'Fetch a saved blend file by filename, or list all available blend filenames. ' +
    'Call with no filename to list blends, or provide a filename to read its contents.';

const BLEND_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        filename: {
            type: 'string',
            description: 'The blend filename (e.g. "Base_Imperium.md"). Omit to list all available blends.'
        }
    },
    required: []
};

const STATS_TOOL_PARAMETERS = { type: 'object', properties: {}, required: [] };
const EMPTY_PARAMETERS       = { type: 'object', properties: {}, required: [] };

const WEB_SEARCH_DESCRIPTION = 'Search the web for current information. Returns titles, URLs, and snippets from top results.';
const WEB_SEARCH_PARAMETERS  = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query.' }
    },
    required: ['query']
};

const FETCH_URL_DESCRIPTION = 'Fetch and read the content of a web page as plain text.';
const FETCH_URL_PARAMETERS  = {
    type: 'object',
    properties: {
        url: { type: 'string', description: 'The full URL to fetch.' }
    },
    required: ['url']
};

const RULEBOOK_DESCRIPTION = 'Fetch the official rulebook text for a Dune: Imperium game or expansion. ' +
    'Available keys: rules/base, rules/faq, rules/rise-of-ix, rules/immortality, rules/uprising, rules/uprising-supplements, rules/bloodlines.';
const RULEBOOK_PARAMETERS = {
    type: 'object',
    properties: {
        key: {
            type: 'string',
            enum: ['rules/base', 'rules/faq', 'rules/rise-of-ix', 'rules/immortality', 'rules/uprising', 'rules/uprising-supplements', 'rules/bloodlines'],
            description: 'The rulebook key to fetch.'
        }
    },
    required: ['key']
};

const WIKIPEDIA_DESCRIPTION =
    'Search Wikipedia and return the plain-text summary of the best matching article. ' +
    'Use this for lore, rules clarifications, card names, or any factual question.';
const WIKIPEDIA_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'Search terms or article title.' }
    },
    required: ['query']
};

const RENDER_CHART_DESCRIPTION =
    'Render a chart or graph illustration directly in the chat. ' +
    'Use this to visualise blend statistics, card distributions, or any numeric comparison. ' +
    'Supported types: bar (vertical), horizontal_bar, pie, donut, line.';
const RENDER_CHART_PARAMETERS = {
    type: 'object',
    properties: {
        type:     { type: 'string', enum: ['bar','horizontal_bar','pie','donut','line'], description: 'Chart type.' },
        title:    { type: 'string', description: 'Optional chart title.' },
        labels:   { type: 'array', items: { type: 'string' }, description: 'Category or x-axis labels.' },
        datasets: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    label:  { type: 'string', description: 'Series label (shown in legend for multi-series charts).' },
                    values: { type: 'array', items: { type: 'number' } },
                    color:  { type: 'string', description: 'Optional hex color, e.g. "#4e79a7". Omit to use defaults.' }
                },
                required: ['values']
            },
            description: 'One dataset for pie/donut/horizontal_bar; one or more for bar/line.'
        }
    },
    required: ['type', 'labels', 'datasets']
};

const SEARCH_TOOLS_GEMINI  = SEARCH_PROXY_URL ? [
    { name: 'web_search',   description: WEB_SEARCH_DESCRIPTION, parameters: WEB_SEARCH_PARAMETERS },
    { name: 'fetch_url',    description: FETCH_URL_DESCRIPTION,  parameters: FETCH_URL_PARAMETERS  },
    { name: 'fetch_rulebook', description: RULEBOOK_DESCRIPTION, parameters: RULEBOOK_PARAMETERS   },
] : [];

const SEARCH_TOOLS_MISTRAL = SEARCH_PROXY_URL ? [
    { type: 'function', function: { name: 'web_search',     description: WEB_SEARCH_DESCRIPTION, parameters: WEB_SEARCH_PARAMETERS } },
    { type: 'function', function: { name: 'fetch_url',      description: FETCH_URL_DESCRIPTION,  parameters: FETCH_URL_PARAMETERS  } },
    { type: 'function', function: { name: 'fetch_rulebook', description: RULEBOOK_DESCRIPTION,   parameters: RULEBOOK_PARAMETERS   } },
] : [];

// Gemini format
const GEMINI_TOOLS = [{
    functionDeclarations: [
        { name: 'get_available_resources', description: TOOL_DESCRIPTION,          parameters: TOOL_PARAMETERS           },
        { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION,  parameters: SET_RESOURCES_PARAMETERS   },
        { name: 'set_board',               description: SET_BOARD_DESCRIPTION,      parameters: SET_BOARD_PARAMETERS       },
        { name: 'get_board',               description: GET_BOARD_DESCRIPTION,      parameters: EMPTY_PARAMETERS           },
        { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,    parameters: EMPTY_PARAMETERS           },
        { name: 'load_blend',              description: LOAD_BLEND_DESCRIPTION,     parameters: LOAD_BLEND_PARAMETERS      },
        { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,     parameters: BLEND_TOOL_PARAMETERS      },
        { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,     parameters: STATS_TOOL_PARAMETERS      },
        { name: 'get_overview',            description: GET_OVERVIEW_DESCRIPTION,   parameters: EMPTY_PARAMETERS           },
        { name: 'set_overview',            description: SET_OVERVIEW_DESCRIPTION,   parameters: SET_OVERVIEW_PARAMETERS    },
        { name: 'wikipedia_search',        description: WIKIPEDIA_DESCRIPTION,      parameters: WIKIPEDIA_PARAMETERS       },
        { name: 'render_chart',            description: RENDER_CHART_DESCRIPTION,   parameters: RENDER_CHART_PARAMETERS    },
        ...SEARCH_TOOLS_GEMINI
    ]
}];

// Mistral / OpenAI format
const MISTRAL_TOOLS = [
    { type: 'function', function: { name: 'get_available_resources', description: TOOL_DESCRIPTION,          parameters: TOOL_PARAMETERS           } },
    { type: 'function', function: { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION,  parameters: SET_RESOURCES_PARAMETERS   } },
    { type: 'function', function: { name: 'set_board',               description: SET_BOARD_DESCRIPTION,      parameters: SET_BOARD_PARAMETERS       } },
    { type: 'function', function: { name: 'get_board',               description: GET_BOARD_DESCRIPTION,      parameters: EMPTY_PARAMETERS           } },
    { type: 'function', function: { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,    parameters: EMPTY_PARAMETERS           } },
    { type: 'function', function: { name: 'load_blend',              description: LOAD_BLEND_DESCRIPTION,     parameters: LOAD_BLEND_PARAMETERS      } },
    { type: 'function', function: { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,     parameters: BLEND_TOOL_PARAMETERS      } },
    { type: 'function', function: { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,     parameters: STATS_TOOL_PARAMETERS      } },
    { type: 'function', function: { name: 'get_overview',            description: GET_OVERVIEW_DESCRIPTION,   parameters: EMPTY_PARAMETERS           } },
    { type: 'function', function: { name: 'set_overview',            description: SET_OVERVIEW_DESCRIPTION,   parameters: SET_OVERVIEW_PARAMETERS    } },
    { type: 'function', function: { name: 'wikipedia_search',        description: WIKIPEDIA_DESCRIPTION,      parameters: WIKIPEDIA_PARAMETERS       } },
    { type: 'function', function: { name: 'render_chart',            description: RENDER_CHART_DESCRIPTION,   parameters: RENDER_CHART_PARAMETERS    } },
    ...SEARCH_TOOLS_MISTRAL
];

const VALID_RESOURCE_TYPES = new Set([
    'imperium', 'intrigue', 'tleilax', 'reserve', 'tech',
    'contracts', 'leader', 'sardaukar', 'starter', 'conflict'
]);

// ----------------------------------------
// Tool label helper
// ----------------------------------------
function toolLabel(name, args) {
    const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    if (name === 'set_resources')           return `set:${a.resource_type}`;
    if (name === 'get_available_resources') return `get:${a.resource_type}`;
    if (name === 'get_blend_statistics')    return 'get:statistics';
    if (name === 'get_blend')               return `get:${a.filename || 'blend list'}`;
    if (name === 'load_blend')              return `load:${a.filename || '?'}`;
    if (name === 'set_board')               return 'set_board';
    if (name === 'get_board')               return 'get_board';
    if (name === 'clear_blend')             return 'clear_blend';
    if (name === 'get_overview')            return 'get_overview';
    if (name === 'set_overview')            return 'set_overview';
    if (name === 'web_search')              return `search:${a.query}`;
    if (name === 'fetch_url')               return `fetch:${a.url}`;
    if (name === 'fetch_rulebook')          return `rulebook:${a.key}`;
    if (name === 'wikipedia_search')        return `wiki:${a.query}`;
    if (name === 'render_chart')            return `chart:${a.title || a.type}`;
    return typeof name === 'string' ? name : '?';
}

// ----------------------------------------
// Tool execution
// ----------------------------------------
async function executeToolAsync(name, args) {
    if (name === 'get_available_resources') {
        const type = args.resource_type;
        if (!VALID_RESOURCE_TYPES.has(type)) {
            return { error: `Invalid resource_type '${type}'. Valid types are: ${[...VALID_RESOURCE_TYPES].join(', ')}.` };
        }
        if (fetchedResourceTypes.has(type)) {
            return { note: `Resource list for '${type}' was already provided earlier in this conversation. Do not request it again.` };
        }
        fetchedResourceTypes.add(type);
        const allRes = window.getAllResources ? window.getAllResources() : {};
        const items  = allRes[type] || [];
        // Group by name+source to detect synonyms (distinct cards sharing a name, e.g. "Skirmish #1/#2/#3").
        const synonymGroups = new Map();
        for (const r of items) {
            const name = r.objective || r.name || '';
            const src  = r.source    || r.card_set || '';
            const key  = `${name.toLowerCase()}|||${src.toLowerCase()}`;
            if (!synonymGroups.has(key)) synonymGroups.set(key, []);
            synonymGroups.get(key).push(r);
        }
        // Sort each synonym group by resource_id for stable #N numbering (mirrors blend save code).
        for (const group of synonymGroups.values()) {
            group.sort((a, b) => (a.resource_id ?? 0) - (b.resource_id ?? 0));
        }
        // One string per raw item. Same-name cards get "#N" suffix for unambiguous reference.
        const resources = [];
        for (const group of synonymGroups.values()) {
            const needsSuffix = group.length > 1;
            for (let idx = 0; idx < group.length; idx++) {
                const r    = group[idx];
                const name = r.objective || r.name || '';
                const src  = r.source    || r.card_set || '';
                const displayName = needsSuffix ? `${name} #${idx + 1}` : name;
                const id   = `${displayName} (${src})`;
                const max  = r.count || r.count_per_player || 1;
                resources.push(max > 1 ? `${max}× ${id}` : id);
            }
        }
        return { resource_type: type, resources };
    }

    if (name === 'get_blend') {
        if (!args.filename) {
            try {
                const resp = await fetch('blends/index.json');
                const list = await resp.json();
                return { blends: list.map(b => b.filename) };
            } catch (e) {
                return { error: 'Could not fetch blend list.' };
            }
        }
        const safe = args.filename.replace(/[^a-zA-Z0-9_\-. ]/g, '');
        try {
            const resp = await fetch(`blends/${safe}`);
            if (!resp.ok) return { error: `Blend not found: ${safe}` };
            const text = await resp.text();
            return { filename: safe, content: text };
        } catch (e) {
            return { error: `Could not fetch blend: ${safe}` };
        }
    }

    if (name === 'get_blend_statistics') {
        if (window.getBlendStatistics) return window.getBlendStatistics();
        return { error: 'Statistics not available.' };
    }

    if (name === 'set_board') {
        const sets = (args.sets || []).map(s => s.toLowerCase());
        const has  = keyword => sets.some(s => s.includes(keyword));

        const uprisingRadio  = document.getElementById('board-uprising');
        const imperiumRadio  = document.getElementById('board-imperium');
        if (uprisingRadio && imperiumRadio) {
            uprisingRadio.checked = has('uprising');
            imperiumRadio.checked = !has('uprising');
        }

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
        set('board-choam',    has('ix'));
        set('board-ix',       has('ix'));
        set('board-tleilax',  has('immortality'));
        set('board-research', has('immortality'));
        set('board-embassy',  has('bloodlines'));

        if (window.updateRequiredSets) window.updateRequiredSets();
        if (window.refreshAllStats)    window.refreshAllStats();
        return { success: true };
    }

    if (name === 'get_board') {
        const chk = id => !!document.getElementById(id)?.checked;
        return {
            main_board:     document.querySelector('input[name="mainBoard"]:checked')?.value || 'imperium',
            choam:          chk('board-choam'),
            ix:             chk('board-ix'),
            tleilax:        chk('board-tleilax'),
            research:       chk('board-research'),
            embassy:        chk('board-embassy'),
            family_atomics: chk('board-family-atomics'),
        };
    }

    if (name === 'get_overview') {
        return {
            description:      document.getElementById('overview-description')?.value      || '',
            leader_selection: document.getElementById('overview-leader-selection')?.value || '',
            house_rules:      document.getElementById('overview-house-rules')?.value      || '',
        };
    }

    if (name === 'set_overview') {
        const setText = (id, val) => {
            if (val === undefined) return;
            const el = document.getElementById(id);
            if (el) { el.value = val; el.dispatchEvent(new Event('input')); }
        };
        setText('overview-description',      args.description);
        setText('overview-leader-selection', args.leader_selection);
        setText('overview-house-rules',      args.house_rules);
        if (window.saveBlendState) window.saveBlendState();
        return { success: true };
    }

    if (name === 'clear_blend') {
        if (window.clearAllResources) window.clearAllResources();
        return { success: true };
    }

    if (name === 'load_blend') {
        const filename = args.filename;
        if (!filename) return { error: 'filename is required' };
        const safe = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '');
        if (!safe) return { error: 'Invalid filename.' };
        if (!window.loadParsedBlendData) return { error: 'loadParsedBlendData not available.' };
        try {
            const resp = await fetch(`blends/${safe}?t=${Date.now()}`, { cache: 'no-store' });
            if (!resp.ok) return { error: `Blend not found: ${safe}` };
            const text = await resp.text();
            if (!window.parseBlendFile) return { error: 'parseBlendFile not available.' };
            const parsed = window.parseBlendFile(text);
            if (!parsed?.success) return { error: 'Failed to parse blend file.' };
            window.loadParsedBlendData(parsed, safe);
            return { success: true, filename: safe };
        } catch (e) {
            return { error: `Failed to load blend: ${e.message}` };
        }
    }

    if (name === 'set_resources') {
        const { resource_type, selections } = args;
        if (!VALID_RESOURCE_TYPES.has(resource_type)) {
            return { error: `Invalid resource_type '${resource_type}'.` };
        }
        const applied = applySelections(resource_type, selections || []);
        return { applied, resource_type };
    }

    if (name === 'web_search') {
        gcTrack('/agent/search/web', 'Agent web search');
        if (!SEARCH_PROXY_URL) return { error: 'Search proxy not configured.' };
        const userKey = localStorage.getItem('braveApiKey');
        const headers = {};
        if (userKey) headers['X-Brave-Key'] = userKey;
        try {
            const resp = await fetch(
                `${SEARCH_PROXY_URL}?q=${encodeURIComponent(args.query)}`,
                { headers, signal: activeAbortController?.signal }
            );
            if (!resp.ok) return { error: `Search returned HTTP ${resp.status}` };
            return await resp.json();
        } catch (e) {
            return { error: `Search failed: ${e.message}` };
        }
    }

    if (name === 'fetch_rulebook') {
        if (!SEARCH_PROXY_URL) return { error: 'Search proxy not configured.' };
        try {
            const resp = await fetch(`${SEARCH_PROXY_URL}/pdf?key=${encodeURIComponent(args.key)}`, {
                signal: activeAbortController?.signal,
            });
            if (!resp.ok) return { error: `Rulebook fetch returned HTTP ${resp.status}` };
            const text = await resp.text();
            return { content: text };
        } catch (e) {
            return { error: `fetch_rulebook failed: ${e.message}` };
        }
    }

    if (name === 'fetch_url') {
        try {
            // JSON APIs (Reddit .json, /api/ paths) can be fetched directly; HTML pages go via worker proxy to avoid CORS
            const isJsonApi = /\.json(\?|$)/.test(args.url) || args.url.includes('/api/');
            let resp;
            if (isJsonApi) {
                resp = await fetch(args.url, { signal: activeAbortController?.signal });
            } else if (SEARCH_PROXY_URL) {
                resp = await fetch(`${SEARCH_PROXY_URL}?url=${encodeURIComponent(args.url)}`, {
                    signal: activeAbortController?.signal,
                });
            } else {
                resp = await fetch(args.url, { signal: activeAbortController?.signal });
            }
            if (!resp.ok) return { error: `fetch_url returned HTTP ${resp.status}` };
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                return { content: JSON.stringify(await resp.json()) };
            }
            const html = await resp.text();
            const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim()
                .slice(0, 8000);
            return { content: text };
        } catch (e) {
            return { error: `fetch_url failed: ${e.message}` };
        }
    }

    if (name === 'wikipedia_search') {
        gcTrack('/agent/search/wikipedia', 'Agent wikipedia search');
        try {
            // Step 1: find the best-matching article title
            const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(args.query)}&limit=3&namespace=0&format=json&origin=*`;
            const searchResp = await fetch(searchUrl, { signal: activeAbortController?.signal });
            if (!searchResp.ok) return { error: `Wikipedia search failed: HTTP ${searchResp.status}` };
            const [, titles] = await searchResp.json();
            if (!titles?.length) return { results: [] };

            // Step 2: fetch summaries for top results in parallel
            const summaries = await Promise.all(titles.slice(0, 3).map(async title => {
                const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
                try {
                    const r = await fetch(summaryUrl, { signal: activeAbortController?.signal });
                    if (!r.ok) return null;
                    const d = await r.json();
                    return { title: d.title, summary: d.extract, url: d.content_urls?.desktop?.page || '' };
                } catch { return null; }
            }));

            return { results: summaries.filter(Boolean) };
        } catch (e) {
            return { error: `Wikipedia search failed: ${e.message}` };
        }
    }

    if (name === 'render_chart') {
        try {
            const svg = renderChartSVG(args);
            activePlaceholder?.addChart(svg);
            return { success: true };
        } catch (e) {
            return { error: `Chart rendering failed: ${e.message}` };
        }
    }

    return { error: `Unknown tool: ${name}` };
}

// ----------------------------------------
// Selection application
// ----------------------------------------

// Parse "N× Name (Source)" or "Name (Source)" → {count, name, source}
function parseSelectionItem(str) {
    const m = str.trim().match(/^(?:(\d+)[×x]\s*)?(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) return null;
    return { count: m[1] ? parseInt(m[1], 10) : 1, name: m[2].trim(), source: m[3].trim() };
}

// Apply a selections array to a resource type. Returns count of items processed.
function applySelections(type, selections) {
    const allRes    = window.getAllResources ? window.getAllResources() : {};
    const typeItems = allRes[type];
    if (!typeItems) return 0;

    let applied = 0;
    for (const selStr of selections) {
        const parsed = parseSelectionItem(selStr);
        if (!parsed) { console.warn('[agent] Failed to parse selection:', selStr); continue; }

        // Detect "#N" synonym suffix (e.g. "Skirmish #2 (Uprising)" → baseName="Skirmish", idx=1)
        const suffixMatch = parsed.name.match(/^(.+?)\s+#(\d+)$/);
        const baseName    = suffixMatch ? suffixMatch[1] : parsed.name;
        const synonymIdx  = suffixMatch ? parseInt(suffixMatch[2]) - 1 : null;

        const matches = typeItems
            .filter(r => {
                const n = (r.objective || r.name || '').toLowerCase();
                const s = (r.source    || r.card_set || '').toLowerCase();
                return n === baseName.toLowerCase() && s === parsed.source.toLowerCase();
            })
            .sort((a, b) => (a.resource_id ?? 0) - (b.resource_id ?? 0));

        const targets = synonymIdx !== null
            ? (matches[synonymIdx] ? [matches[synonymIdx]] : [])
            : matches;

        if (!targets.length) { console.warn('[agent] Card not found:', parsed.name, parsed.source); continue; }

        let remaining = parsed.count;
        for (const resource of targets) {
            const current    = resource.selected || 0;
            const maxCount   = resource.count || resource.count_per_player || 1;
            const target     = Math.min(remaining, maxCount);
            remaining       -= target;
            const resName    = resource.objective || resource.name;
            const resSrc     = resource.source    || resource.card_set;
            const uniqueProps = resource.resource_id !== undefined ? { resource_id: resource.resource_id } : {};
            if (current < target)
                for (let i = current; i < target; i++)
                    window.incrementSelected(type, resName, resSrc, maxCount, uniqueProps);
            else if (current > target)
                for (let i = current; i > target; i--)
                    window.decrementSelected(type, resName, resSrc, uniqueProps);
        }
        applied++;
    }
    return applied;
}

// ----------------------------------------
// System prompt — rebuilt on every send
// ----------------------------------------
// Build a summary of manual UI interactions since the last message, then reset the log.
function buildInteractionContext() {
    if (!interactionLog.length) return '';

    const blendEntries = interactionLog.filter(e => /^[+-]/.test(e));
    const boardEntries = interactionLog.filter(e => e.startsWith('Board'));
    const lines = [];

    // Net change per card (collapses rapid +1/-1 clicks into a single delta)
    if (blendEntries.length) {
        const net = {};
        for (const e of blendEntries) {
            const m = e.match(/^([+-]\d+) (.+) \((.+)\) \[(.+)\]$/);
            if (!m) continue;
            const key = `${m[2]}|${m[3]}|${m[4]}`;
            if (!net[key]) net[key] = { label: `${m[2]} (${m[3]}) [${m[4]}]`, delta: 0 };
            net[key].delta += parseInt(m[1], 10);
        }
        for (const { label, delta } of Object.values(net))
            if (delta !== 0) lines.push(`${delta > 0 ? '+' : ''}${delta} ${label}`);
    }

    // Only the last board change matters
    if (boardEntries.length) lines.push(boardEntries[boardEntries.length - 1]);

    if (!lines.length) return '';
    return `[Manual UI changes since your last message:\n${lines.map(l => `- ${l}`).join('\n')}]\n\n`;
}

function buildSystemPrompt() {
    const allRes = window.getAllResources ? window.getAllResources() : {};
    const selectedLines = [];
    for (const [type, items] of Object.entries(allRes)) {
        const sel = items.filter(r => r.selected > 0);
        if (!sel.length) continue;
        selectedLines.push(
            `${type}: ` + sel.map(r =>
                `${r.selected}× ${r.objective || r.name} (${r.source || r.card_set || ''})`
            ).join(', ')
        );
    }
    const poolLines = Object.entries(allRes)
        .filter(([, items]) => items.length)
        .map(([type, items]) => `${type}: ${items.length} resources`);

    return `You are an AI assistant for DuneBlend, a blend builder for the Dune: Imperium board game.

Expansions: Imperium (base), Uprising, Rise of Ix, Immortality, Bloodlines.
Resource types: imperium, intrigue, tleilax, reserve, tech, contracts, leader, sardaukar, starter, conflict.

## Current Blend
${selectedLines.length ? selectedLines.join('\n') : 'No resources currently selected.'}

## Available Pool (counts only — use get_available_resources for full lists)
${poolLines.join('\n')}

## Workflow: building a blend from scratch
1. Call get_blend (no filename) to list blends, then get_blend with the exact filename to read it.
   Match filenames by the word in the user's description — never guess.
2. Call set_board with all expansions in the blend (e.g. ["Uprising", "Immortality"]).
3. Call get_available_resources for ALL needed resource types at once in a single parallel step — never one type at a time across multiple rounds.
4. Call clear_blend to reset everything.
5. Call set_resources once per resource type with the full selections list.

## Workflow: small updates (swap a card, adjust a type)
1. Call get_available_resources for the affected type(s) only.
2. Call set_resources for each changed type listing only the cards that change.
   Use "0× Name (Source)" to remove; omit unchanged cards entirely.
3. If the sets in the blend changed, also call set_board.

## set_resources usage
- get_available_resources returns an array of strings. Copy them verbatim into set_resources selections.
  Strings with "N× " prefix mean N physical copies — copy the prefix too, never alter it.
- Only listed cards change; others in the same type are untouched.
- "below N" or "up to N" means maximize while not exceeding N.

## Complete Build Rule
A complete build MUST include ALL resource types for the requested sets. Never include cards from sets not in the blend.
- **imperium**: Include all imperium cards whose source matches one of the requested expansions. Exclude cards from other expansions entirely.
- **leader / conflict**: Include ALL cards whose source matches one of the requested expansions. Exclude cards from other expansions entirely.
- **starter**: Include ALL starter cards from the primary base set (e.g. Uprising for an Uprising+Immortality blend). Exclude starters from other sets.
  Some starter strings start with "2× " — that means 2 physical copies; copy the prefix verbatim.
- **intrigue / reserve**: Include all cards from the requested sets only.

## Counting cards
Always count **physical copies**, not unique entries. A selection string "2× Card Name (Source)" counts as 2 physical cards, not 1. Sum the N× prefixes when verifying any total.

## Fixed Rules (apply unless the user explicitly overrides)
- **Expansion preference:** When adding an expansion, include as much of its Imperium and Intrigue cards as possible. To make space, remove base-set cards first — the base sets are "Imperium" and "Uprising". Expansion content (Rise of Ix, Immortality, Bloodlines) takes priority over base-set content unless the user specifies otherwise.

- **Starter total = 10 physical cards.** The base starter deck is: 2× Convincing Argument, 2× Dagger, 1× Diplomacy, 1× Dune The Desert Planet, 1× Reconnaissance, 1× Seek Allies, 2× Signet Ring = 10. Always verify the total equals 10.
- **Immortality modifier:** If Immortality is included in the blend, replace 2× "Dune, The Desert Planet" with 2× "Experimentation" in the starter deck (net total stays 10).
- **Reserve Cards from one set only.** Never mix reserve cards from multiple sets. Pick the full reserve from a single expansion matching the blend's base set.
- **"Control the Spice" (Rise of Ix)** is included only when the user explicitly requests "Epic" game mode. Do not add it otherwise.
- **Uprising-only mechanics (Imperium base board):** When Uprising is NOT in the blend, do not include any cards that reference spies, contracts, or sandworms. These are Uprising mechanics with no effect on the base Imperium board. This applies across all resource types — skip any card whose name or effect mentions spies, contracts, or sandworms.
- **Bloodlines → Sardaukar:** If Bloodlines is in the blend, include ALL sardaukar resources.
- **Immortality → Tleilax:** If Immortality is in the blend, include ALL tleilax resources.

## Your Capabilities
1. Answer questions about Dune: Imperium rules, strategy, and blend building.
2. Use get_available_resources before calling set_resources for any type.
   Use get_blend_statistics for percentages — never calculate them yourself.
3. Use get_blend to read saved blends (list first, then open by exact filename).
   Each line in a blend file: \`[N×] Resource Name (Expansion)\` — N× means N copies.
4. Use wikipedia_search to look up lore, rules, card details, or Dune universe information.${SEARCH_PROXY_URL ? `
5. Use web_search to find current information about Dune: Imperium cards, rules, or strategy.
   Use fetch_url to read a specific URL directly — works well with open APIs like dunecardshub.com/api/decks and reddit.com/r/duneimperium/search.json?q=QUERY&sort=relevance&limit=10
   Use fetch_rulebook to read official rulebook text. Keys: rules/base, rules/faq, rules/rise-of-ix, rules/immortality, rules/uprising, rules/uprising-supplements, rules/bloodlines.` : ''}

## Answering rules questions
When the user asks about game rules, mechanics, or card interactions, follow this order:
1. **Rulebook + FAQ together**: Call fetch_rulebook for the relevant expansion(s) **and always also fetch rules/faq** in the same step. The FAQ supersedes the rulebook — if a rule has been updated in the FAQ, use the FAQ version. Page numbers appear in headers (e.g. "=== Uprising Main Rulebook | Page 12 ===") — use these to cite your source.
2. **Community resources**: If the rulebook/FAQ doesn't fully resolve it, or if you have any remaining doubt, check fetch_url with reddit.com/r/duneimperium/search.json?q=QUERY&sort=relevance&limit=10 or BoardGameGeek threads for community consensus.
3. **Open web search**: If still in doubt, use web_search for more recent advice, errata, or designer clarifications.

Always cite your source:
- For rulebook/FAQ answers: name the rulebook and page number (e.g. "Uprising Rulebook, p. 12" or "FAQ, p. 3").
- For online sources: include the URL link.

## Honesty
- Never hallucinate card names, rules, or statistics. Only state facts you can verify with your tools or are certain of.
- If you lack the context or tools to give a confident answer, search for more information, explore the current tools, and finally ask the user for more information if needed.
- When quoting or displaying external content (search results, pasted text, blend files), always wrap it in a plain code block (\`\`\`) so it is shown as-is without markdown rendering.
`;
}

// ----------------------------------------
// Streaming helpers
// ----------------------------------------

async function* readSSE(resp) {
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') return;
                try { yield JSON.parse(payload); } catch {}
            }
        }
    } finally {
        reader.releaseLock();
    }
}

async function streamOpenAICompat(resp, onChunk) {
    const tcMap  = {};
    let content  = '';
    let usage    = null;
    let inThinkTag = false;  // track inline <thinking> tag state
    for await (const chunk of readSSE(resp)) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) onChunk(delta.reasoning_content, 'thinking');
        if (delta.content) {
            // Extract <thinking>...</thinking> tags and route to thinking display
            let raw = delta.content;
            let processed = '';
            let i = 0;
            while (i < raw.length) {
                if (!inThinkTag) {
                    const start = raw.indexOf('<thinking>', i);
                    if (start === -1) {
                        processed += raw.slice(i);
                        i = raw.length;
                    } else {
                        processed += raw.slice(i, start);
                        inThinkTag = true;
                        i = start + '<thinking>'.length;
                    }
                } else {
                    const end = raw.indexOf('</thinking>', i);
                    if (end === -1) {
                        onChunk(raw.slice(i), 'thinking');
                        i = raw.length;
                    } else {
                        onChunk(raw.slice(i, end), 'thinking');
                        inThinkTag = false;
                        i = end + '</thinking>'.length;
                    }
                }
            }
            if (processed) {
                content += processed;
                onChunk(processed, 'output');
            }
        }
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!tcMap[i]) tcMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id)                  tcMap[i].id = tc.id;
                if (tc.function?.name)      tcMap[i].function.name      += tc.function.name;
                if (tc.function?.arguments) tcMap[i].function.arguments += tc.function.arguments;
            }
        }
    }
    const tool_calls = Object.values(tcMap);
    return { role: 'assistant', content: content || null, ...(tool_calls.length && { tool_calls }), usage };
}

async function streamGeminiSSE(resp, onChunk) {
    const allParts = [];
    let usage = null;
    for await (const chunk of readSSE(resp)) {
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            allParts.push(part);
            if (part.text) onChunk(part.text, part.thought ? 'thinking' : 'output');
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    return { parts: allParts, usage };
}

// ----------------------------------------
// Context compaction
// ----------------------------------------

const COMPACT_PROMPT =
    'Summarize our entire conversation so far into a single message that will replace the conversation history. ' +
    'Include everything needed to continue seamlessly: what was requested, all decisions made, the current blend state, ' +
    'and any relevant context. Choose the format and structure that best preserves the essential information.';

function estimateTokens(obj) {
    return Math.ceil(JSON.stringify(obj).length / 4);
}

function getContextThreshold() {
    const m = getAgentModel();
    if (m.startsWith('gemini') || m.startsWith('gemma')) return 400000; // ~50% of 1M
    return 40000; // ~50% of 80k for Mistral/OpenAI
}

async function compactGeminiHistory(apiKey, placeholder) {
    const task = placeholder.addCompactStep();
    task.setPrompt(`~${estimateTokens(geminiHistory).toLocaleString()} tokens in history. Summarizing…`);

    const url  = `https://generativelanguage.googleapis.com/v1beta/models/${getAgentModel()}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  activeAbortController?.signal,
        body: JSON.stringify({
            system_instruction: { parts: [{ text: buildSystemPrompt() }] },
            contents: [...geminiHistory, { role: 'user', parts: [{ text: COMPACT_PROMPT }] }],
            generationConfig: { temperature: 0.1 }
        })
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data    = await resp.json();
    const summary = (data.candidates?.[0]?.content?.parts || [])
        .filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!summary) throw new Error('Compaction produced no summary.');

    geminiHistory = [
        { role: 'user',  parts: [{ text: `Summary of our previous conversation:\n\n${summary}` }] },
        { role: 'model', parts: [{ text: 'Understood. I have the full context and will continue from here.' }] }
    ];
    fetchedResourceTypes.clear();
    task.setOutput(summary);
    task.complete();
}

async function compactOpenAIStyleHistory(apiKey, history, url, extraHeaders, placeholder) {
    const task = placeholder.addCompactStep();
    task.setPrompt(`~${estimateTokens(history).toLocaleString()} tokens in history. Summarizing…`);

    const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        signal:  activeAbortController?.signal,
        body: JSON.stringify({
            model:       getAgentModel(),
            messages:    [
                { role: 'system', content: buildSystemPrompt() },
                ...history,
                { role: 'user', content: COMPACT_PROMPT }
            ],
            temperature: 0.1,
            max_tokens:  4096,
            stream:      false
        })
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let msg = `HTTP ${resp.status}`;
        try { const j = JSON.parse(body); msg = j.message || j.detail || msg; } catch {}
        throw new Error(msg);
    }
    const data    = await resp.json();
    const raw     = data.choices?.[0]?.message?.content;
    const summary = typeof raw === 'string' ? raw : '';
    if (!summary) throw new Error('Compaction produced no summary.');

    history.length = 0;
    history.push(
        { role: 'user',      content: `Summary of our previous conversation:\n\n${summary}` },
        { role: 'assistant', content: 'Understood. I have the full context and will continue from here.' }
    );
    fetchedResourceTypes.clear();
    task.setOutput(summary);
    task.complete();
}

// ----------------------------------------
// Retry helper
// ----------------------------------------
function isTransientError(e) {
    const m = e.message || '';
    return m.includes('Internal error') ||
           /HTTP 5\d\d/.test(m) ||
           m.includes('Failed to fetch') ||
           m.includes('NetworkError') ||
           m.includes('Load failed');
}

async function withRetry(fn, onRetry, maxRetries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt < maxRetries && isTransientError(e)) {
                if (onRetry) onRetry(attempt, e);
                await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            } else {
                throw e;
            }
        }
    }
}

// ----------------------------------------
// Google Gemini API
// ----------------------------------------
async function callGemini(apiKey, onChunk) {
    const url  = `https://generativelanguage.googleapis.com/v1beta/models/${getAgentModel()}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  activeAbortController?.signal,
        body: JSON.stringify({
            system_instruction: { parts: [{ text: buildSystemPrompt() }] },
            contents:           geminiHistory,
            tools:              GEMINI_TOOLS,
            generationConfig:   { temperature: 0.1 }
        })
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    return streamGeminiSSE(resp, onChunk);
}

// Remove any trailing model message with unanswered function calls (Gemini history)
function repairGeminiHistory() {
    const last = geminiHistory[geminiHistory.length - 1];
    if (last?.role === 'model' && last.parts?.some(p => p.functionCall)) {
        geminiHistory.pop();
    }
}

// Remove any trailing assistant message with unanswered tool_calls (Mistral/OpenAI history)
function repairOpenAIStyleHistory(history) {
    const last = history[history.length - 1];
    if (last?.role === 'assistant' && last.tool_calls?.length) {
        history.pop();
    }
}

const PROGRESS_TOOLS    = new Set(['set_resources', 'clear_blend', 'load_blend', 'set_board', 'set_overview']);
const NON_PROGRESS_LIMIT = 5; // consecutive info-only rounds before aborting

async function runGeminiLoop(apiKey, placeholder) {
    repairGeminiHistory();
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
    let nonProgressRounds = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (estimateTokens(geminiHistory) > getContextThreshold())
            await compactGeminiHistory(apiKey, placeholder);

        const thinkTask = placeholder.addThinkingTask();
        thinkTask.setPrompt(JSON.stringify(geminiHistory[geminiHistory.length - 1], null, 2));

        const { parts, usage: gUsage } = await withRetry(
            () => callGemini(apiKey, (chunk, type) => thinkTask.append(chunk, type)),
            (attempt, e) => thinkTask.append(`\n[retry ${attempt + 1}: ${e.message}]\n`, 'output')
        );
        geminiHistory.push({ role: 'model', parts });
        thinkTask.setTokens(gUsage?.promptTokenCount, gUsage?.candidatesTokenCount);
        thinkTask.complete(); updateTokenLabel();

        const funcCallParts = parts.filter(p => p.functionCall);
        if (funcCallParts.length === 0) {
            const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
            return { text, actionsCount: totalActionsCount };
        }

        const sig = JSON.stringify(funcCallParts.map(p => p.functionCall));
        if (sig === lastToolSig) { if (++loopCount >= 3) return { text: '*(loop detected)*', actionsCount: totalActionsCount }; }
        else { lastToolSig = sig; loopCount = 0; }

        const hasProgress = funcCallParts.some(p => PROGRESS_TOOLS.has(p.functionCall.name));
        if (hasProgress) nonProgressRounds = 0;
        else if (++nonProgressRounds >= NON_PROGRESS_LIMIT)
            return { text: '*(stopped: too many rounds without blend changes)*', actionsCount: totalActionsCount };

        const labels    = funcCallParts.map(p => toolLabel(p.functionCall.name, p.functionCall.args));
        const toolTasks = placeholder.addToolStep(labels);

        const funcResponses = await Promise.all(funcCallParts.map(async (part, i) => {
            const { name, args } = part.functionCall;
            const task = toolTasks[i];
            task.setPrompt(JSON.stringify({ tool: name, args }, null, 2));
            let result;
            try {
                result = await executeToolAsync(name, args);
            } catch (e) {
                result = { error: e.message };
            }
            task.setOutput(JSON.stringify(result, null, 2));
            if (name === 'set_resources') totalActionsCount += result.applied || 0;
            if (name === 'clear_blend' || name === 'set_board') totalActionsCount += 1;
            task.complete();
            return { functionResponse: { name, response: result } };
        }));

        geminiHistory.push({ role: 'user', parts: funcResponses });
    }
    return { text: '*(max tool rounds reached)*', actionsCount: totalActionsCount };
}

// ----------------------------------------
// Mistral API
// ----------------------------------------
async function callMistral(apiKey, onChunk) {
    const model = getAgentModel();
    const body = {
        model,
        messages:    [{ role: 'system', content: buildSystemPrompt() }, ...mistralHistory],
        tools:       MISTRAL_TOOLS,
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens:  32768,
        stream:      true
    };
    // Note: thinking/reasoning budgets are only supported by magistral models, not mistral-large
    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal:  activeAbortController?.signal,
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let msg = `HTTP ${resp.status}`;
        try {
            const j = JSON.parse(body);
            const raw = j.message || j.detail || j.error?.message || j.error || msg;
            msg = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {}
        throw new Error(msg);
    }
    return streamOpenAICompat(resp, onChunk);
}

async function runMistralLoop(apiKey, placeholder) {
    repairOpenAIStyleHistory(mistralHistory);
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
    let nonProgressRounds = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (estimateTokens(mistralHistory) > getContextThreshold())
            await compactOpenAIStyleHistory(apiKey, mistralHistory,
                'https://api.mistral.ai/v1/chat/completions',
                { 'Authorization': `Bearer ${apiKey}` }, placeholder);

        const thinkTask = placeholder.addThinkingTask();
        const lastEntry = mistralHistory[mistralHistory.length - 1];
        thinkTask.setPrompt(typeof lastEntry?.content === 'string'
            ? lastEntry.content : JSON.stringify(lastEntry, null, 2));

        const message = await withRetry(
            () => callMistral(apiKey, (chunk, type) => thinkTask.append(chunk, type)),
            (attempt, e) => thinkTask.append(`\n[retry ${attempt + 1}: ${e.message}]\n`, 'output')
        );
        if (!message) throw new Error('No response from Mistral');
        const { usage: mUsage, ...mistralMsg } = message;
        mistralHistory.push(mistralMsg);
        thinkTask.setTokens(mUsage?.prompt_tokens, mUsage?.completion_tokens);
        thinkTask.complete(); updateTokenLabel();

        const toolCalls = message.tool_calls || [];
        if (toolCalls.length === 0) {
            const raw  = message.content;
            const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(p => p.text || '').join('') : String(raw ?? '');
            return { text, actionsCount: totalActionsCount };
        }

        const sig = JSON.stringify(toolCalls.map(tc => ({ n: tc.function.name, a: tc.function.arguments })));
        if (sig === lastToolSig) { if (++loopCount >= 3) return { text: '*(loop detected)*', actionsCount: totalActionsCount }; }
        else { lastToolSig = sig; loopCount = 0; }

        const hasProgress = toolCalls.some(tc => PROGRESS_TOOLS.has(tc.function.name));
        if (hasProgress) nonProgressRounds = 0;
        else if (++nonProgressRounds >= NON_PROGRESS_LIMIT)
            return { text: '*(stopped: too many rounds without blend changes)*', actionsCount: totalActionsCount };

        const safeParseArgs = s => { try { return JSON.parse(s); } catch { return {}; } };
        const labels    = toolCalls.map(tc => toolLabel(tc.function.name, safeParseArgs(tc.function.arguments)));
        const toolTasks = placeholder.addToolStep(labels);

        const results = await Promise.all(toolCalls.map(async (tc, i) => {
            const name = tc.function.name;
            const args = safeParseArgs(tc.function.arguments);
            const task = toolTasks[i];
            task.setPrompt(JSON.stringify({ tool: name, args }, null, 2));
            let result;
            try {
                result = await executeToolAsync(name, args);
            } catch (e) {
                result = { error: e.message };
            }
            task.setOutput(JSON.stringify(result, null, 2));
            if (name === 'set_resources') totalActionsCount += result.applied || 0;
            if (name === 'clear_blend' || name === 'set_board') totalActionsCount += 1;
            task.complete();
            return { tc, name, result };
        }));

        for (const { tc, name, result } of results) {
            mistralHistory.push({ role: 'tool', tool_call_id: tc.id, name, content: JSON.stringify(result) });
        }
    }
    return { text: '*(max tool rounds reached)*', actionsCount: totalActionsCount };
}

// ----------------------------------------
// ----------------------------------------
// Text helpers
// ----------------------------------------
function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
    return escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
}

function cleanResponse(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/^#{1,6} .+$/gm, '')
        .replace(/^---+\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ----------------------------------------
// Chart rendering (SVG)
// ----------------------------------------
const CHART_PALETTE = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];

function renderChartSVG({ type = 'bar', title = '', labels = [], datasets = [] }) {
    const W = 500, H = 300;
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let body = '';

    if (title) body += `<text x="${W/2}" y="20" text-anchor="middle" font-size="14" font-weight="600" fill="#333">${esc(title)}</text>`;

    const pad = { top: title ? 36 : 12, right: 20, bottom: 56, left: 56 };
    const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;

    if (type === 'pie' || type === 'donut') {
        const vals  = datasets[0]?.values || [];
        const total = vals.reduce((a, b) => a + b, 0) || 1;
        const cx = pad.left + cw * 0.38, cy = pad.top + ch / 2, r = Math.min(cw * 0.38, ch / 2) - 4;
        let angle = -Math.PI / 2;
        const slices = vals.map((v, i) => {
            const a  = (v / total) * 2 * Math.PI;
            const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
            angle += a;
            return { v, label: labels[i] || '', color: CHART_PALETTE[i % CHART_PALETTE.length],
                     x1, y1, x2: cx + r * Math.cos(angle), y2: cy + r * Math.sin(angle),
                     large: a > Math.PI ? 1 : 0, pct: ((v / total) * 100).toFixed(1) };
        });
        for (const s of slices)
            body += `<path d="M${cx},${cy} L${s.x1},${s.y1} A${r},${r} 0 ${s.large},1 ${s.x2},${s.y2} Z" fill="${s.color}" stroke="white" stroke-width="1.5"/>`;
        if (type === 'donut') body += `<circle cx="${cx}" cy="${cy}" r="${r*0.45}" fill="white"/>`;
        const legX = cx + r + 18;
        for (let i = 0; i < slices.length; i++) {
            const ly = pad.top + i * 18;
            body += `<rect x="${legX}" y="${ly}" width="11" height="11" fill="${slices[i].color}" rx="2"/>`;
            body += `<text x="${legX+15}" y="${ly+9}" font-size="11" fill="#444">${esc(slices[i].label)} (${slices[i].pct}%)</text>`;
        }
    } else if (type === 'horizontal_bar') {
        const vals = datasets[0]?.values || [];
        const max  = Math.max(...vals.map(Math.abs), 1);
        const step = ch / (labels.length || 1);
        const barH = Math.min(22, step - 5);
        for (let gi = 0; gi <= 4; gi++) {
            const x = pad.left + (gi / 4) * cw;
            body += `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${pad.top+ch}" stroke="${gi===0?'#ccc':'#eee'}" stroke-width="1"/>`;
            body += `<text x="${x}" y="${pad.top+ch+14}" text-anchor="middle" font-size="10" fill="#aaa">${Math.round((gi/4)*max)}</text>`;
        }
        for (let i = 0; i < labels.length; i++) {
            const y  = pad.top + i * step + step / 2;
            const bw = Math.max(0, (vals[i] / max) * cw);
            const color = CHART_PALETTE[i % CHART_PALETTE.length];
            body += `<rect x="${pad.left}" y="${y - barH/2}" width="${bw}" height="${barH}" fill="${color}" rx="2"/>`;
            body += `<text x="${pad.left-5}" y="${y+4}" text-anchor="end" font-size="11" fill="#555">${esc(labels[i])}</text>`;
            if (vals[i] > 0) body += `<text x="${pad.left+bw+4}" y="${y+4}" font-size="11" fill="#333">${vals[i]}</text>`;
        }
    } else {
        // bar or line
        const allVals = datasets.flatMap(d => d.values || []);
        const max = Math.max(...allVals.map(Math.abs), 1);
        const n = labels.length || 1, nd = datasets.length || 1;
        const groupW = cw / n;
        const barW   = Math.min(groupW / nd - 3, 38);
        for (let gi = 0; gi <= 4; gi++) {
            const y = pad.top + ch - (gi / 4) * ch;
            body += `<line x1="${pad.left}" y1="${y}" x2="${pad.left+cw}" y2="${y}" stroke="${gi===0?'#ccc':'#eee'}" stroke-width="1"/>`;
            body += `<text x="${pad.left-4}" y="${y+4}" text-anchor="end" font-size="10" fill="#aaa">${Math.round((gi/4)*max)}</text>`;
        }
        if (type === 'line') {
            for (let di = 0; di < datasets.length; di++) {
                const color = datasets[di].color || CHART_PALETTE[di % CHART_PALETTE.length];
                const pts = (datasets[di].values || []).map((v, i) =>
                    `${pad.left + (i + 0.5) * groupW},${pad.top + ch - (v / max) * ch}`).join(' ');
                body += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
                (datasets[di].values || []).forEach((v, i) => {
                    const x = pad.left + (i + 0.5) * groupW, y = pad.top + ch - (v / max) * ch;
                    body += `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="white" stroke-width="1.5"/>`;
                });
            }
        } else {
            for (let di = 0; di < datasets.length; di++) {
                const color = datasets[di].color || CHART_PALETTE[di % CHART_PALETTE.length];
                (datasets[di].values || []).forEach((v, i) => {
                    const x  = pad.left + i * groupW + (groupW - nd * (barW + 3)) / 2 + di * (barW + 3);
                    const bh = (v / max) * ch, y = pad.top + ch - bh;
                    body += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${color}" rx="2"/>`;
                    if (bh > 14) body += `<text x="${x+barW/2}" y="${y+11}" text-anchor="middle" font-size="9" fill="white">${v}</text>`;
                });
            }
        }
        for (let i = 0; i < labels.length; i++) {
            const x = pad.left + (i + 0.5) * groupW;
            body += `<text x="${x}" y="${pad.top+ch+16}" text-anchor="end" font-size="10" fill="#555" transform="rotate(-35 ${x} ${pad.top+ch+16})">${esc(labels[i])}</text>`;
        }
        if (datasets.length > 1) datasets.forEach((ds, di) => {
            const lx = pad.left + di * 110;
            body += `<rect x="${lx}" y="${H-16}" width="10" height="10" fill="${ds.color||CHART_PALETTE[di%CHART_PALETTE.length]}" rx="2"/>`;
            body += `<text x="${lx+14}" y="${H-7}" font-size="10" fill="#444">${esc(ds.label||'')}</text>`;
        });
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto;display:block;font-family:system-ui,sans-serif">${body}</svg>`;
}

// ----------------------------------------
// UI helpers
// ----------------------------------------
function getMessagesEl() { return document.getElementById('agent-messages'); }

function scrollIfNearBottom(el, threshold = 80) {
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
        el.scrollTop = el.scrollHeight;
    }
}

function actionsNote(count) {
    const note = document.createElement('div');
    note.className = 'agent-actions-note';
    note.innerHTML = `<small>&#10003; Applied ${count} blend change${count > 1 ? 's' : ''}</small>`;
    return note;
}

function appendMessage(role, html, actionsCount = 0) {
    const msgs = getMessagesEl();
    const div  = document.createElement('div');
    div.className = `agent-msg agent-msg-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'agent-msg-bubble';
    bubble.innerHTML = html;
    div.appendChild(bubble);

    if (actionsCount > 0) div.appendChild(actionsNote(actionsCount));

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
}

// ----------------------------------------
// Sequence graph placeholder
// ----------------------------------------
function createResponsePlaceholder() {
    const msgs = getMessagesEl();
    const div  = document.createElement('div');
    div.className = 'agent-msg agent-msg-model';

    const bubble = document.createElement('div');
    bubble.className = 'agent-msg-bubble';
    div.appendChild(bubble);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;

    // Left-to-right sequence graph
    const graphEl = document.createElement('div');
    graphEl.className = 'seq-graph';
    bubble.appendChild(graphEl);

    // Live streaming area — active task columns shown here during execution
    const liveEl = document.createElement('div');
    liveEl.className = 'seq-live-detail';
    bubble.appendChild(liveEl);

    // Selected-task detail area — shown after clicking a completed task
    const selectedEl = document.createElement('div');
    selectedEl.className = 'seq-selected-detail';
    bubble.appendChild(selectedEl);

    // Chart area — render_chart tool appends SVG charts here
    const chartsEl = document.createElement('div');
    chartsEl.className = 'seq-charts';
    bubble.appendChild(chartsEl);

    let stepCount     = 0;
    let selectedBadge = null; // currently highlighted task badge
    const activeTimers = new Set();

    function makeSubBox(label) {
        const wrap = document.createElement('div');
        wrap.className = 'step-sub-box';

        const labelRow = document.createElement('div');
        labelRow.className = 'step-sub-label';

        const btn = document.createElement('button');
        btn.className = 'step-toggle';
        btn.textContent = '▶';

        const nameEl = document.createElement('span');
        nameEl.className = 'step-sub-name';
        nameEl.textContent = label;

        labelRow.appendChild(btn);
        labelRow.appendChild(nameEl);

        const detail = document.createElement('div');
        detail.className = 'step-detail';

        const pre = document.createElement('pre');
        pre.className = 'step-content-pre';
        detail.appendChild(pre);

        btn.addEventListener('click', () => {
            const isOpen = detail.classList.toggle('step-detail-open');
            btn.textContent = isOpen ? '▼' : '▶';
        });

        wrap.appendChild(labelRow);
        wrap.appendChild(detail);

        function open() {
            if (!detail.classList.contains('step-detail-open')) {
                detail.classList.add('step-detail-open');
                btn.textContent = '▼';
            }
        }

        return { wrap, detail, pre, open };
    }

    function createTask(stepEl, label) {
        // Badge in graph
        const badge = document.createElement('div');
        badge.className = 'seq-task seq-running';

        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        badge.appendChild(labelEl);

        const tokenEl = document.createElement('span');
        tokenEl.className = 'seq-task-tokens';
        badge.appendChild(tokenEl);

        // Timer
        const timerEl = document.createElement('span');
        timerEl.className = 'seq-task-timer';
        timerEl.textContent = ' 0.0s';
        badge.appendChild(timerEl);

        stepEl.appendChild(badge);
        const startTime = Date.now();
        const timerId = setInterval(() => {
            timerEl.textContent = ` ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        }, 100);
        activeTimers.add(timerId);

        // Detail column (shown in liveEl during run, stored after complete)
        const colEl = document.createElement('div');
        colEl.className = 'seq-detail-col';

        const colHeader = document.createElement('div');
        colHeader.className = 'seq-col-header';
        colHeader.textContent = label;
        colEl.appendChild(colHeader);

        const promptBox   = makeSubBox('Prompt');
        const thinkingBox = makeSubBox('Thinking');
        const outputBox   = makeSubBox('Output');

        colEl.appendChild(promptBox.wrap);
        colEl.appendChild(thinkingBox.wrap);
        colEl.appendChild(outputBox.wrap);
        liveEl.appendChild(colEl);

        let done = false;
        let latestOutputSpan   = null;
        let latestThinkingSpan = null;

        function commitLatest(spanRef, setRef) {
            if (spanRef) spanRef.classList.remove('seq-stream-latest');
            setRef(null);
        }

        const handle = {
            markCompact() {
                badge.classList.add('seq-compact');
            },
            setTokens(input, output) {
                const parts = [];
                if (input  != null) parts.push(`↑${input}`);
                if (output != null) parts.push(`↓${output}`);
                if (parts.length) tokenEl.textContent = ' ' + parts.join(' ');
            },
            setPrompt(text) {
                promptBox.pre.textContent = text;
                scrollIfNearBottom(msgs);
            },
            append(text, type) {
                if (type === 'thinking') {
                    thinkingBox.open();
                    if (latestThinkingSpan) latestThinkingSpan.classList.remove('seq-stream-latest');
                    const span = document.createElement('span');
                    span.className = 'seq-stream-latest';
                    span.textContent = text;
                    thinkingBox.pre.appendChild(span);
                    latestThinkingSpan = span;
                    thinkingBox.pre.scrollTop = thinkingBox.pre.scrollHeight;
                } else {
                    outputBox.open();
                    if (latestOutputSpan) latestOutputSpan.classList.remove('seq-stream-latest');
                    const span = document.createElement('span');
                    span.className = 'seq-stream-latest';
                    span.textContent = text;
                    outputBox.pre.appendChild(span);
                    latestOutputSpan = span;
                    outputBox.pre.scrollTop = outputBox.pre.scrollHeight;
                }
                scrollIfNearBottom(msgs);
            },
            setOutput(text) {
                latestOutputSpan = null;
                outputBox.open();
                outputBox.pre.textContent = text;
                scrollIfNearBottom(msgs);
            },
            complete() {
                if (done) return;
                done = true;
                commitLatest(latestOutputSpan,   v => { latestOutputSpan   = v; });
                commitLatest(latestThinkingSpan, v => { latestThinkingSpan = v; });
                clearInterval(timerId);
                activeTimers.delete(timerId);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                timerEl.textContent = ` ${elapsed}s`;
                badge.classList.remove('seq-running');
                badge.classList.add('seq-done');

                // Close sub-boxes; hide entirely if they have no content
                [promptBox, thinkingBox, outputBox].forEach(b => {
                    b.detail.classList.remove('step-detail-open');
                    b.wrap.querySelector('.step-toggle').textContent = '▶';
                    if (!b.pre.textContent.trim()) b.wrap.style.display = 'none';
                });

                // Move col out of live area (stored in closure)
                colEl.remove();

                // Click badge to show/hide stored detail below graph
                badge.addEventListener('click', () => {
                    if (selectedBadge === badge) {
                        badge.classList.remove('seq-selected');
                        selectedEl.innerHTML = '';
                        selectedBadge = null;
                    } else {
                        if (selectedBadge) selectedBadge.classList.remove('seq-selected');
                        selectedEl.innerHTML = '';
                        selectedEl.appendChild(colEl);
                        badge.classList.add('seq-selected');
                        selectedBadge = badge;
                        // Auto-expand sub-boxes that have content, in time order (Prompt → Thinking → Output)
                        [promptBox, thinkingBox, outputBox].forEach(box => {
                            if (box.wrap.style.display === 'none') return;
                            if (!box.detail.classList.contains('step-detail-open')) {
                                box.detail.classList.add('step-detail-open');
                                box.wrap.querySelector('.step-toggle').textContent = '▼';
                            }
                        });
                        msgs.scrollTop = msgs.scrollHeight;
                    }
                });
            },
            abort() {
                if (done) return;
                done = true;
                commitLatest(latestOutputSpan,   v => { latestOutputSpan   = v; });
                commitLatest(latestThinkingSpan, v => { latestThinkingSpan = v; });
                clearInterval(timerId);
                activeTimers.delete(timerId);
                badge.classList.remove('seq-running');
                badge.classList.add('seq-stopped');
                colEl.remove();
            }
        };

        return handle;
    }

    function addStep(labels) {
        // Arrow between steps
        if (stepCount > 0) {
            const arrow = document.createElement('div');
            arrow.className = 'seq-arrow';
            arrow.textContent = '→';
            graphEl.appendChild(arrow);
        }
        stepCount++;

        const stepEl = document.createElement('div');
        stepEl.className = 'seq-step';
        graphEl.appendChild(stepEl);
        scrollIfNearBottom(msgs);

        return labels.map(label => createTask(stepEl, label));
    }

    function addThinkingTask() {
        return addStep(['Thinking…'])[0];
    }

    function addToolStep(labels) {
        return addStep(labels);
    }

    function addCompactStep() {
        const task = addStep(['compact history…'])[0];
        task.markCompact();
        return task;
    }

    function stopAll() {
        activeTimers.forEach(t => clearInterval(t));
        activeTimers.clear();
        // Mark any still-running badges as stopped and clear live area
        graphEl.querySelectorAll('.seq-task.seq-running').forEach(el => {
            el.classList.remove('seq-running');
            el.classList.add('seq-stopped');
        });
        while (liveEl.firstChild) liveEl.removeChild(liveEl.firstChild);
    }

    function finalize(fullText, actionsCount) {
        stopAll();
        const safeText = typeof fullText === 'string' ? fullText : String(fullText ?? '');
        const cleaned  = cleanResponse(safeText);
        if (cleaned) {
            const responseEl = document.createElement('div');
            responseEl.className = 'agent-response-text';
            responseEl.innerHTML = renderMarkdown(cleaned);
            bubble.appendChild(responseEl);

        }
        if (actionsCount > 0) div.appendChild(actionsNote(actionsCount));
        scrollIfNearBottom(msgs);
    }

    function addChart(svgHtml) {
        const wrap = document.createElement('div');
        wrap.className = 'seq-chart-wrap';
        wrap.innerHTML = svgHtml; // safe — generated by renderChartSVG, not user input
        chartsEl.appendChild(wrap);
        scrollIfNearBottom(msgs);
    }

    return { div, addThinkingTask, addToolStep, addCompactStep, addChart, finalize };
}

function setInputState(enabled) {
    const btn   = document.getElementById('agent-action-btn');
    const input = document.getElementById('agent-input');
    const regen = document.getElementById('agent-regen-btn');
    if (btn) {
        btn.innerHTML = enabled ? '&#9654;&#65038;' : '&#9632;&#65038;';
        btn.title     = enabled ? 'Send' : 'Stop';
        btn.className = enabled ? 'btn btn-success' : 'btn btn-danger';
    }
    if (input) input.disabled = !enabled;
    if (regen) regen.style.display = (enabled && lastUserMessageText) ? '' : 'none';
}

// ----------------------------------------
// History persistence (localStorage)
// ----------------------------------------
function saveHistoryToStorage() {
    try {
        const gh = JSON.stringify(geminiHistory);
        const mh = JSON.stringify(mistralHistory);
        if (gh.length + mh.length < 3_500_000) {
            localStorage.setItem('db_gh', gh);
            localStorage.setItem('db_mh', mh);
            localStorage.setItem('db_lp', lastProvider || '');
        }
    } catch {}
    try {
        const html = getMessagesEl()?.innerHTML || '';
        if (html.length < 2_000_000) localStorage.setItem('db_msgs', html);
    } catch {}
    saveBlendState();
}

function loadHistoryFromStorage() {
    try {
        const gh = localStorage.getItem('db_gh');
        const mh = localStorage.getItem('db_mh');
        const lp = localStorage.getItem('db_lp');
        if (gh) geminiHistory  = JSON.parse(gh);
        if (mh) mistralHistory = JSON.parse(mh);
        if (lp) lastProvider   = lp || null;
        return geminiHistory.length > 0 || mistralHistory.length > 0;
    } catch {}
    return false;
}

function restoreMessages() {
    try {
        const saved = localStorage.getItem('db_msgs');
        if (!saved) return false;
        const msgs = getMessagesEl();
        if (!msgs) return false;
        msgs.innerHTML = saved;
        // Detail panels reference closures that no longer exist — clear them to avoid stale DOM
        msgs.querySelectorAll('.seq-selected-detail').forEach(el => { el.innerHTML = ''; });
        msgs.scrollTop = msgs.scrollHeight;
        return true;
    } catch {}
    return false;
}

// Fallback: render a plain text transcript from API history when saved HTML isn't available
function renderHistoryFallback() {
    const msgs = getMessagesEl();
    if (!msgs) return;

    const notice = document.createElement('div');
    notice.className = 'agent-history-notice';
    notice.textContent = '↩ Reconstructed from saved context — tool steps not shown.';
    msgs.appendChild(notice);

    if (geminiHistory.length) {
        for (const msg of geminiHistory) {
            const textParts = (msg.parts || []).filter(p => p.text && !p.thought);
            if (!textParts.length) continue;
            if (msg.role === 'user' && !(msg.parts || []).some(p => p.functionResponse)) {
                appendMessage('user', renderMarkdown(textParts.map(p => p.text).join('')));
            } else if (msg.role === 'model') {
                const text = cleanResponse(textParts.map(p => p.text).join(''));
                if (text) appendMessage('model', renderMarkdown(text));
            }
        }
    } else {
        for (const msg of mistralHistory) {
            if (msg.role === 'user' && typeof msg.content === 'string') {
                appendMessage('user', renderMarkdown(msg.content));
            } else if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
                const text = cleanResponse(msg.content);
                if (text) appendMessage('model', renderMarkdown(text));
            }
        }
    }

    msgs.scrollTop = msgs.scrollHeight;
}

function clearHistoryStorage() {
    ['db_gh', 'db_mh', 'db_lp', 'db_msgs'].forEach(k => localStorage.removeItem(k));
    try {
        const list = JSON.parse(localStorage.getItem('db_ckpt_list') || '[]');
        list.forEach(id => localStorage.removeItem(`db_ckpt_${id}`));
        localStorage.removeItem('db_ckpt_list');
    } catch {}
}

// ----------------------------------------
// Blend state persistence
// ----------------------------------------

function collectBlendSnapshot() {
    const allRes = window.getAllResources ? window.getAllResources() : {};
    const selections = {};
    for (const [type, items] of Object.entries(allRes)) {
        const sel = items.filter(r => (r.selected || 0) > 0);
        if (sel.length) selections[type] = sel.map(r => ({
            name:   r.objective || r.name    || '',
            source: r.source    || r.card_set || '',
            ...(r.resource_id !== undefined && { resource_id: r.resource_id }),
            count: r.selected
        }));
    }
    const board = {
        main:          document.querySelector('input[name="mainBoard"]:checked')?.value || 'imperium',
        choam:         !!document.getElementById('board-choam')?.checked,
        ix:            !!document.getElementById('board-ix')?.checked,
        tleilax:       !!document.getElementById('board-tleilax')?.checked,
        research:      !!document.getElementById('board-research')?.checked,
        embassy:       !!document.getElementById('board-embassy')?.checked,
        familyAtomics: !!document.getElementById('board-family-atomics')?.checked,
    };
    const overview = {
        description:      document.getElementById('overview-description')?.value      || '',
        leader_selection: document.getElementById('overview-leader-selection')?.value || '',
        house_rules:      document.getElementById('overview-house-rules')?.value      || '',
    };
    return { selections, board, overview };
}

function saveBlendState() {
    try {
        localStorage.setItem('db_blend', JSON.stringify(collectBlendSnapshot()));
    } catch {}
}

function applyBlendSnapshot({ selections = {}, board = {}, overview = {} } = {}) {
    suppressInteractionLog = true;
    try {
        // Board radios and checkboxes
        const mainEl = document.getElementById(`board-${board.main || 'imperium'}`);
        if (mainEl) mainEl.checked = true;
        const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
        setCheck('board-choam',          board.choam);
        setCheck('board-ix',             board.ix);
        setCheck('board-tleilax',        board.tleilax);
        setCheck('board-research',       board.research);
        setCheck('board-embassy',        board.embassy);
        setCheck('board-family-atomics', board.familyAtomics);

        // Overview fields
        const setText = (id, val) => { if (val !== undefined) { const el = document.getElementById(id); if (el) el.value = val; } };
        setText('overview-description',      overview.description);
        setText('overview-leader-selection', overview.leader_selection);
        setText('overview-house-rules',      overview.house_rules);

        // Clear all current selections, then re-render tables at 0
        const allRes = window.getAllResources ? window.getAllResources() : {};
        for (const items of Object.values(allRes)) for (const r of items) r.selected = 0;
        window.initializeAllTabs?.();

        // Restore selections
        for (const [type, saved] of Object.entries(selections)) {
            const pool = allRes[type] || [];
            for (const s of saved) {
                const targets = pool.filter(r =>
                    s.resource_id !== undefined
                        ? r.resource_id === s.resource_id
                        : (r.objective || r.name    || '') === s.name &&
                          (r.source    || r.card_set || '') === s.source
                );
                for (const r of targets) {
                    const name  = r.objective || r.name;
                    const src   = r.source    || r.card_set || '';
                    const max   = r.count     || r.count_per_player || 1;
                    const props = r.resource_id !== undefined ? { resource_id: r.resource_id } : {};
                    const toAdd = Math.min(s.count, max) - (r.selected || 0);
                    for (let i = 0; i < toAdd; i++) window.incrementSelected(type, name, src, max, props);
                }
            }
        }
        for (const type of Object.keys(allRes)) window.updateBadge?.(type);
        window.updateRequiredSets?.();
        window.refreshAllStats?.();
    } catch {}
    suppressInteractionLog = false;
}

function restoreBlendState() {
    try {
        const raw = localStorage.getItem('db_blend');
        if (!raw) return;
        applyBlendSnapshot(JSON.parse(raw));
    } catch {}
}

// ----------------------------------------
// Checkpoints — blend snapshot per message
// ----------------------------------------

function saveCheckpoint(userText = '') {
    const id = Date.now().toString();
    const ckpt = {
        blend:      collectBlendSnapshot(),
        geminiLen:  geminiHistory.length,
        mistralLen: mistralHistory.length,
        provider:   lastProvider,
        userText,
    };
    try {
        localStorage.setItem(`db_ckpt_${id}`, JSON.stringify(ckpt));
        const list = JSON.parse(localStorage.getItem('db_ckpt_list') || '[]');
        list.push(id);
        // Cap at 50 checkpoints
        if (list.length > 50) {
            list.splice(0, list.length - 50).forEach(old => localStorage.removeItem(`db_ckpt_${old}`));
        }
        localStorage.setItem('db_ckpt_list', JSON.stringify(list));
    } catch {}
    return id;
}

function reloadCheckpoint(ckptId, msgDiv) {
    if (agentStreaming) return;
    try {
        const raw = localStorage.getItem(`db_ckpt_${ckptId}`);
        if (!raw) { alert('Checkpoint data not found.'); return; }
        const { blend, geminiLen, mistralLen, provider } = JSON.parse(raw);

        // Restore history lengths
        geminiHistory.length  = geminiLen;
        mistralHistory.length = mistralLen;
        if (provider !== undefined) lastProvider = provider;
        lastUserMessageText = '';

        // Restore blend state
        applyBlendSnapshot(blend);

        // Remove ckptRow, the user message above it, and all following siblings
        const msgs = getMessagesEl();
        let el = msgs.lastElementChild;
        while (el && el !== msgDiv) {
            const prev = el.previousElementSibling;
            el.remove();
            el = prev;
        }
        const userMsgEl = msgDiv.previousElementSibling;
        if (msgDiv.parentNode) msgDiv.remove();
        if (userMsgEl?.parentNode) userMsgEl.remove();

        saveHistoryToStorage();
        updateTokenLabel();
        setInputState(true);
    } catch (e) {
        console.error('[checkpoint] restore failed', e);
    }
}
window.reloadCheckpoint = reloadCheckpoint;

function rerunCheckpoint(ckptId, msgDiv) {
    if (agentStreaming) return;
    try {
        const raw = localStorage.getItem(`db_ckpt_${ckptId}`);
        if (!raw) { alert('Checkpoint data not found.'); return; }
        const { blend, geminiLen, mistralLen, provider, userText } = JSON.parse(raw);
        if (!userText) { alert('No message text saved in this checkpoint.'); return; }

        // Restore history and blend state (same as rewind)
        geminiHistory.length  = geminiLen;
        mistralHistory.length = mistralLen;
        if (provider !== undefined) lastProvider = provider;
        lastUserMessageText = '';
        applyBlendSnapshot(blend);

        // Remove ckptRow, the user message above it, and all following siblings
        const msgs = getMessagesEl();
        let el = msgs.lastElementChild;
        while (el && el !== msgDiv) {
            const prev = el.previousElementSibling;
            el.remove();
            el = prev;
        }
        const userMsgEl = msgDiv.previousElementSibling;
        if (msgDiv.parentNode) msgDiv.remove();
        if (userMsgEl?.parentNode) userMsgEl.remove();

        saveHistoryToStorage();
        updateTokenLabel();
        setInputState(true);

        // Re-send the original message
        const input = document.getElementById('agent-input');
        if (input) input.value = userText;
        agentSend();
    } catch (e) {
        console.error('[checkpoint] rerun failed', e);
    }
}
window.rerunCheckpoint = rerunCheckpoint;

// ----------------------------------------
// Bidirectional history conversion
// ----------------------------------------

// Gemini → Mistral format
function geminiToMistral(history) {
    const out = [];
    let pendingCallIds = {}; // tool name → [synthetic IDs in order]

    for (const msg of history) {
        if (msg.role === 'user') {
            const textParts     = (msg.parts || []).filter(p => p.text);
            const responseParts = (msg.parts || []).filter(p => p.functionResponse);

            if (responseParts.length > 0) {
                // One Mistral tool message per functionResponse part
                const nameCounters = {};
                for (const part of responseParts) {
                    const name = part.functionResponse.name;
                    nameCounters[name] = nameCounters[name] || 0;
                    const idList = pendingCallIds[name] || [];
                    const id = idList[nameCounters[name]] || `call_${name}_${nameCounters[name]}`;
                    nameCounters[name]++;
                    out.push({
                        role: 'tool',
                        tool_call_id: id,
                        name,
                        content: JSON.stringify(part.functionResponse.response)
                    });
                }
                pendingCallIds = {};
            } else {
                const text = textParts.map(p => p.text).join('');
                out.push({ role: 'user', content: text });
            }
        } else if (msg.role === 'model') {
            const textParts = (msg.parts || []).filter(p => p.text && !p.thought);
            const callParts = (msg.parts || []).filter(p => p.functionCall);

            if (callParts.length > 0) {
                const tool_calls = callParts.map((part, i) => {
                    const name = part.functionCall.name;
                    const id   = `call_${name}_${Date.now()}_${i}`;
                    if (!pendingCallIds[name]) pendingCallIds[name] = [];
                    pendingCallIds[name].push(id);
                    return {
                        id,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(part.functionCall.args || {}) }
                    };
                });
                const content = textParts.map(p => p.text).join('') || null;
                out.push({ role: 'assistant', content, tool_calls });
            } else {
                const content = textParts.map(p => p.text).join('');
                out.push({ role: 'assistant', content });
            }
        }
    }
    return out;
}

// Mistral → Gemini format
function mistralToGemini(history) {
    const out = [];
    let i = 0;

    while (i < history.length) {
        const msg = history[i];

        if (msg.role === 'user') {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            out.push({ role: 'user', parts: [{ text }] });
            i++;
        } else if (msg.role === 'assistant') {
            const parts = [];
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (content) parts.push({ text: content });
            for (const tc of (msg.tool_calls || [])) {
                let args;
                try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                parts.push({ functionCall: { name: tc.function.name, args } });
            }
            out.push({ role: 'model', parts });
            i++;
        } else if (msg.role === 'tool') {
            // Collect all consecutive tool messages into one user functionResponse message
            const parts = [];
            while (i < history.length && history[i].role === 'tool') {
                const tm = history[i];
                let response;
                try { response = JSON.parse(tm.content); } catch { response = { content: tm.content }; }
                parts.push({ functionResponse: { name: tm.name, response } });
                i++;
            }
            out.push({ role: 'user', parts });
        } else {
            i++;
        }
    }
    return out;
}

// ----------------------------------------
// Regenerate
// ----------------------------------------

// Truncate the current provider's history back to just after the last real user message,
// removing the model's response and any intervening tool rounds.
function truncateHistoryToLastUserMessage() {
    const provider = getProvider();
    if (provider === 'mistral') {
        let i = mistralHistory.length - 1;
        while (i >= 0 && mistralHistory[i].role !== 'user') i--;
        if (i >= 0) mistralHistory.splice(i + 1);
    } else {
        let i = geminiHistory.length - 1;
        while (i >= 0) {
            const m = geminiHistory[i];
            if (m.role === 'user' && !m.parts?.some(p => p.functionResponse)) break;
            i--;
        }
        if (i >= 0) geminiHistory.splice(i + 1);
    }
}

async function agentRegenerate() {
    if (agentStreaming || !lastUserMessageText) return;
    const apiKey = getActiveApiKey();
    if (!apiKey) return;

    truncateHistoryToLastUserMessage();

    // Remove the last model message bubble from the DOM
    const msgs = getMessagesEl();
    if (msgs?.lastElementChild?.classList.contains('agent-msg-model'))
        msgs.lastElementChild.remove();

    agentStreaming         = true;
    setInputState(false);
    activePlaceholder     = createResponsePlaceholder();
    activeAbortController = new AbortController();
    const placeholder     = activePlaceholder;
    const provider        = getProvider();

    try {
        const { text: finalText, actionsCount } =
            provider === 'mistral' ? await runMistralLoop(apiKey, placeholder) :
                                     await runGeminiLoop(apiKey, placeholder);
        placeholder.finalize(finalText, actionsCount);
    } catch (err) {
        if (err.name === 'AbortError') placeholder.finalize('*(stopped)*', 0);
        else { placeholder.finalize(`**Error:** ${err.message}`, 0); console.error('[agent]', err); }
    }

    saveHistoryToStorage();
    activePlaceholder     = null;
    activeAbortController = null;
    agentStreaming        = false;
    setInputState(true);
    document.getElementById('agent-input')?.focus();
}

// ----------------------------------------
// Main send
// ----------------------------------------
async function agentSend() {
    if (agentStreaming) return;

    const apiKey = getActiveApiKey();
    if (!apiKey) {
        if (window.showApiKeyDialog) window.showApiKeyDialog('agent');
        else alert('Please set your API key via the ⚙️ AI Settings button.');
        return;
    }

    const input = document.getElementById('agent-input');
    const text  = (input.value || '').trim();
    if (!text) return;

    input.value          = '';
    lastUserMessageText  = text;
    agentStreaming       = true;
    setInputState(false);

    gcTrack('/agent/message', 'Agent message sent');

    const ckptId    = saveCheckpoint(text);
    const userMsgEl = appendMessage('user', renderMarkdown(text));
    userMsgEl.dataset.checkpointId = ckptId;
    const ckptRow = document.createElement('div');
    ckptRow.className = 'agent-ckpt-row';
    ckptRow.dataset.checkpointId = ckptId;
    const rewindBtn = document.createElement('button');
    rewindBtn.className      = 'agent-ckpt-btn';
    rewindBtn.dataset.action = 'rewind';
    rewindBtn.textContent    = '⏮ Rewind checkpoint';
    rewindBtn.title          = 'Rewind blend to state before this message and remove this and later messages';
    const rerunBtn = document.createElement('button');
    rerunBtn.className       = 'agent-ckpt-btn';
    rerunBtn.dataset.action  = 'rerun';
    rerunBtn.textContent     = '↺ Rerun checkpoint';
    rerunBtn.title           = 'Rewind to this checkpoint and re-send the message with the current model';
    ckptRow.appendChild(rewindBtn);
    ckptRow.appendChild(rerunBtn);
    getMessagesEl().appendChild(ckptRow);

    const provider = getProvider();

    // Convert history when switching providers so context is preserved
    if (lastProvider && provider !== lastProvider) {
        if (provider === 'mistral' && geminiHistory.length > 0) {
            mistralHistory = geminiToMistral(geminiHistory);
        } else if (provider === 'google' && mistralHistory.length > 0) {
            geminiHistory = mistralToGemini(mistralHistory);
        }
    }
    lastProvider = provider;

    // Prepend any manual UI changes as context, then reset the log
    const interactionContext = buildInteractionContext();
    interactionLog = [];
    const messageText = interactionContext ? `${interactionContext}${text}` : text;

    if (provider === 'mistral') {
        mistralHistory.push({ role: 'user', content: messageText });
    } else {
        geminiHistory.push({ role: 'user', parts: [{ text: messageText }] });
    }

    activePlaceholder     = createResponsePlaceholder();
    activeAbortController = new AbortController();
    const placeholder     = activePlaceholder;

    try {
        const { text: finalText, actionsCount } =
            provider === 'mistral' ? await runMistralLoop(apiKey, placeholder) :
                                     await runGeminiLoop(apiKey, placeholder);
        placeholder.finalize(finalText, actionsCount);
    } catch (err) {
        if (err.name === 'AbortError') {
            placeholder.finalize('*(stopped)*', 0);
        } else {
            placeholder.finalize(`**Error:** ${err.message}`, 0);
            console.error('[agent]', err);
        }
    }

    saveHistoryToStorage();
    activePlaceholder     = null;
    activeAbortController = null;
    agentStreaming        = false;
    setInputState(true);
    document.getElementById('agent-input')?.focus();
}

// ----------------------------------------
// Abort / clear
// ----------------------------------------
function agentAbort() {
    activeAbortController?.abort();
    agentStreaming = false;
    setInputState(true);
}

function agentAction() {
    if (agentStreaming) agentAbort();
    else agentSend();
}

function agentClear() {
    gcTrack('/agent/new-chat', 'Agent new chat');
    geminiHistory       = [];
    mistralHistory      = [];
    lastProvider        = null;
    lastUserMessageText = '';
    interactionLog      = [];
    fetchedResourceTypes = new Set();
    clearHistoryStorage();
    const msgs = getMessagesEl();
    if (msgs) msgs.innerHTML = '';
    updateTokenLabel();
    setInputState(true);
}

// ----------------------------------------
// Init
// ----------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    loadHistoryFromStorage();
    const messagesRestored = restoreMessages();
    updateTokenLabel();

    // If history exists but HTML wasn't saved, reconstruct a plain transcript
    if (!messagesRestored && (geminiHistory.length || mistralHistory.length)) {
        renderHistoryFallback();
    }

    // Event delegation for checkpoint buttons — works even after HTML restore
    getMessagesEl()?.addEventListener('click', e => {
        const btn = e.target.closest('.agent-ckpt-btn');
        if (!btn) return;
        const msgDiv = btn.closest('[data-checkpoint-id]');
        const ckptId = msgDiv?.dataset.checkpointId;
        if (!ckptId) return;
        if (btn.dataset.action === 'rerun') rerunCheckpoint(ckptId, msgDiv);
        else reloadCheckpoint(ckptId, msgDiv);
    });

    // Called by initializeAllTabs() — must only run once (initializeAllTabs is called again on clearBlend)
    window.onBlendReady = () => {
        window.onBlendReady = null;
        restoreBlendState();

        // Wrap selection mutators to auto-save and log manual user changes
        const _inc = window.incrementSelected;
        const _dec = window.decrementSelected;
        let blendTimer = null;
        const schedSave = () => { clearTimeout(blendTimer); blendTimer = setTimeout(saveBlendState, 400); };
        window.incrementSelected = (...a) => {
            _inc(...a); schedSave();
            if (!agentStreaming && !suppressInteractionLog)
                interactionLog.push(`+1 ${a[1]} (${a[2]}) [${a[0]}]`);
        };
        window.decrementSelected = (...a) => {
            _dec(...a); schedSave();
            if (!agentStreaming && !suppressInteractionLog)
                interactionLog.push(`-1 ${a[1]} (${a[2]}) [${a[0]}]`);
        };
    };

    // Track board changes the user makes manually
    ['board-imperium','board-uprising','board-choam','board-ix',
     'board-tleilax','board-research','board-embassy','board-family-atomics'
    ].forEach(id => {
        document.getElementById(id)?.addEventListener('change', ({ target: el }) => {
            if (agentStreaming || suppressInteractionLog) return;
            const name = id.replace('board-', '');
            interactionLog.push(el.type === 'radio'
                ? `Board: set to ${el.value}`
                : `Board ${name}: ${el.checked ? 'on' : 'off'}`);
        });
    });

    const input = document.getElementById('agent-input');
    if (input) {
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                agentSend();
            }
        });
    }

    const labelEl = document.getElementById('agent-model-label');
    if (labelEl) labelEl.textContent = getAgentModel();
});

window.agentSend           = agentSend;
window.agentClear          = agentClear;
window.agentAction         = agentAction;
window.agentRegenerate     = agentRegenerate;
window.saveBlendState      = saveBlendState;
window.applyBlendSnapshot  = applyBlendSnapshot;
window.collectBlendSnapshot = collectBlendSnapshot;
