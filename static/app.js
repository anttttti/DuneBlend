/**
 * Client-side API for loading resources and blends
 * Replaces Flask backend with direct JSON file loading
 * Supports both local (file upload/download) and server (save/load) modes
 */

// Server capabilities (detected on load)
let serverFeatures = {
    canSaveToServer: false,
    canLoadFromServer: true,  // Always true (can fetch static files)
    serverType: 'static'  // 'local' or 'static'
};

// Detect server capabilities
async function detectServerFeatures() {
    try {
        const response = await fetch('/api/server-features');
        if (response.ok) {
            serverFeatures = await response.json();
            console.log('✅ Server features detected:', serverFeatures);
        } else {
            // Static hosting (GitHub Pages, etc.)
            serverFeatures = {
                canSaveToServer: false,
                canLoadFromServer: true,
                serverType: 'static'
            };
            console.log('📦 Static hosting mode (no server writes)');
        }
    } catch (error) {
        // Static hosting - API endpoint doesn't exist
        serverFeatures = {
            canSaveToServer: false,
            canLoadFromServer: true,
            serverType: 'static'
        };
        console.log('📦 Static hosting mode (no server writes)');
    }

    return serverFeatures;
}

// Load resources from JSON file
async function loadResources() {
    try {
        const response = await fetch('resources.json');
        if (!response.ok) {
            throw new Error('Failed to load resources.json');
        }
        return await response.json();
    } catch (error) {
        console.error('Error loading resources:', error);
        alert('Failed to load resources. Make sure resources.json exists.\nRun: python3 generate_resources_json.py');
        return {};
    }
}

// List available blend files
async function listBlends() {
    try {
        // Try API endpoint first (for local server mode)
        const response = await fetch('/api/blends');
        if (response.ok) {
            return await response.json();
        }

        // Fallback to index.json for static hosting
        const indexResponse = await fetch('blends/index.json');
        if (indexResponse.ok) {
            return await indexResponse.json();
        }

        return [];
    } catch (error) {
        console.error('Error listing blends:', error);
        return [];
    }
}

// Load a specific blend file
async function loadBlend(filename) {
    try {
        const response = await fetch(`blends/${filename}`);
        if (!response.ok) {
            throw new Error(`Failed to load blend: ${filename}`);
        }
        const text = await response.text();
        return parseBlendFile(text);
    } catch (error) {
        console.error('Error loading blend:', error);
        throw error;
    }
}

// Parse blend markdown file into structured data
function parseBlendFile(content) {
    const resources_by_type = {};
    let current_section = null;

    const lines = content.split('\n');
    for (let line of lines) {
        line = line.trim();

        // Check for main sections (## Resource Type)
        if (line.startsWith('## ')) {
            current_section = line.substring(3).trim();
            if (!(current_section in resources_by_type)) {
                if (current_section === 'Board') {
                    resources_by_type[current_section] = {
                        mainBoard: 'imperium',
                        additionalBoards: []
                    };
                } else {
                    resources_by_type[current_section] = [];
                }
            }
        }
        // Parse Board metadata
        else if (current_section === 'Board' && line.startsWith('- ')) {
            const clean_line = line.substring(2).trim();
            if (clean_line.startsWith('Main Board:')) {
                const main_board = clean_line.split(':', 2)[1].trim();
                resources_by_type['Board'].mainBoard = main_board;
            } else if (clean_line.startsWith('Additional Boards:')) {
                const boards_str = clean_line.split(':', 2)[1].trim();
                const additional = boards_str.split(',').map(b => b.trim());
                resources_by_type['Board'].additionalBoards = additional;
            }
        }
        // Check for resource lines
        else if (current_section && current_section !== 'Board' && line &&
                 !line.startsWith('**') && !line.startsWith('*Generated')) {
            let clean_line = line;
            if (clean_line.startsWith('- ')) {
                clean_line = clean_line.substring(2).trim();
            }

            if (!clean_line || clean_line.startsWith('#')) {
                continue;
            }

            // Parse "count× name" or "count name" or just "name" format
            if (clean_line.includes('×')) {
                const parts = clean_line.split('×', 2);
                if (parts.length === 2 && /^\d+$/.test(parts[0].trim())) {
                    const count = parseInt(parts[0].trim());
                    const name = parts[1].trim();
                    resources_by_type[current_section].push({name: name, count: count});
                } else {
                    resources_by_type[current_section].push({name: clean_line, count: 1});
                }
            } else if (clean_line.length > 0 && /^\d/.test(clean_line[0]) && clean_line.includes(' ')) {
                const parts = clean_line.split(' ', 2);
                if (/^\d+$/.test(parts[0])) {
                    const count = parseInt(parts[0]);
                    const name = parts[1].trim();
                    resources_by_type[current_section].push({name: name, count: count});
                } else {
                    resources_by_type[current_section].push({name: clean_line, count: 1});
                }
            } else {
                resources_by_type[current_section].push({name: clean_line, count: 1});
            }
        }
    }

    return {success: true, resources: resources_by_type};
}

