"""
Dune Imperium Blend Builder - Web Version
Flask backend serving card data and blend management
"""

from flask import Flask, render_template, jsonify, request
from pathlib import Path
import openpyxl
import webbrowser
import threading

app = Flask(__name__)

# Global card data
ALL_CARDS = []


def load_cards_from_excel():
    """Load card data from Excel file."""
    excel_path = Path(__file__).parent / "Dune_Imperium_Card_Inventory.xlsx"

    if not excel_path.exists():
        raise FileNotFoundError(
            f"Could not find: {excel_path}\n\n"
            "Please ensure Dune_Imperium_Card_Inventory.xlsx is in the project directory."
        )

    wb = openpyxl.load_workbook(excel_path, data_only=True)  # data_only=True evaluates formulas
    ws = wb.active
    headers = [cell.value for cell in ws[1]]

    cards = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row[0]:
            continue

        row_dict = dict(zip(headers, row))
        card_name = str(row_dict.get("Card Name", "")).strip()
        if not card_name:
            continue

        source = str(row_dict.get("Source", "Base")).strip()
        card_set_mapping = {
            "Base": "base",
            "Ix": "ix",
            "Immortality": "immortality",
            "Uprising": "uprising",
            "Bloodlines": "bloodlines"
        }
        card_set = card_set_mapping.get(source, source.lower())

        def has_x(val):
            return val and str(val).strip().upper() == 'X'

        card = {
            "name": card_name,
            "card_set": card_set,
            "source": source,
            "count": int(float(row_dict.get("Count") or 1)),
            "cost": str(row_dict.get("Persuasion Cost") or "0"),
            "agent_ability": row_dict.get("Agent Ability") or "",
            "acquisition_bonus": row_dict.get("Acquisition Bonus") or "",
            "reveal_persuasion": str(row_dict.get("Reveal Persuasion") or "0"),
            "reveal_swords": str(row_dict.get("Reveal Swords") or "0"),
            "reveal_ability": row_dict.get("Reveal Ability") or "",
            "passive_ability": row_dict.get("Passive Ability") or "",
            "tech": row_dict.get("Tech") or "",
            "shipping": row_dict.get("Shipping") or "",
            "unload": row_dict.get("Unload") or "",
            "infiltration": row_dict.get("Infiltration") or "",
            "research": row_dict.get("Research") or "",
            "grafting": row_dict.get("Grafting") or "",
            "spies": row_dict.get("Spies") or "",
            "sandworms": row_dict.get("Sandworms") or "",
            "contracts": row_dict.get("Contracts") or "",
            "battle_icons": row_dict.get("Battle Icons") or "",
            "sardaukar": row_dict.get("Sardaukar") or "",
            "compatibility": str(row_dict.get("Compatibility", "All") or "All"),
            "vps_available": str(row_dict.get("VPs Available") or "0"),
            "green_access": has_x(row_dict.get("Green Access")),
            "purple_access": has_x(row_dict.get("Purple Access")),
            "yellow_access": has_x(row_dict.get("Yellow Access")),
            "emperor_access": has_x(row_dict.get("Emperor Access")),
            "spacing_guild_access": has_x(row_dict.get("Spacing Guild Access")),
            "bene_gesserit_access": has_x(row_dict.get("Bene Gesserit Access")),
            "fremen_access": has_x(row_dict.get("Fremen Access")),
            "spy_access": has_x(row_dict.get("Spy Access")),
        }
        cards.append(card)

    print(f"Loaded {len(cards)} cards")
    return cards


@app.route('/')
def index():
    """Serve the main page."""
    return render_template('index.html')


@app.route('/api/cards')
def get_cards():
    """Return all cards as JSON."""
    return jsonify(ALL_CARDS)


@app.route('/api/deck/save', methods=['POST'])
def save_deck():
    """Save blend to markdown file in blends folder."""
    data = request.json
    deck_name = data.get('name', 'Untitled Blend')
    cards = data.get('cards', [])

    # Create blends folder if it doesn't exist
    blends_dir = Path(__file__).parent / 'blends'
    blends_dir.mkdir(exist_ok=True)

    # Categorize cards by type
    imperium_cards = []
    intrigue_cards = []

    for card in cards:
        # For now, assume all are Imperium cards (can be extended later)
        imperium_cards.append(card)

    # Build markdown with sections
    md = f"# {deck_name}\n\n"
    md += f"**Total Cards:** {len(cards)}\n\n"

    # Imperium Cards section
    if imperium_cards:
        md += "## Imperium Cards\n\n"

        by_set = {}
        for card in imperium_cards:
            card_set = card.get('source', card.get('card_set', 'Unknown'))
            if card_set not in by_set:
                by_set[card_set] = []
            by_set[card_set].append(card)

        for card_set in sorted(by_set.keys()):
            set_cards = by_set[card_set]
            md += f"### {card_set}\n\n"
            for card in set_cards:
                md += f"- **{card['name']}** (Cost: {card.get('cost', '?')})\n"
            md += "\n"

    # Intrigue Cards section (placeholder for future use)
    if intrigue_cards:
        md += "## Intrigue Cards\n\n"
        for card in intrigue_cards:
            md += f"- **{card['name']}**\n"
        md += "\n"

    md += "---\n*Generated by Dune Imperium Blend Builder*\n"

    filename = f"{deck_name}.md".replace(' ', '_').replace('/', '_')
    filepath = blends_dir / filename

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(md)

    return jsonify({"success": True, "filepath": str(filepath), "filename": filename})


@app.route('/api/blends')
def list_blends():
    """List all available blend files."""
    blends_dir = Path(__file__).parent / 'blends'
    blends_dir.mkdir(exist_ok=True)

    blend_files = []
    for filepath in blends_dir.glob('*.md'):
        blend_files.append({
            'name': filepath.stem.replace('_', ' '),
            'filename': filepath.name
        })

    return jsonify(blend_files)


@app.route('/api/blend/load/<filename>')
def load_blend(filename):
    """Load a blend file and return the card names."""
    blends_dir = Path(__file__).parent / 'blends'
    filepath = blends_dir / filename

    if not filepath.exists():
        return jsonify({"success": False, "error": "Blend file not found"}), 404

    # Parse the markdown file to extract card names
    card_names = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            # Look for lines with card format: - **Card Name** (Cost: X)
            if line.strip().startswith('- **'):
                # Extract card name between ** **
                start = line.find('**') + 2
                end = line.find('**', start)
                if end > start:
                    card_name = line[start:end]
                    card_names.append(card_name)

    return jsonify({"success": True, "card_names": card_names})


def open_browser():
    """Open browser after short delay."""
    webbrowser.open('http://localhost:5000')


if __name__ == '__main__':
    ALL_CARDS = load_cards_from_excel()
    threading.Timer(1.5, open_browser).start()
    app.run(debug=False, port=5000)

