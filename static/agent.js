// ========================================
// AI Agent Tab — DuneBlend
// Supports Google Gemini, Mistral AI, and OpenAI
// API keys stored in localStorage: 'geminiApiKey', 'mistralApiKey', 'openaiApiKey'
// ========================================

const AGENT_MODEL_DEFAULT = 'gemini-3-flash-preview';
const MAX_TOOL_ROUNDS     = 1000;

// ----------------------------------------
// Session state  (reset on agentClear)
// ----------------------------------------
let geminiHistory    = []; // [{role:'user'|'model', parts:[...]}]
let mistralHistory   = []; // [{role:'user'|'assistant'|'tool', content, tool_calls?}]
let openaiHistory    = []; // [{role:'user'|'assistant'|'tool', content, tool_calls?}]
let agentStreaming        = false;
let fetchedResourceTypes  = new Set();
let activePlaceholder     = null;
let activeAbortController = null;

// ----------------------------------------
// Provider / model helpers
// ----------------------------------------
function getAgentModel() {
    return localStorage.getItem('agentModel') || AGENT_MODEL_DEFAULT;
}

function getProvider() {
    const m = getAgentModel();
    if (m.startsWith('mistral') || m.startsWith('open-mistral') || m.startsWith('codestral'))
        return 'mistral';
    if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4'))
        return 'openai';
    return 'google';
}

function getActiveApiKey() {
    const p = getProvider();
    if (p === 'mistral') return localStorage.getItem('mistralApiKey') || '';
    if (p === 'openai')  return localStorage.getItem('openaiApiKey')  || '';
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

// Gemini format
const GEMINI_TOOLS = [{
    functionDeclarations: [
        { name: 'get_available_resources', description: TOOL_DESCRIPTION,         parameters: TOOL_PARAMETERS           },
        { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION, parameters: SET_RESOURCES_PARAMETERS   },
        { name: 'set_board',               description: SET_BOARD_DESCRIPTION,     parameters: SET_BOARD_PARAMETERS       },
        { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,   parameters: EMPTY_PARAMETERS           },
        { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,   parameters: BLEND_TOOL_PARAMETERS     },
        { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,   parameters: STATS_TOOL_PARAMETERS     }
    ]
}];

// Mistral / OpenAI format
const MISTRAL_TOOLS = [
    { type: 'function', function: { name: 'get_available_resources', description: TOOL_DESCRIPTION,         parameters: TOOL_PARAMETERS           } },
    { type: 'function', function: { name: 'set_resources',           description: SET_RESOURCES_DESCRIPTION, parameters: SET_RESOURCES_PARAMETERS   } },
    { type: 'function', function: { name: 'set_board',               description: SET_BOARD_DESCRIPTION,     parameters: SET_BOARD_PARAMETERS       } },
    { type: 'function', function: { name: 'clear_blend',             description: CLEAR_BLEND_DESCRIPTION,   parameters: EMPTY_PARAMETERS           } },
    { type: 'function', function: { name: 'get_blend',               description: BLEND_TOOL_DESCRIPTION,   parameters: BLEND_TOOL_PARAMETERS     } },
    { type: 'function', function: { name: 'get_blend_statistics',    description: STATS_TOOL_DESCRIPTION,   parameters: STATS_TOOL_PARAMETERS     } }
];

const VALID_RESOURCE_TYPES = new Set([
    'imperium', 'intrigue', 'tleilax', 'reserve', 'tech',
    'contracts', 'leader', 'sardaukar', 'starter', 'conflict'
]);

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
        // Each raw item with a distinct resource_id is a separate physical card, not a duplicate copy.
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
        // Cards with count/count_per_player > 1 get N× prefix.
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

        // Main board: Uprising board if Uprising is in the blend, otherwise base Imperium board
        const uprisingRadio  = document.getElementById('board-uprising');
        const imperiumRadio  = document.getElementById('board-imperium');
        if (uprisingRadio && imperiumRadio) {
            uprisingRadio.checked = has('uprising');
            imperiumRadio.checked = !has('uprising');
        }

        // Additional boards per expansion
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
        set('board-choam',    has('ix'));           // Rise of Ix
        set('board-ix',       has('ix'));           // Rise of Ix
        set('board-tleilax',  has('immortality'));  // Immortality
        set('board-research', has('immortality'));  // Immortality
        set('board-embassy',  has('bloodlines'));   // Bloodlines

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

        // Find matching resources sorted by resource_id (same order as get_available_resources output).
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

## Fixed Rules (apply unless the user explicitly overrides)
- **Starter total = 10 physical cards.** The base starter deck is: 2× Convincing Argument, 2× Dagger, 1× Diplomacy, 1× Dune The Desert Planet, 1× Reconnaissance, 1× Seek Allies, 2× Signet Ring = 10. Always verify the total equals 10.
- **Immortality modifier:** If Immortality is included in the blend, replace 2× "Dune, The Desert Planet" with 2× "Experimentation" in the starter deck (net total stays 10).
- **Reserve Cards from one set only.** Never mix reserve cards from multiple sets. Pick the full reserve from a single expansion matching the blend's base set.
- **"Control the Spice" (Rise of Ix)** is included only when the user explicitly requests "Epic" game mode. Do not add it otherwise.

## Your Capabilities
1. Answer questions about Dune: Imperium rules, strategy, and blend building.
2. Use get_available_resources before calling set_resources for any type.
   Use get_blend_statistics for percentages — never calculate them yourself.
3. Use get_blend to read saved blends (list first, then open by exact filename).
   Each line in a blend file: \`[N×] Resource Name (Expansion)\` — N× means N copies.`;
}

