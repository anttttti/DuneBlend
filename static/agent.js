// ========================================
// AI Agent Tab — DuneBlend
// Supports Google Gemini and Mistral AI
// API keys stored in localStorage: 'geminiApiKey', 'mistralApiKey'
// ========================================

const AGENT_MODEL_DEFAULT = 'gemini-3-flash-preview';
const MAX_TOOL_ROUNDS     = 1000;

// Set this to your deployed Cloudflare Worker URL, e.g.:
// 'https://duneblend-search.YOUR-SUBDOMAIN.workers.dev'
const SEARCH_WORKER_URL = '';

// ----------------------------------------
// Session state  (reset on agentClear)
// ----------------------------------------
let geminiHistory    = []; // [{role:'user'|'model', parts:[...]}]
let mistralHistory   = []; // [{role:'user'|'assistant'|'tool', content, tool_calls?}]
let agentStreaming        = false;
let fetchedResourceTypes  = new Set();
let activePlaceholder     = null;
let activeAbortController = null;
let lastProvider          = null; // tracks previous provider to detect switches

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

const SEARCH_TOOLS_GEMINI  = SEARCH_WORKER_URL ? [
    { name: 'web_search', description: WEB_SEARCH_DESCRIPTION, parameters: WEB_SEARCH_PARAMETERS },
    { name: 'fetch_url',  description: FETCH_URL_DESCRIPTION,  parameters: FETCH_URL_PARAMETERS  },
] : [];

const SEARCH_TOOLS_MISTRAL = SEARCH_WORKER_URL ? [
    { type: 'function', function: { name: 'web_search', description: WEB_SEARCH_DESCRIPTION, parameters: WEB_SEARCH_PARAMETERS } },
    { type: 'function', function: { name: 'fetch_url',  description: FETCH_URL_DESCRIPTION,  parameters: FETCH_URL_PARAMETERS  } },
] : [];

// Gemini format
const GEMINI_TOOLS = [{
    functionDeclarations: [
        { name: 'get_available_resources', description: TOOL_DESCRIPTION,          parameters: TOOL_PARAMETERS           },
        { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION,  parameters: SET_RESOURCES_PARAMETERS   },
        { name: 'set_board',               description: SET_BOARD_DESCRIPTION,      parameters: SET_BOARD_PARAMETERS       },
        { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,    parameters: EMPTY_PARAMETERS           },
        { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,     parameters: BLEND_TOOL_PARAMETERS      },
        { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,     parameters: STATS_TOOL_PARAMETERS      },
        { name: 'wikipedia_search',        description: WIKIPEDIA_DESCRIPTION,      parameters: WIKIPEDIA_PARAMETERS       },
        ...SEARCH_TOOLS_GEMINI
    ]
}];

// Mistral / OpenAI format
const MISTRAL_TOOLS = [
    { type: 'function', function: { name: 'get_available_resources', description: TOOL_DESCRIPTION,          parameters: TOOL_PARAMETERS           } },
    { type: 'function', function: { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION,  parameters: SET_RESOURCES_PARAMETERS   } },
    { type: 'function', function: { name: 'set_board',               description: SET_BOARD_DESCRIPTION,      parameters: SET_BOARD_PARAMETERS       } },
    { type: 'function', function: { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,    parameters: EMPTY_PARAMETERS           } },
    { type: 'function', function: { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,     parameters: BLEND_TOOL_PARAMETERS      } },
    { type: 'function', function: { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,     parameters: STATS_TOOL_PARAMETERS      } },
    { type: 'function', function: { name: 'wikipedia_search',        description: WIKIPEDIA_DESCRIPTION,      parameters: WIKIPEDIA_PARAMETERS       } },
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
    if (name === 'set_resources')           return `set:${args.resource_type}`;
    if (name === 'get_available_resources') return `get:${args.resource_type}`;
    if (name === 'get_blend_statistics')    return 'get:statistics';
    if (name === 'get_blend')               return `get:${args.filename || 'blend list'}`;
    if (name === 'set_board')               return 'set_board';
    if (name === 'clear_blend')             return 'clear_blend';
    if (name === 'web_search')              return `search:${args.query}`;
    if (name === 'fetch_url')               return `fetch:${args.url}`;
    if (name === 'wikipedia_search')        return `wiki:${args.query}`;
    return name;
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

    if (name === 'clear_blend') {
        if (window.clearAllResources) window.clearAllResources();
        return { success: true };
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
        if (!SEARCH_WORKER_URL) return { error: 'Search worker not configured.' };
        try {
            const resp = await fetch(`${SEARCH_WORKER_URL}?q=${encodeURIComponent(args.query)}`, {
                signal: activeAbortController?.signal
            });
            return await resp.json();
        } catch (e) {
            return { error: `Search failed: ${e.message}` };
        }
    }

    if (name === 'fetch_url') {
        if (!SEARCH_WORKER_URL) return { error: 'Search worker not configured.' };
        try {
            const resp = await fetch(`${SEARCH_WORKER_URL}?url=${encodeURIComponent(args.url)}`, {
                signal: activeAbortController?.signal
            });
            const text = await resp.text();
            return { content: text };
        } catch (e) {
            return { error: `Fetch failed: ${e.message}` };
        }
    }

    if (name === 'wikipedia_search') {
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
3. Call get_available_resources for each resource type you need.
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
A complete build MUST include all non-imperium types for the requested sets only. Never include cards from sets not in the blend.
- **leader / conflict**: Include ALL cards whose source matches one of the requested expansions. Exclude cards from other expansions entirely.
- **starter**: Include ALL starter cards from the primary base set (e.g. Uprising for an Uprising+Immortality blend). Exclude starters from other sets.
  Some starter strings start with "2× " — that means 2 physical copies; copy the prefix verbatim.
- **intrigue / reserve**: Include all cards from the requested sets only.

## Counting cards
Always count **physical copies**, not unique entries. A selection string "2× Card Name (Source)" counts as 2 physical cards, not 1. Sum the N× prefixes when verifying any total.

## Fixed Rules (apply unless the user explicitly overrides)
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
4. Use wikipedia_search to look up lore, rules, card details, or Dune universe information.${SEARCH_WORKER_URL ? `
5. Use web_search to find current information about Dune: Imperium cards, rules, or strategy.
   Use fetch_url to read a specific page from search results.` : ''}
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
    for await (const chunk of readSSE(resp)) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) onChunk(delta.reasoning_content, 'thinking');
        if (delta.content) {
            content += delta.content;
            onChunk(delta.content, 'output');
        }
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!tcMap[i]) tcMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id)                  tcMap[i].id = tc.id;
                if (tc.function?.name)      tcMap[i].function.name      += tc.function.name;
                if (tc.function?.arguments) tcMap[i].function.arguments += tc.function.arguments;
                if (tc.function?.arguments) onChunk(tc.function.arguments, 'output');
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

