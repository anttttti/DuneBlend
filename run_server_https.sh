#!/bin/bash

echo "🚀 Starting Dune Imperium Blend Builder with HTTPS..."
echo ""
echo "Server features:"
echo "  ✅ Static file serving"
echo "  ✅ Blend file upload to server"
echo "  ✅ Blend file save to server"
echo "  ✅ Blend list API"
echo "  ✅ HTTPS enabled (for camera access)"
echo ""
echo "This server enables HTTPS for camera access on mobile devices."
echo ""

# Check if certificates exist
if [ ! -f "cert.pem" ] || [ ! -f "key.pem" ]; then
    echo "📜 SSL certificates not found. Generating self-signed certificates..."
    echo ""

    # Get local IP address
    LOCAL_IP=$(hostname -I | awk '{print $1}')

    # Generate self-signed certificate
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout key.pem -out cert.pem -days 365 \
        -subj "/CN=${LOCAL_IP}" \
        2>/dev/null

    if [ $? -eq 0 ]; then
        echo "✅ Certificates generated successfully"
        echo "   - cert.pem (certificate)"
        echo "   - key.pem (private key)"
        echo ""
        echo "⚠️  SECURITY WARNING:"
        echo "   These are self-signed certificates."
        echo "   Your browser will show a security warning."
        echo "   You'll need to accept it to proceed."
        echo ""
    else
        echo "❌ Failed to generate certificates"
        echo "   Make sure openssl is installed: sudo apt install openssl"
        exit 1
    fi
fi

# Get local IP for display
LOCAL_IP=$(hostname -I | awk '{print $1}')

# Check if port 5000 is in use
if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "🔍 Checking port 5000..."
    echo "⚠️  Port 5000 is in use. Stopping existing server..."
    pkill -f "python.*server_https.py" 2>/dev/null
    sleep 1
    echo "✅ Port 5000 cleared"
fi

echo "🚀 Starting HTTPS server..."
echo ""

# Run the HTTPS server
python3 server_https.py