// ----------------------------------------
// Streaming helpers
// ----------------------------------------

// Yields parsed JSON objects from an SSE stream (Mistral / OpenAI / Gemini ?alt=sse format)
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

// Stream an OpenAI-compatible SSE response; calls onChunk(text, type) per fragment.
// Returns the assembled message object when done.
async function streamOpenAICompat(resp, onChunk) {
    const tcMap  = {}; // index → assembled tool call
    let content  = '';
    for await (const chunk of readSSE(resp)) {
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
    return { role: 'assistant', content: content || null, ...(tool_calls.length && { tool_calls }) };
}

// Stream a Gemini SSE response (?alt=sse); calls onChunk(text, type) per fragment.
// Returns the assembled parts array when done.
async function streamGeminiSSE(resp, onChunk) {
    const allParts = [];
    for await (const chunk of readSSE(resp)) {
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            allParts.push(part);
            if (part.text) onChunk(part.text, part.thought ? 'thinking' : 'output');
        }
    }
    return allParts;
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

async function runGeminiLoop(apiKey, placeholder, onStatus) {
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        onStatus('thinking');
        const lastEntry = geminiHistory[geminiHistory.length - 1];
        placeholder.setPromptContent(JSON.stringify(lastEntry, null, 2));

        const parts = await callGemini(apiKey, (chunk, type) => placeholder.appendStepContent(chunk, type));
        geminiHistory.push({ role: 'model', parts });

        const funcCallParts = parts.filter(p => p.functionCall);

        if (funcCallParts.length === 0) {
            const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
            return { text, actionsCount: totalActionsCount };
        }

        placeholder.setStepContent(JSON.stringify(
            funcCallParts.map(p => ({ tool: p.functionCall.name, args: p.functionCall.args })), null, 2));

        const sig = JSON.stringify(funcCallParts.map(p => p.functionCall));
        if (sig === lastToolSig) { if (++loopCount >= 3) return { text: '*(loop detected)*', actionsCount: totalActionsCount }; }
        else { lastToolSig = sig; loopCount = 0; }

        const funcResponses = [];
        for (const part of funcCallParts) {
            const { name, args } = part.functionCall;
            onStatus(name === 'set_resources' ? `set:${args.resource_type}` : name === 'set_board' ? 'set_board' : (args.resource_type || args.filename || name));
            placeholder.setPromptContent(JSON.stringify({ tool: name, args }, null, 2));
            const result = await executeToolAsync(name, args);
            placeholder.setStepContent(JSON.stringify(result, null, 2));
            if (name === 'set_resources') totalActionsCount += result.applied || 0;
            if (name === 'clear_blend' || name === 'set_board') totalActionsCount += 1;
            funcResponses.push({ functionResponse: { name, response: result } });
        }
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
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || err.error?.message || `HTTP ${resp.status}`);
    }
    return streamOpenAICompat(resp, onChunk);
}

