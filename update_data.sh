#!/bin/bash
# Update all data files after Excel spreadsheet changes

set -e  # Exit on error

echo "🔄 Updating Dune Imperium Blend Builder data..."
echo ""

# Check if Excel file exists
if [ ! -f "Dune_Imperium_Card_Inventory.xlsx" ]; then
    echo "❌ Error: Dune_Imperium_Card_Inventory.xlsx not found!"
    exit 1
fi

# 1. Generate resources.json
echo "📊 Generating resources.json from Excel..."
python3 generate_resources_json.py
echo ""

# 2. Regenerate blend files
echo "📝 Regenerating blend files..."
python3 extract_blends_from_excel_inventory.py
echo ""

# 3. Update blends index
echo "📋 Updating blends/index.json..."
python3 << 'EOF'
import json
from pathlib import Path

blends_dir = Path('blends')
blend_files = [{'filename': f.name} for f in sorted(blends_dir.glob('*.md'))]

with open(blends_dir / 'index.json', 'w') as f:
    json.dump(blend_files, f, indent=2)

print(f"✅ Updated index with {len(blend_files)} blends")
EOF
echo ""

echo "✅ All data updated successfully!"
echo ""
echo "📦 Files generated:"
echo "   - resources.json"
echo "   - blends/*.md"
echo "   - blends/index.json"
echo ""
echo "🚀 Ready to deploy!"
echo ""
echo "💡 Server Features:"
echo "   - Run locally: Enables blend upload/save to server"
echo "   - Run on GitHub Pages: File upload/download only"

