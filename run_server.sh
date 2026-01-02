#!/bin/bash
# Run the Dune Imperium Blend Builder with file upload/save support

cd "$(dirname "$0")"

echo "🚀 Starting Dune Imperium Blend Builder..."
echo ""
echo "Server features:"
echo "  ✅ Static file serving"
echo "  ✅ Blend file upload to server"
echo "  ✅ Blend file save to server"
echo "  ✅ Blend file list API"
echo ""
echo "This server enables full file management features."
echo "When deployed to GitHub Pages, only download/upload works."
echo ""

# Check and kill any existing servers on port 5000
echo "🔍 Checking port 5000..."
if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 5000 is in use. Stopping existing server..."
    lsof -ti:5000 | xargs kill -9 2>/dev/null
    sleep 2
    echo "✅ Port 5000 cleared"
fi

# Start server
echo "🚀 Starting server..."
python3 server.py