async function runMistralLoop(apiKey, placeholder, onStatus) {
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        onStatus('thinking');
        const lastEntry = mistralHistory[mistralHistory.length - 1];
        placeholder.setPromptContent(typeof lastEntry?.content === 'string'
            ? lastEntry.content : JSON.stringify(lastEntry, null, 2));

        const message = await callMistral(apiKey, (chunk, type) => placeholder.appendStepContent(chunk, type));
        if (!message) throw new Error('No response from Mistral');

        mistralHistory.push(message);
        const toolCalls = message.tool_calls || [];

        if (toolCalls.length === 0) {
            const raw  = message.content;
            const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(p => p.text || '').join('') : String(raw ?? '');
            return { text, actionsCount: totalActionsCount };
        }

        placeholder.setStepContent(JSON.stringify(
            toolCalls.map(tc => ({ tool: tc.function.name, args: JSON.parse(tc.function.arguments) })), null, 2));

        const sig = JSON.stringify(toolCalls.map(tc => ({ n: tc.function.name, a: tc.function.arguments })));
        if (sig === lastToolSig) { if (++loopCount >= 3) return { text: '*(loop detected)*', actionsCount: totalActionsCount }; }
        else { lastToolSig = sig; loopCount = 0; }

        for (const tc of toolCalls) {
            const name = tc.function.name;
            const args = JSON.parse(tc.function.arguments);
            onStatus(name === 'set_resources' ? `set:${args.resource_type}` : name === 'set_board' ? 'set_board' : (args.resource_type || args.filename || name));
            placeholder.setPromptContent(JSON.stringify({ tool: name, args }, null, 2));
            const result = await executeToolAsync(name, args);
            placeholder.setStepContent(JSON.stringify(result, null, 2));
            if (name === 'set_resources') totalActionsCount += result.applied || 0;
            if (name === 'clear_blend' || name === 'set_board') totalActionsCount += 1;
            mistralHistory.push({ role: 'tool', tool_call_id: tc.id, name, content: JSON.stringify(result) });
        }
    }
    return { text: '*(max tool rounds reached)*', actionsCount: totalActionsCount };
}

// ----------------------------------------
// OpenAI API
// ----------------------------------------
async function callOpenAI(apiKey, onChunk) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal:  activeAbortController?.signal,
        body: JSON.stringify({
            model:       getAgentModel(),
            messages:    [{ role: 'system', content: buildSystemPrompt() }, ...openaiHistory],
            tools:       MISTRAL_TOOLS,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens:  32768,
            stream:      true
        })
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || err.error?.message || `HTTP ${resp.status}`);
    }
    return streamOpenAICompat(resp, onChunk);
}

