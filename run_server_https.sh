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

# Get local IP address
LOCAL_IP=$(hostname -I | awk '{print $1}')

# Check if certificates exist or regenerate if IP changed
REGEN_CERTS=false
if [ ! -f "cert.pem" ] || [ ! -f "key.pem" ]; then
    REGEN_CERTS=true
    echo "📜 SSL certificates not found. Generating..."
else
    # Check if certificate matches current IP
    CERT_CN=$(openssl x509 -in cert.pem -noout -subject 2>/dev/null | grep -oP 'CN\s*=\s*\K[^,/]+' || echo "")
    if [ "$CERT_CN" != "$LOCAL_IP" ] && [ "$CERT_CN" != "localhost" ]; then
        echo "📜 IP address changed ($CERT_CN -> $LOCAL_IP). Regenerating certificates..."
        REGEN_CERTS=true
    fi
fi

if [ "$REGEN_CERTS" = true ]; then
    echo ""

    # Create a temporary openssl config for SAN support
    cat > /tmp/openssl_san.cnf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${LOCAL_IP}

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment

[alt_names]
IP.1 = ${LOCAL_IP}
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

    # Generate self-signed certificate with SAN
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout key.pem -out cert.pem -days 365 \
        -config /tmp/openssl_san.cnf \
        2>/dev/null

    rm -f /tmp/openssl_san.cnf

    if [ $? -eq 0 ]; then
        echo "✅ Certificates generated successfully"
        echo "   - cert.pem (certificate)"
        echo "   - key.pem (private key)"
        echo "   - Valid for: ${LOCAL_IP}, 127.0.0.1, localhost"
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


