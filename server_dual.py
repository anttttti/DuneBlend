#!/usr/bin/env python3
"""
Dual HTTP/HTTPS server for Dune Imperium Blend Builder.
- HTTP on port 5000 (for regular access)
- HTTPS on port 5443 (for camera access on mobile)
"""
import http.server
import socketserver
import json
import os
import ssl
import socket
import threading
import urllib.request
import urllib.parse as urlparse_module
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from email import message_from_bytes
from io import BytesIO

SEARXNG_INSTANCE = 'https://searx.be'

HTTP_PORT = 5000
HTTPS_PORT = 5443
BLENDS_DIR = Path(__file__).parent / "blends"
CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"


class ReuseAddrTCPServer(socketserver.TCPServer):
    """TCP Server with SO_REUSEADDR enabled."""
    allow_reuse_address = True


class BlendServerHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with blend file upload/download support."""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests - serve files and list blends."""
        try:
            parsed = urlparse(self.path)

            if parsed.path == '/api/search':
                self.handle_search(parsed)
                return

            if parsed.path == '/api/blends':
                result = self.list_blends()
                if result['success']:
                    self.send_json_response(result['blends'])
                else:
                    self.send_json_response([])
                return

            if parsed.path == '/api/server-features':
                self.send_json_response({
                    'canSaveToServer': True,
                    'canLoadFromServer': True,
                    'serverType': 'local-dual'
                })
                return

            if parsed.path.startswith('/api/blend/load/'):
                filename = parsed.path.split('/api/blend/load/')[1]
                result = self.load_blend(filename)
                self.send_json_response(result)
                return

            return super().do_GET()

        except (ConnectionResetError, BrokenPipeError) as e:
            pass
        except ssl.SSLError as e:
            pass  # Ignore SSL errors from clients
        except Exception as e:
            print(f"Error in GET: {e}")
            try:
                self.send_error(500, f"Internal server error: {str(e)}")
            except:
                pass

    def do_POST(self):
        """Handle POST requests - upload/save blends."""
        try:
            parsed = urlparse(self.path)

            if parsed.path == '/api/blend/save':
                result = self.save_blend()
                self.send_json_response(result)
                return

            if parsed.path == '/api/blend/upload':
                result = self.upload_blend()
                self.send_json_response(result)
                return

            self.send_error(404, "Not Found")

        except (ConnectionResetError, BrokenPipeError) as e:
            pass
        except Exception as e:
            print(f"Error in POST: {e}")
            try:
                self.send_error(500, f"Internal server error: {str(e)}")
            except:
                pass

    def handle_search(self, parsed):
        """Proxy web search via SearXNG or fetch a URL."""
        params = parse_qs(parsed.query)
        query    = params.get('q',   [None])[0]
        fetch_url = params.get('url', [None])[0]
        try:
            if query:
                search_url = (f"{SEARXNG_INSTANCE}/search"
                              f"?q={urlparse_module.quote(query)}&format=json&language=en")
                req = urllib.request.Request(search_url,
                    headers={'User-Agent': 'DuneBlend/1.0'})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())
                results = [
                    {'title': x.get('title',''), 'url': x.get('url',''), 'snippet': x.get('content','')}
                    for x in (data.get('results') or [])[:6]
                ]
                self.send_json_response({'results': results})
                return
            if fetch_url:
                req = urllib.request.Request(fetch_url,
                    headers={'User-Agent': 'Mozilla/5.0 (compatible; DuneBlend/1.0)'})
                with urllib.request.urlopen(req, timeout=10) as r:
                    html = r.read().decode('utf-8', errors='replace')
                import re
                text = re.sub(r'<script[\s\S]*?</script>', '', html, flags=re.IGNORECASE)
                text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.IGNORECASE)
                text = re.sub(r'<[^>]+>', ' ', text)
                text = re.sub(r'\s{2,}', ' ', text).strip()[:8000]
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(text.encode('utf-8'))
                return
            self.send_json_response({'error': 'Provide ?q= for search or ?url= to fetch a page.'}, 400)
        except Exception as e:
            self.send_json_response({'error': str(e)}, 502)

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
            blends = []
            if BLENDS_DIR.exists():
                for f in sorted(BLENDS_DIR.glob("*.md")):
                    stat = f.stat()
                    blends.append({
                        'name': f.name,
                        'size': stat.st_size,
                        'modified': stat.st_mtime
                    })
            return {'success': True, 'blends': blends}
        except Exception as e:
            return {'success': False, 'error': str(e)}

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
        """Save a blend file."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)

            filename = data.get('filename', 'untitled.md')
            content = data.get('content', '')

            if not filename.endswith('.md'):
                filename += '.md'

            filename = ''.join(c for c in filename if c.isalnum() or c in '._- ')

            BLENDS_DIR.mkdir(exist_ok=True)
            filepath = BLENDS_DIR / filename
            filepath.write_text(content, encoding='utf-8')

            return {'success': True, 'filename': filename}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def upload_blend(self):
        """Handle file upload."""
        try:
            content_type = self.headers.get('Content-Type', '')
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            if 'multipart/form-data' in content_type:
                boundary = content_type.split('boundary=')[1].encode()
                parts = body.split(b'--' + boundary)

                for part in parts:
                    if b'filename=' in part:
                        header_end = part.find(b'\r\n\r\n')
                        if header_end > 0:
                            headers = part[:header_end].decode('utf-8', errors='ignore')
                            file_content = part[header_end + 4:]
                            if file_content.endswith(b'\r\n'):
                                file_content = file_content[:-2]

                            filename_match = headers.split('filename="')
                            if len(filename_match) > 1:
                                filename = filename_match[1].split('"')[0]

                                if not filename.endswith('.md'):
                                    filename += '.md'

                                BLENDS_DIR.mkdir(exist_ok=True)
                                filepath = BLENDS_DIR / filename
                                filepath.write_bytes(file_content)

                                return {'success': True, 'filename': filename}

            return {'success': False, 'error': 'No file found in request'}
        except Exception as e:
            return {'success': False, 'error': str(e)}


def get_local_ip():
    """Get local IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except:
        return "localhost"


