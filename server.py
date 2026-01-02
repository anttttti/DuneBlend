#!/usr/bin/env python3
"""
Simple HTTP server with file upload/download for local development.
Provides endpoints to save/load blend files to/from server.

For GitHub Pages deployment, these features are disabled client-side.
"""
import http.server
import socketserver
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from email import message_from_bytes
from io import BytesIO

PORT = 5000
BLENDS_DIR = Path(__file__).parent / "blends"


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
                    'serverType': 'local'
                })
                return

            # API: Download specific blend
            if parsed.path.startswith('/api/blend/download/'):
                filename = parsed.path.split('/')[-1]
                self.download_blend(filename)
                return

            # Default: serve static files
            super().do_GET()
        except Exception as e:
            print(f"Error in do_GET: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, f"Internal server error: {str(e)}")

    def do_POST(self):
        """Handle POST requests - upload blend files."""
        parsed = urlparse(self.path)

        # API: Upload new blend
        if parsed.path == '/api/blend/upload':
            self.upload_blend()
            return

        # API: Delete blend
        if parsed.path == '/api/blend/delete':
            self.delete_blend()
            return

        self.send_error(404, "Endpoint not found")

    def list_blends(self):
        """List all blend files."""
        try:
            blends = []
            for filepath in sorted(BLENDS_DIR.glob('*.md')):
                stat = filepath.stat()
                blends.append({
                    'filename': filepath.name,
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
            return {'success': True, 'blends': blends}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def download_blend(self, filename):
        """Download a blend file."""
        # Security: prevent directory traversal
        if '..' in filename or '/' in filename:
            self.send_error(403, "Invalid filename")
            return

        filepath = BLENDS_DIR / filename

        if not filepath.exists():
            self.send_error(404, "Blend not found")
            return

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            self.send_response(200)
            self.send_header('Content-Type', 'text/markdown')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(content.encode('utf-8'))
        except Exception as e:
            self.send_error(500, f"Error reading file: {str(e)}")

    def upload_blend(self):
        """Upload a new blend file."""
        try:
            content_type = self.headers.get('Content-Type')

            if content_type and content_type.startswith('application/json'):
                # JSON upload (markdown content in body)
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body)

                filename = data.get('filename', 'blend.md')
                content = data.get('content', '')

                # Security: sanitize filename
                filename = os.path.basename(filename)
                if not filename.endswith('.md'):
                    filename += '.md'

                # Security: prevent directory traversal
                if '..' in filename or '/' in filename:
                    self.send_json_response({'success': False, 'error': 'Invalid filename'})
                    return

                # Save file
                filepath = BLENDS_DIR / filename
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(content)

                # Update blends index
                self.update_blends_index()

                self.send_json_response({
                    'success': True,
                    'filename': filename,
                    'message': f'Blend saved to server: {filename}'
                })
            else:
                self.send_json_response({
                    'success': False,
                    'error': 'Only application/json content type is supported'
                })

        except Exception as e:
            self.send_json_response({'success': False, 'error': str(e)})

    def delete_blend(self):
        """Delete a blend file."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)

            filename = data.get('filename', '')

            # Security: prevent directory traversal
            if '..' in filename or '/' in filename:
                self.send_json_response({'success': False, 'error': 'Invalid filename'})
                return

            filepath = BLENDS_DIR / filename

            if not filepath.exists():
                self.send_json_response({'success': False, 'error': 'File not found'})
                return

            # Don't allow deleting base blends
            if filename in ['Base_Imperium.md', 'Base_Uprising.md']:
                self.send_json_response({'success': False, 'error': 'Cannot delete base blends'})
                return

            filepath.unlink()

            # Update blends index
            self.update_blends_index()

            self.send_json_response({
                'success': True,
                'message': f'Blend deleted: {filename}'
            })

        except Exception as e:
            self.send_json_response({'success': False, 'error': str(e)})

    def update_blends_index(self):
        """Update blends/index.json."""
        blend_files = [{'filename': f.name} for f in sorted(BLENDS_DIR.glob('*.md'))]
        with open(BLENDS_DIR / 'index.json', 'w') as f:
            json.dump(blend_files, f, indent=2)

    def send_json_response(self, data):
        """Send JSON response."""
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            json_data = json.dumps(data)
            self.wfile.write(json_data.encode('utf-8'))
        except Exception as e:
            print(f"Error in send_json_response: {e}")
            import traceback
            traceback.print_exc()

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()


def run_server():
    """Start the development server."""
    # Ensure blends directory exists
    BLENDS_DIR.mkdir(exist_ok=True)

    with ReuseAddrTCPServer(("", PORT), BlendServerHandler) as httpd:
        print(f"""
╔══════════════════════════════════════════════════════════╗
║  Dune Imperium Blend Builder - Development Server       ║
╚══════════════════════════════════════════════════════════╝

🌐 Server running at: http://localhost:{PORT}

✅ Features enabled:
   • Static file serving
   • Blend file upload to server
   • Blend file download from server
   • Blend list API

📁 Blend files stored in: {BLENDS_DIR}

⚠️  This server is for LOCAL DEVELOPMENT ONLY
   For production, deploy static files to GitHub Pages.
   Server-side features will be automatically disabled.

Press Ctrl+C to stop the server
""")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n✅ Server stopped")


if __name__ == '__main__':
    run_server()

