"""Raffaello memory search service — Python HTTP on port 3900.
Handles semantic search (ChromaDB) + structured queries (SQLite).
"""
import json, sqlite3, os, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

sys.path.insert(0, '/opt/raffaello/memory')
from embedding import BGEZhEmbedding

import chromadb

MEM_DIR = '/opt/raffaello/memory'
DB_PATH = MEM_DIR + '/meta.db'
VEC_PATH = MEM_DIR + '/vectors'

# Init ChromaDB
_client = chromadb.PersistentClient(path=VEC_PATH)
_ef = BGEZhEmbedding()
_col = _client.get_or_create_collection("raffaello_memory", embedding_function=_ef, metadata={"hnsw:space": "cosine"})

def get_db():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.row_factory = sqlite3.Row
    return db

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        t = datetime.now().strftime('%H:%M:%S')
        print(f"[{t}] {fmt % args}")

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_POST(self):
        if self.path == '/search':
            body = self._read_body()
            query = body.get('query', '')
            n = body.get('n', 5)
            if not query:
                return self._json({'error': 'query required'}, 400)
            
            count = _col.count()
            if count == 0:
                return self._json({'results': []})
            
            results = _col.query(query_texts=[query], n_results=min(n, count))
            items = []
            for i in range(len(results['ids'][0])):
                items.append({
                    'id': results['ids'][0][i],
                    'distance': results['distances'][0][i],
                    'document': results['documents'][0][i],
                    'metadata': results['metadatas'][0][i]
                })
            self._json({'results': items})

        elif self.path == '/embed':
            body = self._read_body()
            mem_id = body.get('id')
            text = body.get('text', '')
            metadata = body.get('metadata', {})
            if not mem_id or not text:
                return self._json({'error': 'id and text required'}, 400)
            
            # Upsert into ChromaDB
            _col.upsert(ids=[mem_id], documents=[text], metadatas=[metadata])
            
            # Upsert into SQLite
            db = get_db()
            db.execute('''INSERT OR REPLACE INTO memories 
                (id, date, emotion, intensity, resolved, pinned, activated, tags, summary, filename, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))''',
                (mem_id, metadata.get('date', datetime.now().strftime('%Y-%m-%d')),
                 metadata.get('emotion', 'neutral'), metadata.get('intensity', 3),
                 1 if metadata.get('resolved') else 0, 1 if metadata.get('pinned') else 0,
                 metadata.get('activated', 0), json.dumps(metadata.get('tags', [])),
                 metadata.get('summary', text[:200]), metadata.get('filename', mem_id + '.md')))
            db.commit()
            db.close()
            
            self._json({'ok': True, 'count': _col.count()})

        elif self.path == '/delete':
            body = self._read_body()
            mem_id = body.get('id')
            if not mem_id:
                return self._json({'error': 'id required'}, 400)
            try: _col.delete(ids=[mem_id])
            except: pass
            db = get_db()
            db.execute('DELETE FROM memories WHERE id = ?', (mem_id,))
            db.commit()
            db.close()
            self._json({'ok': True})

        else:
            self._json({'error': 'not found'}, 404)

    def do_GET(self):
        if self.path == '/health':
            db = get_db()
            mem_count = db.execute('SELECT COUNT(*) FROM memories').fetchone()[0]
            db.close()
            self._json({'status': 'ok', 'vectors': _col.count(), 'sqlite_memories': mem_count})
        
        elif self.path.startswith('/query'):
            # Structured query: /query?pinned=1&resolved=0&limit=10&since=2026-04-01
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            
            db = get_db()
            where = []
            args = []
            if 'pinned' in params:
                where.append('pinned = ?')
                args.append(int(params['pinned'][0]))
            if 'resolved' in params:
                where.append('resolved = ?')
                args.append(int(params['resolved'][0]))
            if 'since' in params:
                where.append('date >= ?')
                args.append(params['since'][0])
            if 'emotion' in params:
                where.append('emotion = ?')
                args.append(params['emotion'][0])
            
            limit = int(params.get('limit', [20])[0])
            clause = ' AND '.join(where) if where else '1=1'
            rows = db.execute(f'SELECT * FROM memories WHERE {clause} ORDER BY date DESC LIMIT ?', args + [limit]).fetchall()
            db.close()
            
            self._json([dict(r) for r in rows])
        
        else:
            self._json({'error': 'not found'}, 404)

if __name__ == '__main__':
    port = 3900
    server = HTTPServer(('127.0.0.1', port), Handler)
    print(f"Raffaello memory search on :{port}")
    server.serve_forever()
