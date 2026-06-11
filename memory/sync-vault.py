"""Sync vault memories.json into ChromaDB via mem-search service.

Incremental: tracks content hashes in sync-state.json, only embeds new or
changed entries. This keeps /embed's INSERT OR REPLACE from wiping
heat/access_count on every run (the 2026-06-10 fix).

First run with --seed-state marks everything as already-synced without
embedding (for migrating from the old full-resync behavior).
"""
import json, sys, os, hashlib
from datetime import datetime
from urllib.request import Request, urlopen

VAULT_PATH = '/opt/memory-mcp/data/memories.json'
SEARCH_URL = 'http://127.0.0.1:3900'
STATE_PATH = '/opt/raffaello/memory/sync-state.json'

def post(path, data):
    req = Request(SEARCH_URL + path, json.dumps(data).encode(), {'Content-Type': 'application/json'})
    return json.loads(urlopen(req, timeout=30).read())

def entry_hash(entry):
    basis = entry.get('content', '') + '|' + entry.get('category', '') + '|' + ','.join(entry.get('tags', []))
    return hashlib.md5(basis.encode()).hexdigest()

def main():
    seed_only = '--seed-state' in sys.argv

    with open(VAULT_PATH) as f:
        entries = json.load(f)

    state = {}
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            state = json.load(f)

    if seed_only:
        for entry in entries:
            state['vault:' + entry['id']] = entry_hash(entry)
        with open(STATE_PATH, 'w') as f:
            json.dump(state, f)
        print(f"seeded state for {len(entries)} entries (no embedding done)")
        return

    try:
        urlopen(SEARCH_URL + '/health', timeout=5)
    except Exception:
        print("ERROR: mem-search service not running"); return

    synced = skipped = errors = 0
    for i, entry in enumerate(entries):
        vid = 'vault:' + entry['id']
        h = entry_hash(entry)
        if state.get(vid) == h:
            skipped += 1
            continue

        content = entry['content']
        category = entry.get('category', '')
        tags = entry.get('tags', [])
        created = entry.get('created_at', '')

        embed_text = f"[{category}] {' '.join(tags)}\n{content}"
        if len(embed_text) > 1500:
            embed_text = embed_text[:1500]

        try:
            post('/embed', {
                'id': vid,
                'text': embed_text,
                'metadata': {
                    'date': created[:10] if created else '',
                    'category': category,
                    'tags': tags,
                    'source': 'vault',
                    'vault_id': entry['id'],
                    'summary': content[:200]
                }
            })
            state[vid] = h
            synced += 1
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  error on {vid}: {e}")

    with open(STATE_PATH, 'w') as f:
        json.dump(state, f)

    t = datetime.now().strftime('%H:%M:%S')
    print(f"[{t}] sync done: {synced} synced, {skipped} skipped (unchanged), {errors} errors")

if __name__ == '__main__':
    main()