async function runOpenAILoop(apiKey, placeholder, onStatus) {
    let lastToolSig = null; let loopCount = 0; let totalActionsCount = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        onStatus('thinking');
        const lastEntry = openaiHistory[openaiHistory.length - 1];
        placeholder.setPromptContent(typeof lastEntry?.content === 'string'
            ? lastEntry.content : JSON.stringify(lastEntry, null, 2));

        const message = await callOpenAI(apiKey, (chunk, type) => placeholder.appendStepContent(chunk, type));
        if (!message) throw new Error('No response from OpenAI');

        openaiHistory.push(message);
        const toolCalls = message.tool_calls || [];

        if (toolCalls.length === 0) {
            const raw  = message.content;
            const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(p => p.text || '').join('') : String(raw ?? '');
            return { text, actionsCount: totalActionsCount };
        }

        placeholder.setStepContent(JSON.stringify(
            toolCalls.map(tc => ({ tool: tc.function.name, args: JSON.parse(tc.function.arguments) })), null, 2));

        const sig = JSON.stringify(toolCalls.map(tc => ({ n: tc.function.name, a: tc.function.arguments })));
        if (sig === lastToolSig) { if (++loopCount >= 3) return { text: '*(loop detected)*', actionsCount: totalActionsCount }; }
        else { lastToolSig = sig; loopCount = 0; }

        for (const tc of toolCalls) {
            const name = tc.function.name;
            const args = JSON.parse(tc.function.arguments);
            onStatus(name === 'set_resources' ? `set:${args.resource_type}` : name === 'set_board' ? 'set_board' : (args.resource_type || args.filename || name));
            placeholder.setPromptContent(JSON.stringify({ tool: name, args }, null, 2));
            const result = await executeToolAsync(name, args);
            placeholder.setStepContent(JSON.stringify(result, null, 2));
            if (name === 'set_resources') totalActionsCount += result.applied || 0;
            if (name === 'clear_blend' || name === 'set_board') totalActionsCount += 1;
            openaiHistory.push({ role: 'tool', tool_call_id: tc.id, name, content: JSON.stringify(result) });
        }
    }
    return { text: '*(max tool rounds reached)*', actionsCount: totalActionsCount };
}

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

