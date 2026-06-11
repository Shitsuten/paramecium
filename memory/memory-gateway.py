"""Memory Gateway — unified memory service for the Raffaello ecosystem.
Port 3900. Provides inject/ingest/search for all frontends.

Endpoints:
  POST /inject    — assembled memory injection text (the core endpoint)
  POST /search    — semantic search (vector + BM25 + recency + access)
  POST /raw-search — L0 exact-text recall over raw-archive.db (FTS5)
  POST /embed     — store/update a memory vector (write-time dedup)
  POST /delete    — delete a memory
  POST /ingest    — extract <mem> tags from assistant reply, store them
  POST /merge     — supersede memories under a kept one
  GET  /health    — status
  GET  /query /memories /stats — structured SQLite queries
  GET  /facts     — list active facts
  GET  /profiles  — read profiles
  GET  /edges     — list relationship edges (graph kept by request)
  GET  /edges/stats — edge statistics

2026-06-11 cleanup: frozen subsystems removed (heat decay, touch_ripple,
core-memory tier injection, importance, similarity clustering, auto-tier).
Full pre-cleanup source: attic/memory-gateway.pre-cleanup-0611.py
DB columns (heat/tier/energy/polarity/importance) are kept — data untouched.
"""
import json, sqlite3, os, sys, re, uuid, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timedelta
from urllib.request import Request, urlopen
from math import exp, log

import jieba
from collections import Counter

# ── BM25 Engine ──
class BM25:
    def __init__(self, k1=1.5, b=0.75):
        self.k1 = k1
        self.b = b
        self._corpus = []
        self._doc_ids = []
        self._avgdl = 0
        self._idf = {}
        self._doc_freqs = []
        self._dirty = True

    def _tokenize(self, text):
        return [w.strip() for w in jieba.cut(text) if len(w.strip()) > 0]

    def build(self, doc_ids, documents):
        self._doc_ids = list(doc_ids)
        self._corpus = []
        self._doc_freqs = []
        total_len = 0
        df = Counter()
        for doc in documents:
            tokens = self._tokenize(doc)
            tf = Counter(tokens)
            self._doc_freqs.append(tf)
            self._corpus.append(tokens)
            total_len += len(tokens)
            for t in set(tokens):
                df[t] += 1
        n = len(documents)
        self._avgdl = total_len / n if n > 0 else 1
        self._idf = {t: log((n - freq + 0.5) / (freq + 0.5) + 1) for t, freq in df.items()}
        self._dirty = False

    def score(self, query):
        if self._dirty or not self._corpus:
            return {}
        query_tokens = self._tokenize(query)
        scores = {}
        for i, (doc_id, tf) in enumerate(zip(self._doc_ids, self._doc_freqs)):
            dl = len(self._corpus[i])
            s = 0.0
            for qt in query_tokens:
                if qt not in self._idf:
                    continue
                f = tf.get(qt, 0)
                idf = self._idf[qt]
                s += idf * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * dl / self._avgdl))
            if s > 0:
                scores[doc_id] = s
        return scores

_bm25 = BM25()
_bm25_last_build = None
_bm25_lock = threading.Lock()

def get_bm25_scorer():
    # ThreadingHTTPServer (2026-06-11): never mutate an index another thread may
    # be scoring — build into a fresh object, swap the reference atomically.
    global _bm25, _bm25_last_build
    if _bm25_last_build and (datetime.now() - _bm25_last_build).total_seconds() < 300:
        return _bm25
    with _bm25_lock:
        # Re-check under the lock: another thread may have just rebuilt
        if _bm25_last_build and (datetime.now() - _bm25_last_build).total_seconds() < 300:
            return _bm25
        count = _col.count()
        if count == 0:
            return _bm25
        batch_size = 5000
        all_ids, all_docs = [], []
        offset = 0
        while offset < count:
            batch = _col.get(limit=batch_size, offset=offset, include=['documents'])
            all_ids.extend(batch['ids'])
            all_docs.extend(batch['documents'])
            offset += batch_size
        fresh = BM25()
        fresh.build(all_ids, all_docs)
        _bm25 = fresh
        _bm25_last_build = datetime.now()
        print(f'[bm25] index rebuilt: {len(all_ids)} docs')
    return _bm25

sys.path.insert(0, '/opt/raffaello/memory')
from embedding import BGEZhEmbedding
import chromadb

MEM_DIR   = '/opt/raffaello/memory'
DB_PATH   = MEM_DIR + '/meta.db'
VEC_PATH  = MEM_DIR + '/vectors'
VAULT_PATH = '/opt/memory-mcp/data/memories.json'
EDGES_PATH = MEM_DIR + '/edges.jsonl'
PORT = 3900

# ── ChromaDB ──
_client = chromadb.PersistentClient(path=VEC_PATH)
_ef = BGEZhEmbedding()
_col = _client.get_or_create_collection("raffaello_memory", embedding_function=_ef, metadata={"hnsw:space": "cosine"})
_archive_col = _client.get_or_create_collection("chat_archive", embedding_function=_ef, metadata={"hnsw:space": "cosine"})