// Save blend - download as file since we can't write to server
function saveBlend(blendName, resourcesByType) {
    // Build markdown
    let md = `# ${blendName}\n\n`;

    // Handle Board section first if present
    if ('Board' in resourcesByType) {
        const board_data = resourcesByType['Board'];
        md += `## Board\n\n`;
        md += `- Main Board: ${board_data.mainBoard || 'imperium'}\n`;
        const additional = board_data.additionalBoards || [];
        if (additional.length > 0) {
            md += `- Additional Boards: ${additional.join(', ')}\n`;
        }
        md += '\n';
    }

    // Count total items
    let total_count = 0;
    for (const [key, items] of Object.entries(resourcesByType)) {
        if (key !== 'Board' && Array.isArray(items)) {
            total_count += items.length;
        }
    }
    if (total_count > 0) {
        md += `**Total Items:** ${total_count}\n\n`;
    }

    // Add each resource type section
    for (const [resource_type, items] of Object.entries(resourcesByType)) {
        if (resource_type === 'Board') continue;
        if (!items || items.length === 0) continue;

        md += `## ${resource_type}\n\n`;

        // Count occurrences
        const item_counts = {};
        for (const item of items) {
            const item_name = item.displayName || item.objective || item.name || 'Unknown';
            const item_source = item.source || 'Unknown';
            const synonym_id = item.synonymId;

            let item_key;
            if (item_name.includes(`(${item_source})`)) {
                item_key = item_name;
            } else {
                item_key = `${item_name} (${item_source})`;
            }

            if (synonym_id) {
                item_key = `${item_name} #${synonym_id} (${item_source})`;
            }

            if (!(item_key in item_counts)) {
                item_counts[item_key] = 0;
            }
            item_counts[item_key] += 1;
        }

        // Sort and output
        const sorted_keys = Object.keys(item_counts).sort();
        for (const item_key of sorted_keys) {
            const count = item_counts[item_key];
            if (count === 1) {
                md += `- ${item_key}\n`;
            } else {
                md += `- ${count}× ${item_key}\n`;
            }
        }

        md += '\n';
    }

    md += '---\n*Generated by Dune Imperium Blend Builder*\n';

    // Check if we can save to server
    if (serverFeatures.canSaveToServer) {
        return saveBlendToServer(blendName, md);
    } else {
        return saveBlendAsDownload(blendName, md);
    }
}

// Save blend to server (local development only)
async function saveBlendToServer(blendName, content) {
    const filename = `${blendName.replace(/ /g, '_').replace(/\//g, '_')}.md`;

    try {
        const response = await fetch('/api/blend/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: filename,
                content: content
            })
        });

        const result = await response.json();

        if (result.success) {
            console.log(`✅ Saved to server: ${result.filename}`);
            return {
                success: true,
                filename: result.filename,
                location: 'server'
            };
        } else {
            console.error('Server save failed:', result.error);
            // Fallback to download
            return saveBlendAsDownload(blendName, content);
        }
    } catch (error) {
        console.error('Server save error:', error);
        // Fallback to download
        return saveBlendAsDownload(blendName, content);
    }
}

// Save blend as download (works everywhere)
function saveBlendAsDownload(blendName, content) {
    const filename = `${blendName.replace(/ /g, '_').replace(/\//g, '_')}.md`;
    const blob = new Blob([content], {type: 'text/markdown'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    return {
        success: true,
        filename: filename,
        location: 'download'
    };
}