function createResponsePlaceholder() {
    const msgs   = getMessagesEl();
    const div    = document.createElement('div');
    div.className = 'agent-msg agent-msg-model';

    const bubble = document.createElement('div');
    bubble.className = 'agent-msg-bubble';
    div.appendChild(bubble);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;

    let stepEl      = null;
    let promptBox   = null;
    let thinkingBox = null;
    let outputBox   = null;
    let timerHandle = null;
    let stepStart   = null;
    let thinkingBtn = null;

    function makeSubBox(label, open) {
        const wrap = document.createElement('div');
        wrap.className = 'step-sub-box';

        const labelRow = document.createElement('div');
        labelRow.className = 'step-sub-label';

        const btn = document.createElement('button');
        btn.className = 'step-toggle';
        btn.textContent = open ? '▼' : '▶';

        const nameEl = document.createElement('span');
        nameEl.className = 'step-sub-name';
        nameEl.textContent = label;

        labelRow.appendChild(btn);
        labelRow.appendChild(nameEl);

        const detail = document.createElement('div');
        detail.className = 'step-detail' + (open ? ' step-detail-open' : '');

        const pre = document.createElement('pre');
        pre.className = 'step-content-pre';
        detail.appendChild(pre);

        btn.addEventListener('click', () => {
            const isOpen = detail.classList.toggle('step-detail-open');
            btn.textContent = isOpen ? '▼' : '▶';
        });

        wrap.appendChild(labelRow);
        wrap.appendChild(detail);
        return { wrap, detail, btn, pre };
    }

    function stopCurrentStep() {
        if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
        if (stepEl) {
            const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
            stepEl.querySelector('.step-timer').textContent = `${elapsed}s`;
            stepEl.querySelector('.agent-cursor')?.remove();
        }
    }

    function closeCurrentDetail() {
        if (!stepEl) return;
        stepEl.querySelectorAll('.step-detail-open').forEach(el => el.classList.remove('step-detail-open'));
        stepEl.querySelectorAll('.step-toggle').forEach(btn => { btn.textContent = '▶'; });
    }

    function addStep(label) {
        stopCurrentStep();
        closeCurrentDetail();
        stepStart = Date.now();

        stepEl = document.createElement('div');
        stepEl.className = 'agent-step';

        const header = document.createElement('div');
        header.className = 'step-header';
        header.insertAdjacentHTML('beforeend',
            `<em class="text-muted">${escapeHtml(label)}</em> ` +
            `<span class="step-timer text-muted">0.0s</span>` +
            `<span class="agent-cursor">&#9607;</span>`);

        const p = makeSubBox('Prompt',   true);
        const t = makeSubBox('Thinking', false);
        const o = makeSubBox('Output',   true);

        promptBox   = p.detail;
        thinkingBox = t.detail;
        thinkingBtn = t.btn;
        outputBox   = o.detail;

        stepEl.appendChild(header);
        stepEl.appendChild(p.wrap);
        stepEl.appendChild(t.wrap);
        stepEl.appendChild(o.wrap);
        bubble.appendChild(stepEl);
        msgs.scrollTop = msgs.scrollHeight;

        timerHandle = setInterval(() => {
            const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
            stepEl.querySelector('.step-timer').textContent = `${elapsed}s`;
        }, 100);
    }

    function setPromptContent(text) {
        if (!promptBox) return;
        promptBox.querySelector('.step-content-pre').textContent = text;
        msgs.scrollTop = msgs.scrollHeight;
    }

    function setStepContent(text, type = 'output') {
        const box = type === 'thinking' ? thinkingBox : outputBox;
        if (!box) return;
        box.querySelector('.step-content-pre').textContent = text;
        msgs.scrollTop = msgs.scrollHeight;
    }

    function appendStepContent(text, type = 'output') {
        const box = type === 'thinking' ? thinkingBox : outputBox;
        if (!box) return;
        if (type === 'thinking' && !box.classList.contains('step-detail-open')) {
            box.classList.add('step-detail-open');
            if (thinkingBtn) thinkingBtn.textContent = '▼';
        }
        const pre = box.querySelector('.step-content-pre');
        pre.textContent += text;
        pre.scrollTop = pre.scrollHeight;
        msgs.scrollTop = msgs.scrollHeight;
    }

    function finalize(fullText, actionsCount) {
        stopCurrentStep();
        closeCurrentDetail();
        const safeText = typeof fullText === 'string' ? fullText : String(fullText ?? '');
        const cleaned = cleanResponse(safeText);
        if (cleaned) {
            const responseEl = document.createElement('div');
            responseEl.className = 'agent-response-text';
            responseEl.innerHTML = renderMarkdown(cleaned);
            bubble.appendChild(responseEl);
        }
        if (actionsCount > 0) div.appendChild(actionsNote(actionsCount));
        msgs.scrollTop = msgs.scrollHeight;
    }

    return { div, addStep, setPromptContent, setStepContent, appendStepContent, finalize };
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
    if (provider === 'mistral') {
        mistralHistory.push({ role: 'user', content: text });
    } else if (provider === 'openai') {
        openaiHistory.push({ role: 'user', content: text });
    } else {
        geminiHistory.push({ role: 'user', parts: [{ text }] });
    }

    activePlaceholder     = createResponsePlaceholder();
    activeAbortController = new AbortController();
    const placeholder     = activePlaceholder;

    try {
        const onStatus = label => {
            const msg =
                label === 'thinking'             ? 'Thinking…' :
                label === 'clear_blend'          ? 'Clearing blend…' :
                label === 'set_board'            ? 'Setting board…' :
                label === 'get_blend'            ? 'Reading blend list…' :
                label === 'get_blend_statistics' ? 'Reading blend statistics…' :
                label.startsWith('set:')         ? `Setting ${label.slice(4)} resources…` :
                label.endsWith('.md')            ? `Reading ${label}…` :
                                                   `Fetching ${label} resources…`;
            placeholder.addStep(msg);
        };
        const { text: finalText, actionsCount } =
            provider === 'mistral' ? await runMistralLoop(apiKey, placeholder, onStatus) :
            provider === 'openai'  ? await runOpenAILoop(apiKey, placeholder, onStatus)  :
                                     await runGeminiLoop(apiKey, placeholder, onStatus);
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
    openaiHistory    = [];
    fetchedResourceTypes = new Set();
    const msgs = getMessagesEl();
    if (msgs) msgs.innerHTML = '';
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