def _clean_meta(meta):
    """Sanitize metadata for ChromaDB — it rejects empty lists."""
    return {k: (v if not isinstance(v, list) or len(v) > 0 else json.dumps(v))
            for k, v in meta.items() if v is not None}

# ── SQLite ──
def get_db():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.row_factory = sqlite3.Row
    return db

def ensure_schema():
    """Add heat/energy/polarity columns if missing."""
    db = get_db()
    cols = [r[1] for r in db.execute("PRAGMA table_info(memories)").fetchall()]
    for col, typ, default in [
        ('heat', 'REAL', '1.0'),
        ('last_accessed', 'TEXT', "''"),
        ('access_count', 'INTEGER', '0'),
        ('energy', 'INTEGER', '0'),
        ('polarity', 'TEXT', "'neutral'"),
        ('tier', 'INTEGER', '4'),
        ('valid_from', 'TEXT', "''"),
        ('valid_until', 'TEXT', "''"),
        ('superseded_by', 'TEXT', "''"),
        ('importance', 'REAL', '0.5'),
    ]:
        if col not in cols:
            db.execute(f'ALTER TABLE memories ADD COLUMN {col} {typ} DEFAULT {default}')
            print(f'[schema] added column: {col}')
    db.commit()
    db.close()

ensure_schema()

