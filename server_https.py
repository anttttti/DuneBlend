#!/usr/bin/env python3
"""
HTTPS server with SSL support for camera access on mobile devices.
Generates self-signed certificates if not present.
"""
import http.server
import socketserver
import json
import os
import ssl
import socket
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from email import message_from_bytes
from io import BytesIO

PORT = 5000
BLENDS_DIR = Path(__file__).parent / "blends"
CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"


class ReuseAddrTCPServer(socketserver.TCPServer):
    """TCP Server with SO_REUSEADDR enabled."""
    allow_reuse_address = True


class BlendServerHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with blend file upload/download support."""

    def do_GET(self):
        """Handle GET requests - serve files and list blends."""
        try:
            parsed = urlparse(self.path)

            # API: List blends
            if parsed.path == '/api/blends':
                result = self.list_blends()
                if result['success']:
                    # Return just the blends array for client compatibility
                    self.send_json_response(result['blends'])
                else:
                    self.send_json_response([])
                return

            # API: Check if server features are available
            if parsed.path == '/api/server-features':
                self.send_json_response({
                    'canSaveToServer': True,
                    'canLoadFromServer': True,
                    'serverType': 'local-https'
                })
                return

            # API: Load blend file
            if parsed.path.startswith('/api/blend/load/'):
                filename = parsed.path.split('/api/blend/load/')[1]
                result = self.load_blend(filename)
                self.send_json_response(result)
                return

            # Default: serve static files
            return super().do_GET()

        except Exception as e:
            print(f"Error in GET: {e}")
            self.send_error(500, f"Internal server error: {str(e)}")

    def do_POST(self):
        """Handle POST requests - upload/save blends."""
        try:
            parsed = urlparse(self.path)

            # API: Save blend file
            if parsed.path == '/api/blend/save':
                result = self.save_blend()
                self.send_json_response(result)
                return

            # API: Upload blend file
            if parsed.path == '/api/blend/upload':
                result = self.upload_blend()
                self.send_json_response(result)
                return

            self.send_error(404, "Not Found")

        except Exception as e:
            print(f"Error in POST: {e}")
            self.send_error(500, f"Internal server error: {str(e)}")

    def send_json_response(self, data, status=200):
        """Send JSON response."""
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def list_blends(self):
        """List all blend files."""
        try:
            BLENDS_DIR.mkdir(exist_ok=True)
            files = []
            for f in BLENDS_DIR.glob("*.md"):
                stat = f.stat()
                files.append({
                    'name': f.name,
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
            return {'success': True, 'blends': files}
        except Exception as e:
            return {'success': False, 'error': str(e), 'blends': []}

    def load_blend(self, filename):
        """Load a blend file."""
        try:
            filepath = BLENDS_DIR / filename
            if not filepath.exists():
                return {'success': False, 'error': 'File not found'}

            content = filepath.read_text(encoding='utf-8')
            return {'success': True, 'content': content, 'filename': filename}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def save_blend(self):
        """Save blend content to file."""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            filename = data.get('filename', 'blend.md')
            content = data.get('content', '')

            BLENDS_DIR.mkdir(exist_ok=True)
            filepath = BLENDS_DIR / filename
            filepath.write_text(content, encoding='utf-8')

            return {'success': True, 'message': f'Saved {filename}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def upload_blend(self):
        """Handle file upload."""
        try:
            content_type = self.headers['Content-Type']
            if 'multipart/form-data' not in content_type:
                return {'success': False, 'error': 'Invalid content type'}

            # Parse multipart form data
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            # Simple boundary extraction
            boundary = content_type.split('boundary=')[1].encode()
            parts = post_data.split(b'--' + boundary)

            for part in parts:
                if b'filename=' in part:
                    # Extract filename and content
                    lines = part.split(b'\r\n')
                    filename_line = [l for l in lines if b'filename=' in l][0]
                    filename = filename_line.split(b'filename="')[1].split(b'"')[0].decode()

                    # Find content (after empty line)
                    content_start = part.find(b'\r\n\r\n') + 4
                    content_end = len(part) - 2  # Remove trailing \r\n
                    content = part[content_start:content_end].decode('utf-8')

                    # Save file
                    BLENDS_DIR.mkdir(exist_ok=True)
                    filepath = BLENDS_DIR / filename
                    filepath.write_text(content, encoding='utf-8')

                    return {'success': True, 'message': f'Uploaded {filename}'}

            return {'success': False, 'error': 'No file in upload'}
        except Exception as e:
            return {'success': False, 'error': str(e)}


def get_local_ip():
    """Get local IP address."""
    try:
        # Create a socket to get local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except:
        return "localhost"


def run_server():
    """Run the HTTPS server."""
    # Ensure certificates exist
    if not os.path.exists(CERT_FILE) or not os.path.exists(KEY_FILE):
        print("❌ SSL certificates not found!")
        print("   Run ./run_server_https.sh to generate them")
        return

    # Ensure blends directory exists
    BLENDS_DIR.mkdir(exist_ok=True)

    # Create server
    with ReuseAddrTCPServer(("", PORT), BlendServerHandler) as httpd:
        # Wrap with SSL
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(CERT_FILE, KEY_FILE)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

        local_ip = get_local_ip()

        print(f"""
╔══════════════════════════════════════════════════════════╗
║  Dune Imperium Blend Builder - HTTPS Server             ║
╚══════════════════════════════════════════════════════════╝

🌐 Server running at:
   • Local:  https://localhost:{PORT}
   • Network: https://{local_ip}:{PORT}

✅ Features enabled:
   • Static file serving
   • Blend file upload to server
   • Blend file download from server
   • Blend list API
   • 📷 HTTPS enabled for camera access

📁 Blend files stored in: {BLENDS_DIR}

⚠️  SECURITY NOTE:
   This uses self-signed certificates.
   Your browser will show a security warning.
   
   On your Android phone:
   1. Visit https://{local_ip}:{PORT}
   2. Click "Advanced" or "Details"
   3. Click "Proceed" or "Accept risk"
   4. Camera will work! ✅

Press Ctrl+C to stop the server
""")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n✅ Server stopped")


if __name__ == '__main__':
    run_server()