def run_http_server():
    """Run HTTP server."""
    with ReuseAddrTCPServer(("", HTTP_PORT), BlendServerHandler) as httpd:
        httpd.serve_forever()


def run_https_server():
    """Run HTTPS server."""
    print("  [HTTPS] Thread starting...")
    if not os.path.exists(CERT_FILE) or not os.path.exists(KEY_FILE):
        print(f"⚠️  HTTPS disabled - no certificates found")
        print(f"   Run ./run_server_https.sh to generate certificates")
        return

    try:
        print(f"  [HTTPS] Creating server on port {HTTPS_PORT}...")
        with ReuseAddrTCPServer(("", HTTPS_PORT), BlendServerHandler) as httpd:
            print("  [HTTPS] Setting up SSL context...")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(CERT_FILE, KEY_FILE)
            httpd.socket = context.wrap_socket(
                httpd.socket,
                server_side=True,
                do_handshake_on_connect=True
            )
            print(f"  [HTTPS] ✅ Server running on port {HTTPS_PORT}")
            httpd.serve_forever()
    except Exception as e:
        print(f"⚠️  HTTPS server failed: {e}")
        import traceback
        traceback.print_exc()


def run_server():
    """Run both HTTP and HTTPS servers."""
    BLENDS_DIR.mkdir(exist_ok=True)

    local_ip = get_local_ip()
    has_certs = os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)

    print(f"""
╔══════════════════════════════════════════════════════════╗
║  Dune Imperium Blend Builder - Dual Server              ║
╚══════════════════════════════════════════════════════════╝

🌐 HTTP Server (regular access):
   • Local:   http://localhost:{HTTP_PORT}
   • Network: http://{local_ip}:{HTTP_PORT}
""")

    if has_certs:
        print(f"""🔒 HTTPS Server (for camera on mobile):
   • Local:   https://localhost:{HTTPS_PORT}
   • Network: https://{local_ip}:{HTTPS_PORT}
   
   ⚠️  Accept the security warning in your browser
""")
    else:
        print(f"""⚠️  HTTPS disabled - no certificates
   Run: ./run_server_https.sh to generate certificates
""")

    print(f"""📁 Blend files stored in: {BLENDS_DIR}

Press Ctrl+C to stop
""")

    # Start HTTP server in main thread
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    # Start HTTPS server if certificates exist
    if has_certs:
        https_thread = threading.Thread(target=run_https_server, daemon=True)
        https_thread.start()

    try:
        # Keep main thread alive
        while True:
            import time
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\n✅ Server stopped")


if __name__ == '__main__':
    run_server()

