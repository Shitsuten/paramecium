#!/usr/bin/env python3
"""Build the L0 raw-archive FTS5 index.

L0 = source of truth: vault entries + API chat conversation messages, indexed
verbatim for exact-recall ("she said it exactly how?"). Rebuilt from scratch on
each run — sources are append-only so a full rebuild is always correct.

Output: /opt/raffaello/memory/raw-archive.db  (table: raw, FTS5 trigram)
"""
import json, os, sqlite3, glob, sys
from datetime import datetime

VAULT_PATH = '/opt/memory-mcp/data/memories.json'
CHAT_DIR = '/opt/chat-api/data'
DB_PATH = '/opt/raffaello/memory/raw-archive.db'

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text':
                parts.append(b.get('text', ''))
        return '\n'.join(parts)
    return ''

def main():
    tmp = DB_PATH + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute("CREATE VIRTUAL TABLE raw USING fts5(content, source UNINDEXED, ref_id UNINDEXED, date UNINDEXED, role UNINDEXED, tokenize='trigram')")

    n_vault = 0
    try:
        for e in json.load(open(VAULT_PATH)):
            content = e.get('content', '')
            if not content:
                continue
            db.execute("INSERT INTO raw VALUES (?,?,?,?,?)",
                       (content, 'vault:' + e.get('category', ''), e.get('id', ''),
                        (e.get('created_at') or '')[:10], ''))
            n_vault += 1
    except Exception as ex:
        print('vault failed:', ex)

    n_msg = 0
    for path in glob.glob(CHAT_DIR + '/*.json'):
        base = os.path.basename(path)
        if base in ('settings.json', 'memory.json', 'gateway-stats.json') or 'backup' in base:
            continue
        try:
            conv = json.load(open(path))
        except Exception:
            continue
        msgs = conv.get('messages') if isinstance(conv, dict) else None
        if not msgs:
            continue
        conv_id = conv.get('id', base.replace('.json', ''))
        for i, m in enumerate(msgs):
            t = text_of(m.get('content'))
            if not t and m.get('blocks'):
                t = '\n'.join(b.get('text', '') for b in m['blocks']
                              if isinstance(b, dict) and b.get('type') == 'text')
            if not t or len(t) < 2:
                continue
            ts = m.get('timestamp')
            date = ''
            if ts:
                try:
                    date = datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d')
                except Exception:
                    pass
            db.execute("INSERT INTO raw VALUES (?,?,?,?,?)",
                       (t, 'chat', f'{conv_id}:{i}', date, m.get('role', '')))
            n_msg += 1

    db.commit()
    db.close()
    os.replace(tmp, DB_PATH)
    print(f'raw-archive built: {n_vault} vault entries + {n_msg} chat messages -> {DB_PATH}')

if __name__ == '__main__':
    main()
