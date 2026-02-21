#!/bin/bash

echo "🚀 Starting Dune Imperium Blend Builder..."
echo ""
echo "This starts both HTTP and HTTPS servers:"
echo "  • HTTP  on port 5000 (regular access)"
echo "  • HTTPS on port 5443 (camera on mobile)"
echo ""

cd "$(dirname "$0")"

# Check/generate certificates for HTTPS
if [ ! -f "cert.pem" ] || [ ! -f "key.pem" ]; then
    echo "📜 Generating SSL certificates for HTTPS..."
    LOCAL_IP=$(hostname -I | awk '{print $1}')

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

    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout key.pem -out cert.pem -days 365 \
        -config /tmp/openssl_san.cnf 2>/dev/null

    rm -f /tmp/openssl_san.cnf
    echo "✅ Certificates generated"
    echo ""
fi

# Kill any existing servers on ports 5000 and 5443
for port in 5000 5443; do
    pid=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pid" ]; then
        echo "Stopping existing server on port $port..."
        kill -9 $pid 2>/dev/null
        sleep 1
    fi
done

# Start the dual server
python server_dual.py