async function runGeminiLoop(apiKey, placeholder) {
    repairGeminiHistory();
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
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
    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal:  activeAbortController?.signal,
        body: JSON.stringify({
            model:       getAgentModel(),
            messages:    [{ role: 'system', content: buildSystemPrompt() }, ...mistralHistory],
            tools:       MISTRAL_TOOLS,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens:  32768,
            stream:      true
        })
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
// UI helpers
// ----------------------------------------
function getMessagesEl() { return document.getElementById('agent-messages'); }

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
                msgs.scrollTop = msgs.scrollHeight;
            },
            append(text, type) {
                if (type === 'thinking') {
                    thinkingBox.open();
                    thinkingBox.pre.textContent += text;
                    thinkingBox.pre.scrollTop = thinkingBox.pre.scrollHeight;
                } else {
                    outputBox.open();
                    outputBox.pre.textContent += text;
                    outputBox.pre.scrollTop = outputBox.pre.scrollHeight;
                }
                msgs.scrollTop = msgs.scrollHeight;
            },
            setOutput(text) {
                outputBox.open();
                outputBox.pre.textContent = text;
                msgs.scrollTop = msgs.scrollHeight;
            },
            complete() {
                if (done) return;
                done = true;
                clearInterval(timerId);
                activeTimers.delete(timerId);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                timerEl.textContent = ` ${elapsed}s`;
                badge.classList.remove('seq-running');
                badge.classList.add('seq-done');

                // Close all sub-boxes
                [promptBox, thinkingBox, outputBox].forEach(b => {
                    b.detail.classList.remove('step-detail-open');
                    b.detail.querySelector('.step-toggle') && (b.detail.querySelector('.step-toggle').textContent = '▶');
                    b.wrap.querySelector('.step-toggle').textContent = '▶';
                    b.detail.classList.remove('step-detail-open');
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
                        msgs.scrollTop = msgs.scrollHeight;
                    }
                });
            },
            abort() {
                if (done) return;
                done = true;
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
        msgs.scrollTop = msgs.scrollHeight;

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
        msgs.scrollTop = msgs.scrollHeight;
    }

    return { div, addThinkingTask, addToolStep, addCompactStep, finalize };
}

function setInputState(enabled) {
    const btn   = document.getElementById('agent-action-btn');
    const input = document.getElementById('agent-input');
    if (btn) {
        btn.innerHTML = enabled ? '&#9654;&#65038;' : '&#9632;&#65038;';
        btn.title     = enabled ? 'Send' : 'Stop';
        btn.className = enabled ? 'btn btn-success' : 'btn btn-danger';
    }
    if (input) input.disabled = !enabled;
}

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

    input.value    = '';
    agentStreaming = true;
    setInputState(false);

    appendMessage('user', renderMarkdown(text));

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

    if (provider === 'mistral') {
        mistralHistory.push({ role: 'user', content: text });
    } else {
        geminiHistory.push({ role: 'user', parts: [{ text }] });
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
    geminiHistory    = [];
    mistralHistory   = [];
    lastProvider     = null;
    fetchedResourceTypes = new Set();
    const msgs = getMessagesEl();
    if (msgs) msgs.innerHTML = '';
    updateTokenLabel();
}

// ----------------------------------------
// Init
// ----------------------------------------
document.addEventListener('DOMContentLoaded', () => {
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

window.agentSend   = agentSend;
window.agentClear  = agentClear;
window.agentAction = agentAction;