# ── Recall log table ──
def ensure_recall_log():
    db = get_db()
    db.execute('''CREATE TABLE IF NOT EXISTS recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        query TEXT NOT NULL,
        score REAL,
        ts TEXT DEFAULT (datetime('now')),
        source TEXT DEFAULT 'search'
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_recall_memory ON recall_log(memory_id)')
    db.commit()
    db.close()

ensure_recall_log()

# ── File helpers ──
def read_md(filepath):
    if not os.path.exists(filepath):
        return None
    with open(filepath, 'r') as f:
        return f.read()

def parse_frontmatter(text):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.DOTALL)
    if not m:
        return {}, text.strip()
    meta = {}
    for line in m.group(1).split('\n'):
        if ':' not in line:
            continue
        k, *v = line.split(':')
        val = ':'.join(v).strip()
        if val.startswith('[') and val.endswith(']'):
            val = [s.strip() for s in val[1:-1].split(',') if s.strip()]
        elif val == 'true':
            val = True
        elif val == 'false':
            val = False
        else:
            try:
                val = int(val) if '.' not in val else float(val)
            except:
                pass
        meta[k.strip()] = val
    return meta, m.group(2).strip()

def list_facts():
    d = MEM_DIR + '/facts'
    if not os.path.isdir(d):
        return []
    facts = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith('.md'):
            continue
        meta, body = parse_frontmatter(read_md(d + '/' + fn))
        facts.append({**meta, 'body': body, 'filename': fn})
    return facts

def active_facts(context=''):
    """Return facts filtered by resolved/expired/keywords."""
    now = datetime.now()
    ctx_lower = context.lower() if context else ''
    result = []
    for f in list_facts():
        if f.get('resolved') is True:
            continue
        if f.get('expires'):
            try:
                if datetime.fromisoformat(str(f['expires'])) < now:
                    continue
            except:
                pass
        # Keyword filtering when context available
        if ctx_lower and f.get('keywords') and isinstance(f['keywords'], list) and len(f['keywords']) > 0:
            if f.get('always') is True:
                pass  # always-inject bypasses keyword check
            elif not any(kw.lower() in ctx_lower for kw in f['keywords']):
                continue
        result.append(f)
    return result

def read_profiles():
    user = read_md(MEM_DIR + '/profile/user.md')
    rel  = read_md(MEM_DIR + '/profile/relationship.md')
    parts = {}
    if user:
        _, body = parse_frontmatter(user)
        parts['user'] = body
    if rel:
        _, body = parse_frontmatter(rel)
        parts['relationship'] = body
    return parts

def count_tokens_cjk(text):
    t = 0
    for ch in text:
        c = ord(ch)
        if 0x4E00 <= c <= 0x9FFF or 0x3000 <= c <= 0x30FF:
            t += 1.5
        else:
            t += 0.28
    return round(t)

def temporal_relevance(valid_from, valid_until):
    """Score 0..1 based on whether now falls within validity window."""
    now = datetime.now()
    if not valid_from and not valid_until:
        return 1.0  # no window = always valid
    try:
        vf = datetime.fromisoformat(valid_from) if valid_from else None
        vu = datetime.fromisoformat(valid_until) if valid_until else None
    except:
        return 1.0
    if vf and now < vf:
        days_early = (vf - now).total_seconds() / 86400
        return max(0.1, 1.0 - days_early * 0.1)  # gentle penalty
    if vu and now > vu:
        days_late = (now - vu).total_seconds() / 86400
        return max(0.05, exp(-0.1 * days_late))  # exponential fade after expiry
    return 1.0  # within window



# ── Edge graph helpers ──
def load_edges():
    """Load all edges from edges.jsonl."""
    edges = []
    if not os.path.exists(EDGES_PATH):
        return edges
    with open(EDGES_PATH, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                edges.append(json.loads(line))
            except:
                continue
    return edges

def get_edge_neighbors(memory_ids, min_confidence=0.55):
    """Find one-hop neighbors for given memory IDs from edges."""
    edges = load_edges()
    neighbors = {}  # neighbor_id -> best_edge
    id_set = set(memory_ids)
    for edge in edges:
        conf = edge.get('confidence', 0)
        if conf < min_confidence:
            continue
        src = edge.get('source', '')
        tgt = edge.get('target', '')
        if src in id_set and tgt not in id_set:
            if tgt not in neighbors or conf > neighbors[tgt].get('confidence', 0):
                neighbors[tgt] = edge
        elif tgt in id_set and src not in id_set:
            if src not in neighbors or conf > neighbors[src].get('confidence', 0):
                neighbors[src] = edge
    return neighbors

def get_edge_stats():
    """Return basic edge stats."""
    edges = load_edges()
    type_dist = {}
    for e in edges:
        rt = e.get('relation_type', 'unknown')
        type_dist[rt] = type_dist.get(rt, 0) + 1
    return {
        'total_edges': len(edges),
        'type_distribution': type_dist,
    }


# ── Hybrid search: vector + BM25, ranked semantic x recency x access ──
def search_memories(query, n=5, boost_heat=True, log_access=None):
    # log_access: bump access_count + recall_log for top hits. Defaults to
    # boost_heat for backwards compat. The injection index passes False —
    # only a real recall (tool call) counts as "remembered".
    if log_access is None:
        log_access = boost_heat
    count = _col.count()
    if count == 0:
        return []

    # Vector search: over-fetch 3x
    vec_results = _col.query(query_texts=[query], n_results=min(n * 3, count))
    vec_ids = vec_results['ids'][0]
    vec_docs = {vec_ids[i]: vec_results['documents'][0][i] for i in range(len(vec_ids))}
    vec_metas = {vec_ids[i]: vec_results['metadatas'][0][i] for i in range(len(vec_ids))}
    vec_dists = {vec_ids[i]: vec_results['distances'][0][i] for i in range(len(vec_ids))}

    # BM25 search
    bm25 = get_bm25_scorer()
    bm25_scores = bm25.score(query)

    # Merge candidate set
    all_ids = set(vec_ids)
    bm25_top = sorted(bm25_scores.items(), key=lambda x: -x[1])[:n * 3]
    for mid, _ in bm25_top:
        all_ids.add(mid)

    # Fetch missing docs from ChromaDB for BM25-only hits
    missing = [mid for mid in all_ids if mid not in vec_docs]
    if missing:
        try:
            fetched = _col.get(ids=missing, include=['documents', 'metadatas'])
            for i, mid in enumerate(fetched['ids']):
                vec_docs[mid] = fetched['documents'][i]
                vec_metas[mid] = fetched['metadatas'][i]
        except:
            pass

    # Normalize BM25 scores (display only since 2026-06-12)
    max_bm25 = max(bm25_scores.values()) if bm25_scores else 1.0

    # RRF (2026-06-12): rank-based fusion replaces linear score mixing.
    # Vector distances and BM25 scores live on incommensurable scales; ranks
    # don't. Normalized so rank 1 → 1.0, keeping downstream multipliers legible.
    RRF_K = 60
    vec_rank = {m: i + 1 for i, m in enumerate(vec_ids)}
    bm25_rank = {m: i + 1 for i, (m, _) in enumerate(bm25_top)}

    items = []
    db = get_db() if boost_heat else None
    now = datetime.now()
    for mid in all_ids:
        if mid not in vec_docs:
            continue
        doc = vec_docs[mid]
        meta = vec_metas.get(mid, {})
        dist = vec_dists.get(mid, 1.0)

        # Exclude split-source originals: long docs whose content now lives as
        # focused split entries (tag set by split-memories.mjs)
        tags_raw = meta.get('tags', '')
        if isinstance(tags_raw, list):
            tags_list = tags_raw
        else:
            try:
                tags_list = json.loads(tags_raw) if tags_raw else []
            except Exception:
                tags_list = []
        if 'split-done' in tags_list:
            continue

        t_score = 1.0
        access_count = 0
        superseded = False
        if db:
            row = db.execute('SELECT valid_from, valid_until, superseded_by, access_count, tags FROM memories WHERE id = ?', (mid,)).fetchone()
            if row:
                t_score = temporal_relevance(row['valid_from'] or '', row['valid_until'] or '')
                superseded = bool(row['superseded_by'])
                access_count = row['access_count'] or 0
                try:
                    if 'split-done' in json.loads(row['tags'] or '[]'):
                        continue
                except Exception:
                    pass
        if superseded:
            continue

        # Three-factor ranking (2026-06-10 simplification, RRF since 06-12):
        #   semantic (vector+BM25 rank fusion) x recency decay x access boost,
        #   gated by validity window.
        # heat/tier/energy/polarity/edges are frozen out of ranking.
        bm25_norm = bm25_scores.get(mid, 0) / max_bm25 if max_bm25 > 0 else 0
        rrf_v = (RRF_K + 1) / (RRF_K + vec_rank[mid]) if mid in vec_rank else 0.0
        rrf_b = (RRF_K + 1) / (RRF_K + bm25_rank[mid]) if mid in bm25_rank else 0.0
        semantic = rrf_v * 0.70 + rrf_b * 0.30

        recency = 1.0
        date_str = str(meta.get('date', '') or '')
        if date_str:
            try:
                age_days = (now - datetime.fromisoformat(date_str[:10])).days
                recency = exp(-max(0, age_days) / 60.0)  # ~60-day decay constant
            except Exception:
                pass

        score = semantic * (0.7 + 0.3 * recency) * (1 + 0.05 * log(1 + access_count)) * t_score
        items.append({
            'id': mid, 'distance': dist, 'document': doc,
            'metadata': meta,
            'temporal': round(t_score, 3), 'recency': round(recency, 3),
            'score': round(score, 4), 'bm25': round(bm25_norm, 3),
        })

    if db:
        if log_access:
            top_items = sorted(items, key=lambda x: -x['score'])[:n]
            for item in top_items:
                db.execute('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?',
                           (datetime.now().isoformat(), item['id']))
                db.execute('INSERT INTO recall_log (memory_id, query, score, source) VALUES (?, ?, ?, ?)',
                           (item['id'], query[:500], item['score'], 'search'))
            db.commit()
        db.close()
    items.sort(key=lambda x: -x['score'])
    return items[:n]

# ── Inject: the core endpoint ──
def build_injection(context=''):
    """Build memory injection. Profiles (static) + facts + semantic search (budget-limited)."""
    parts_static = []
    parts_dynamic = []

    # Profiles (static, always injected)
    profiles = read_profiles()
    if profiles.get('user'):
        parts_static.append(f"<user_profile>\n{profiles['user']}\n</user_profile>")
    if profiles.get('relationship'):
        parts_static.append(f"<relationship>\n{profiles['relationship']}\n</relationship>")

    # Active facts (keyword-filtered)
    facts = active_facts(context)
    if facts:
        facts_text = '\n\n'.join(f['body'] for f in facts)
        parts_dynamic.append(f"<current_facts>\n{facts_text}\n</current_facts>")

    # Semantic search — index only (2026-06-11): one line per hit instead of
    # full documents (~150 tok vs ~1000+). Full content is pulled on demand by
    # the gateway's built-in recall tool; only that counts as access.
    search_results = []
    if context:
        search_results = search_memories(context, n=5, log_access=False)
        # Relative filter (2026-06-10): natural-sentence queries sit at dist
        # 0.5-0.6 with bge-small-zh, so a hard 0.45 cutoff starved injection.
        # Keep results within 0.15 of the best hit, hard junk line at 0.65.
        if search_results:
            best = min(r['distance'] for r in search_results)
            search_results = [r for r in search_results if r['distance'] < min(best + 0.15, 0.65)]
        if search_results:
            idx_lines = []
            for r in search_results:
                meta = r.get('metadata') or {}
                date = str(meta.get('date', ''))[:10]
                cat = str(meta.get('category', '') or '').strip()
                summ = str(meta.get('summary') or r.get('document') or '').strip().replace('\n', ' ')
                if len(summ) > 60:
                    summ = summ[:60] + '\u2026'
                tag = (date + ' ' + cat).strip()
                idx_lines.append('- [' + tag + '] ' + summ)
            parts_dynamic.append('<memory_index>\n' + '\n'.join(idx_lines) + '\n</memory_index>')

    # Edge-based neighbor expansion: removed 2026-06-10 (edges frozen out of
    # injection \u2014 ranking is semantic x recency x access only)

    # Assemble
    static_text = '<memory_static>\n' + '\n\n'.join(parts_static) + '\n</memory_static>' if parts_static else ''
    dynamic_text = '<memory_dynamic>\n' + '\n\n'.join(parts_dynamic) + '\n</memory_dynamic>' if parts_dynamic else ''
    injection = '\n\n'.join(filter(None, [static_text, dynamic_text]))

    return {
        'injection': injection,
        'static': static_text,
        'dynamic': dynamic_text,
        'token_estimate': count_tokens_cjk(injection),
        'semantic_hits': len(search_results),
        'facts_injected': len(facts),
    }

# ── Ingest: extract <mem> tags ──
def ingest_text(text):
    """Scan assistant reply for <mem>...</mem> tags, store each as a memory.
    Supports optional category: <mem category="抽屉">content</mem>
    Default category: 碎碎念
    """
    pattern = re.compile(r'<mem(?:\s+category="([^"]*)")?\s*>(.*?)</mem>', re.DOTALL)
    matches = pattern.findall(text)
    if not matches:
        return []
    stored = []
    for category, content in matches:
        content = content.strip()
        category = category.strip() if category else 'auto'
        if not content or len(content) < 5:
            continue
        mem_id = 'inline:' + datetime.now().strftime('%Y%m%d%H%M%S') + ':' + uuid.uuid4().hex[:6]
        # Store only in ChromaDB (gateway injection), not vault
        embed_text = f'[{category}] {content}'
        _col.upsert(ids=[mem_id], documents=[embed_text], metadatas=[{
            'date': datetime.now().strftime('%Y-%m-%d'),
            'source': 'inline_tag',
            'category': category,
            'summary': content,
        }])
        stored.append({'id': mem_id, 'content': content, 'category': category})
    return stored

# ── Manual merge (kept: supersede mechanism is active in ranking) ──
def merge_memories(keep_id, absorb_ids):
    """Mark absorbed memories as superseded by keep_id. Does not delete them."""
    db = get_db()
    for aid in absorb_ids:
        db.execute("UPDATE memories SET superseded_by = ?, heat = heat * 0.1 WHERE id = ?", (keep_id, aid))
    row = db.execute("SELECT heat, access_count FROM memories WHERE id = ?", (keep_id,)).fetchone()
    if row:
        new_heat = min(1.0, (row['heat'] or 0.5) + 0.1 * len(absorb_ids))
        new_count = (row['access_count'] or 0) + sum(1 for _ in absorb_ids)
        db.execute("UPDATE memories SET heat = ?, access_count = ? WHERE id = ?", (new_heat, new_count, keep_id))
    db.commit()
    db.execute('PRAGMA wal_checkpoint(PASSIVE)')
    db.close()
    return {'kept': keep_id, 'absorbed': absorb_ids}


# ── HTTP Handler ──
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        t = datetime.now().strftime('%H:%M:%S')
        print(f"[{t}] {fmt % args}")

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        # ── /models — update model config ──
        if self.path == '/models':
            try:
                body = self._read_body()
                models_path = os.path.join(os.path.dirname(__file__), 'models.json')
                with open(models_path, 'r') as mf:
                    current = json.load(mf)
                current.update(body)
                with open(models_path, 'w') as mf:
                    json.dump(current, mf, indent=2, ensure_ascii=False)
                self._json({'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)
            return

        # ── /ingest-extracted — store memory from extraction script ──
        if self.path == '/ingest-extracted':
            body = self._read_body()
            mem_id = body.get('id', 'ext:' + uuid.uuid4().hex[:12])
            document = body.get('document', '')
            date = body.get('date', datetime.now().strftime('%Y-%m-%d'))
            source = body.get('source', 'extraction')
            conv_id = body.get('conversation_id', '')
            quote = body.get('quote', '')
            if not document or len(document) < 10:
                self._json({'error': 'document too short'}, 400)
                return
            _col.upsert(ids=[mem_id], documents=[document], metadatas=[{
                'date': date,
                'source': source,
                'category': 'extracted',
                'conversation_id': conv_id,
                'summary': document,
                'quote': quote,
            }])
            db = get_db()
            db.execute('''INSERT OR REPLACE INTO memories
                (id, summary, date, heat, tier, pinned, tags, filename)
                VALUES (?, ?, ?, 0.5, 3, 0, ?, ?)''',
                (mem_id, document, date, f'["{source}","extracted"]', mem_id))
            db.commit()
            db.close()
            self._json({'ok': True, 'id': mem_id})
            return

        # ── /inject — the core endpoint ──
        if self.path == '/inject':
            body = self._read_body()
            context = body.get('context', '')
            result = build_injection(context)
            self._json(result)

        # ── /search — semantic search ──
        elif self.path == '/search':
            body = self._read_body()
            query = body.get('query', '')
            n = body.get('n', 5)
            if not query:
                return self._json({'error': 'query required'}, 400)
            results = search_memories(query, n, boost_heat=body.get('boost_heat', True))
            self._json({'results': results})

        # ── /embed — store memory ──
        elif self.path == '/embed':
            body = self._read_body()
            mem_id = body.get('id')
            text = body.get('text', '')
            metadata = body.get('metadata', {})
            if not mem_id or not text:
                return self._json({'error': 'id and text required'}, 400)
            # Write-time dedup: check for >75% similar existing memory
            merged_into = None
            skip_dedup = body.get('skip_dedup', False)
            if not skip_dedup and _col.count() > 0:
                try:
                    similar = _col.query(query_texts=[text], n_results=3)
                    for i, sid in enumerate(similar['ids'][0]):
                        if sid == mem_id:
                            continue
                        sim = max(0, 1 - similar['distances'][0][i])
                        if sim > 0.75:
                            existing_doc = similar['documents'][0][i]
                            merged_text = existing_doc + '\n' + text if len(existing_doc) < 2000 else text
                            _col.upsert(ids=[sid], documents=[merged_text], metadatas=[_clean_meta(similar['metadatas'][0][i])])
                            ddb = get_db()
                            ddb.execute('UPDATE memories SET heat = MIN(1.0, heat + 0.1), access_count = access_count + 1, updated_at = datetime(\'now\') WHERE id = ?', (sid,))
                            ddb.commit()
                            ddb.close()
                            merged_into = sid
                            print(f'[dedup] merged {mem_id} into {sid} (sim={sim:.2f})')
                            break
                except Exception as e:
                    print(f'[dedup] error: {e}')
            if merged_into:
                self._json({'ok': True, 'merged_into': merged_into, 'count': _col.count()})
                return
            _col.upsert(ids=[mem_id], documents=[text], metadatas=[_clean_meta(metadata)])
            db = get_db()
            db.execute('''INSERT OR REPLACE INTO memories 
                (id, date, emotion, intensity, resolved, pinned, activated, tags, summary, filename,
                 heat, tier, energy, polarity, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, datetime('now'))''',
                (mem_id, metadata.get('date', datetime.now().strftime('%Y-%m-%d')),
                 metadata.get('emotion', 'neutral'), metadata.get('intensity', 3),
                 1 if metadata.get('resolved') else 0, 1 if metadata.get('pinned') else 0,
                 metadata.get('activated', 0), json.dumps(metadata.get('tags', [])),
                 metadata.get('summary', text), metadata.get('filename', mem_id + '.md'),
                 metadata.get('heat', 1.0), metadata.get('tier', 4),
                 metadata.get('energy', 0), metadata.get('polarity', 'neutral')))
            if metadata.get('valid_from'):
                db.execute('UPDATE memories SET valid_from = ? WHERE id = ?', (metadata['valid_from'], mem_id))
            if metadata.get('valid_until'):
                db.execute('UPDATE memories SET valid_until = ? WHERE id = ?', (metadata['valid_until'], mem_id))
            db.commit()
            db.close()
            self._json({'ok': True, 'count': _col.count()})

        # ── /delete — delete memory ──
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

        # ── /ingest — extract <mem> tags from text ──
        elif self.path == '/ingest':
            body = self._read_body()
            text = body.get('text', '')
            if not text:
                return self._json({'extracted': []})
            extracted = ingest_text(text)
            self._json({'extracted': extracted, 'count': len(extracted)})

        # ── /raw-search — L0 exact-text recall over the raw archive (FTS5) ──
        elif self.path == '/raw-search':
            body = self._read_body()
            q = (body.get('query') or '').strip()
            limit = min(int(body.get('n', 8)), 30)
            if not q:
                return self._json({'error': 'query required'}, 400)
            try:
                rdb = sqlite3.connect('/opt/raffaello/memory/raw-archive.db')
                # trigram tokenizer: phrase-quote the query for literal matching
                safe_q = '"' + q.replace('"', '""') + '"'
                rows = rdb.execute(
                    "SELECT content, source, ref_id, date, role FROM raw WHERE raw MATCH ? ORDER BY rank LIMIT ?",
                    (safe_q, limit)).fetchall()
                rdb.close()
                results = [{'content': r[0][:600], 'source': r[1], 'ref_id': r[2],
                            'date': r[3], 'role': r[4]} for r in rows]
                self._json({'results': results, 'count': len(results)})
            except Exception as e:
                self._json({'error': str(e)}, 500)

        # ── /archive-ingest — replace one conversation's window chunks ──
        elif self.path == '/archive-ingest':
            body = self._read_body()
            conv_id = body.get('replace_conv')
            windows = body.get('windows', [])
            try:
                if conv_id:
                    try:
                        _archive_col.delete(where={'conv_id': conv_id})
                    except Exception:
                        pass
                for i in range(0, len(windows), 64):
                    batch = windows[i:i+64]
                    _archive_col.upsert(
                        ids=[w['id'] for w in batch],
                        documents=[w['text'] for w in batch],
                        metadatas=[_clean_meta(w.get('metadata', {})) for w in batch])
                self._json({'ok': True, 'count': len(windows)})
            except Exception as e:
                self._json({'error': str(e)}, 500)

        # ── /archive-search — semantic search over chat archive windows ──
        #    max_distance: relevance floor (no hits beats garbage hits)
        #    per_conv: diversity cap so one conversation can't flood top-n
        #    after/before: ISO dates → date_int range filter
        elif self.path == '/archive-search':
            body = self._read_body()
            q = (body.get('query') or '').strip()
            n = min(int(body.get('n', 5)), 20)
            max_dist = float(body.get('max_distance', 0.55))
            per_conv = max(1, int(body.get('per_conv', 2)))
            if not q:
                return self._json({'error': 'query required'}, 400)
            clauses = []
            if body.get('after'):
                clauses.append({'date_int': {'$gte': int(str(body['after']).replace('-', ''))}})
            if body.get('before'):
                clauses.append({'date_int': {'$lte': int(str(body['before']).replace('-', ''))}})
            if body.get('conv_id'):
                clauses.append({'conv_id': body['conv_id']})
            where = clauses[0] if len(clauses) == 1 else ({'$and': clauses} if clauses else None)
            try:
                r = _archive_col.query(query_texts=[q], n_results=min(n * 3, 60), where=where,
                                       include=['documents', 'metadatas', 'distances'])
                results, conv_seen = [], {}
                for i in range(len(r['ids'][0])):
                    dist = r['distances'][0][i]
                    if dist > max_dist:
                        continue
                    meta = r['metadatas'][0][i]
                    cid = meta.get('conv_id', '')
                    if conv_seen.get(cid, 0) >= per_conv:
                        continue
                    conv_seen[cid] = conv_seen.get(cid, 0) + 1
                    results.append({'document': r['documents'][0][i],
                                    'metadata': meta, 'distance': dist})
                    if len(results) >= n:
                        break
                self._json({'results': results, 'count': len(results)})
            except Exception as e:
                self._json({'error': str(e)}, 500)

        # ── /merge — merge memories (keep one, supersede rest) ──
        elif self.path == '/merge':
            body = self._read_body()
            keep_id = body.get('keep')
            absorb_ids = body.get('absorb', [])
            if not keep_id or not absorb_ids:
                return self._json({'error': 'keep and absorb[] required'}, 400)
            result = merge_memories(keep_id, absorb_ids)
            self._json(result)

        # ── /set-validity — set temporal window on a memory ──
        elif self.path == '/set-validity':
            body = self._read_body()
            mem_id = body.get('id')
            if not mem_id:
                return self._json({'error': 'id required'}, 400)
            db = get_db()
            updates = []
            args = []
            if 'valid_from' in body:
                updates.append('valid_from = ?')
                args.append(body['valid_from'])
            if 'valid_until' in body:
                updates.append('valid_until = ?')
                args.append(body['valid_until'])
            if updates:
                args.append(mem_id)
                db.execute(f"UPDATE memories SET {', '.join(updates)} WHERE id = ?", args)
                db.commit()
            db.close()
            self._json({'ok': True})

        # ── /update — update memory metadata ──
        elif self.path == '/update-inline':
            body = self._read_body()
            mem_id = body.get('id')
            content = body.get('content', '').strip()
            if not mem_id or not content:
                return self._json({'error': 'id and content required'}, 400)
            try:
                existing = _col.get(ids=[mem_id], include=['metadatas'])
                if not existing['ids']:
                    return self._json({'error': 'not found'}, 404)
                meta = existing['metadatas'][0] if existing['metadatas'] else {}
                category = meta.get('category', '碎碎念')
                embed_text = f'[{category}] {content}'
                meta['summary'] = content
                _col.upsert(ids=[mem_id], documents=[embed_text], metadatas=[_clean_meta(meta)])
                self._json({'ok': True})
            except Exception as e:
                self._json({'error': str(e)}, 500)

        elif self.path == '/update':
            body = self._read_body()
            mem_id = body.get('id')
            if not mem_id:
                return self._json({'error': 'id required'}, 400)
            db = get_db()
            row = db.execute('SELECT * FROM memories WHERE id = ?', (mem_id,)).fetchone()
            if not row:
                db.close()
                return self._json({'error': 'not found'}, 404)
            fields = []
            args = []
            for col in ('emotion','intensity','resolved','pinned','tier','heat','energy','polarity','summary','tags','valid_from','valid_until','superseded_by','importance'):
                if col in body:
                    fields.append(f'{col} = ?')
                    args.append(body[col])
            if fields:
                fields.append("updated_at = datetime('now')")
                args.append(mem_id)
                db.execute(f"UPDATE memories SET {', '.join(fields)} WHERE id = ?", args)
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
            vault_count = 0
            try:
                vault_count = len(json.load(open(VAULT_PATH)))
            except: pass
            self._json({
                'status': 'ok',
                'vectors': _col.count(),
                'sqlite_memories': mem_count,
                'vault_memories': vault_count,
            })

        elif self.path == '/models':
            try:
                with open(os.path.join(os.path.dirname(__file__), 'models.json'), 'r') as mf:
                    self._json(json.load(mf))
            except:
                self._json({})

        elif self.path == '/facts':
            self._json(active_facts())

        elif self.path == '/profiles':
            self._json(read_profiles())

        elif self.path == '/architecture':
            # Serve ARCHITECTURE.md so the admin UI always shows the live doc
            md_path = MEM_DIR + '/ARCHITECTURE.md'
            md = read_md(md_path)
            if md is None:
                return self._json({'error': 'ARCHITECTURE.md not found'}, 404)
            mtime = datetime.fromtimestamp(os.path.getmtime(md_path)).strftime('%Y-%m-%d %H:%M')
            self._json({'markdown': md, 'updated': mtime})

        elif self.path.startswith('/query'):
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            db = get_db()
            where, args = [], []
            if 'pinned' in params:
                where.append('pinned = ?'); args.append(int(params['pinned'][0]))
            if 'resolved' in params:
                where.append('resolved = ?'); args.append(int(params['resolved'][0]))
            if 'since' in params:
                where.append('date >= ?'); args.append(params['since'][0])
            if 'emotion' in params:
                where.append('emotion = ?'); args.append(params['emotion'][0])
            if 'tier' in params:
                where.append('tier = ?'); args.append(int(params['tier'][0]))
            limit = int(params.get('limit', [20])[0])
            clause = ' AND '.join(where) if where else '1=1'
            rows = db.execute(f'SELECT * FROM memories WHERE {clause} ORDER BY heat DESC, date DESC LIMIT ?', args + [limit]).fetchall()
            db.close()
            self._json([dict(r) for r in rows])

        elif self.path == '/inline-memories':
            # List auto-ingested memories (ChromaDB only, id starts with inline:)
            try:
                all_data = _col.get(include=['documents','metadatas'])
                inline = []
                for i, mid in enumerate(all_data['ids']):
                    if mid.startswith('inline:'):
                        meta = all_data['metadatas'][i] if all_data['metadatas'] else {}
                        inline.append({
                            'id': mid,
                            'document': all_data['documents'][i] if all_data['documents'] else '',
                            'date': meta.get('date', ''),
                            'category': meta.get('category', ''),
                            'summary': meta.get('summary', ''),
                        })
                inline.sort(key=lambda x: x['date'], reverse=True)
                self._json({'memories': inline, 'total': len(inline)})
            except Exception as e:
                self._json({'error': str(e)}, 500)

        elif self.path.startswith('/memories'):
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            db = get_db()
            sort = params.get('sort', ['heat'])[0]
            order = params.get('order', ['desc'])[0].upper()
            limit = int(params.get('limit', [100])[0])
            offset = int(params.get('offset', [0])[0])
            search = params.get('q', [''])[0]
            valid_sorts = {'heat','date','tier','energy','created_at','updated_at'}
            if sort not in valid_sorts: sort = 'heat'
            if order not in ('ASC','DESC'): order = 'DESC'
            where, args = [], []
            if search:
                where.append('summary LIKE ?'); args.append(f'%{search}%')
            clause = ' AND '.join(where) if where else '1=1'
            total = db.execute(f'SELECT COUNT(*) FROM memories WHERE {clause}', args).fetchone()[0]
            rows = db.execute(f'SELECT * FROM memories WHERE {clause} ORDER BY {sort} {order} LIMIT ? OFFSET ?', args + [limit, offset]).fetchall()
            mems = []
            for r in rows:
                m = dict(r)
                try:
                    result = _col.get(ids=[m['id']], include=['documents'])
                    m['document'] = result['documents'][0] if result['documents'] else ''
                except: m['document'] = ''
                mems.append(m)
            db.close()
            self._json({'memories': mems, 'total': total})

        elif self.path == '/edges':
            edges = load_edges()
            self._json({'edges': edges, 'total': len(edges)})

        elif self.path.startswith('/edges/stats'):
            stats = get_edge_stats()
            self._json(stats)

        elif self.path == '/stats':
            db = get_db()
            total = db.execute('SELECT COUNT(*) FROM memories').fetchone()[0]
            tier_dist = {}
            for row in db.execute('SELECT tier, COUNT(*) as c FROM memories GROUP BY tier').fetchall():
                tier_dist[f'tier_{row["tier"]}'] = row['c']
            avg_heat = db.execute('SELECT AVG(heat) FROM memories').fetchone()[0] or 0
            with_validity = db.execute("SELECT COUNT(*) FROM memories WHERE valid_until != '' AND valid_until IS NOT NULL").fetchone()[0]
            superseded = db.execute("SELECT COUNT(*) FROM memories WHERE superseded_by != '' AND superseded_by IS NOT NULL").fetchone()[0]
            hot = db.execute('SELECT COUNT(*) FROM memories WHERE heat > 0.8').fetchone()[0]
            cold = db.execute('SELECT COUNT(*) FROM memories WHERE heat < 0.1').fetchone()[0]
            recent = db.execute("SELECT COUNT(*) FROM memories WHERE date >= date('now', '-7 days')").fetchone()[0]
            heat_dist = [0] * 20
            for row in db.execute('SELECT heat FROM memories').fetchall():
                h = row['heat'] or 0
                i = min(19, int(h * 20))
                heat_dist[i] += 1
            db.close()
            self._json({
                'total': total,
                'vectors': _col.count(),
                'tiers': tier_dist,
                'avg_heat': round(avg_heat, 3),
                'hot_memories': hot,
                'cold_memories': cold,
                'with_validity_window': with_validity,
                'superseded': superseded,
                'recent_7d': recent,
                'heat_distribution': heat_dist,
            })

        elif self.path.startswith('/recall-log/'):
            mem_id = self.path.split('/recall-log/')[1]
            from urllib.parse import unquote
            mem_id = unquote(mem_id)
            db = get_db()
            rows = db.execute('SELECT query, score, ts, source FROM recall_log WHERE memory_id = ? ORDER BY ts DESC LIMIT 20', (mem_id,)).fetchall()
            db.close()
            self._json({'logs': [dict(r) for r in rows]})

        elif self.path.startswith('/memory/') and len(self.path.split('/')) == 3:
            mem_id = self.path.split('/')[2]
            from urllib.parse import unquote
            mem_id = unquote(mem_id)
            db = get_db()
            row = db.execute('SELECT * FROM memories WHERE id = ?', (mem_id,)).fetchone()
            db.close()
            if not row:
                return self._json({'error': 'not found'}, 404)
            m = dict(row)
            try:
                result = _col.get(ids=[m['id']], include=['documents','metadatas'])
                m['document'] = result['documents'][0] if result['documents'] else ''
                m['chroma_metadata'] = result['metadatas'][0] if result['metadatas'] else {}
            except: m['document'] = ''; m['chroma_metadata'] = {}
            self._json(m)

        else:
            self._json({'error': 'not found'}, 404)

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f"Memory Gateway on :{PORT}")
    print(f"  vectors: {_col.count()}")
    print(f"  endpoints: /inject /search /raw-search /embed /ingest /merge /set-validity /health /facts /profiles /query /memories /stats /edges")
    edges_count = len(load_edges())
    print(f"  edges: {edges_count}")
    server.serve_forever()
