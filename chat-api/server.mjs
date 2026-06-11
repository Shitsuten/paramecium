import { handleGatewaySend, getGatewayStats, getContextBlocks, getMcpStatus } from "./gateway.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import http from 'http';

const DATA = '/opt/chat-api/data';
const PORT = 3800;
if (!existsSync(DATA)) mkdirSync(DATA, {recursive:true});

const json = (res, data, status=200) => { if (res.headersSent) return; res.writeHead(status, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(JSON.stringify(data)); };
const readBody = req => new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });

  // ============================================================
  //  MEMORY SYSTEM — /memory/v2/*
  // ============================================================
  const MEM_DIR = '/opt/raffaello/memory';

  // --- helpers ---
  function readMdFile(filepath) {
    if (!existsSync(filepath)) return null;
    return readFileSync(filepath, 'utf8');
  }
  function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    m[1].split('\n').forEach(line => {
      const [k, ...v] = line.split(':');
      if (k && v.length) {
        let val = v.join(':').trim();
        if (val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1,-1).split(',').map(s => s.trim());
        } else if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (!isNaN(val) && val !== '') val = Number(val);
        meta[k.trim()] = val;
      }
    });
    return { meta, body: m[2].trim() };
  }
  function factsDir() { return MEM_DIR + '/facts'; }
  function listFacts() {
    const dir = factsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
      const raw = readFileSync(dir + '/' + f, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      return { ...meta, body, filename: f };
    });
  }


http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, {}); return; }
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // GET /conversations - list all
  if (req.method === 'GET' && path === '/conversations') {
    const files = readdirSync(DATA).filter(f => f.endsWith('.json') && f !== 'memory.json' && f !== 'settings.json' && f !== 'gateway-stats.json');
    const convs = files.map(f => {
      try { const d = JSON.parse(readFileSync(`${DATA}/${f}`,'utf8')); const msgs=d.messages||[]; let lastTs=null; for(let i=msgs.length-1;i>=0;i--){if(msgs[i].timestamp){lastTs=msgs[i].timestamp;break;}} const updAt=lastTs?new Date(lastTs).toISOString():d.created_at; return { id:d.id, title:d.title, created_at:d.created_at, updated_at:updAt, message_count:(d.messages||[]).length, starred:d.starred||false, project:d.project||null }; }
      catch(e) { return null; }
    }).filter(Boolean).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
    json(res, convs);
  }

  // GET /conversations/search?q=... - full-text search across all conversations
  else if (req.method === 'GET' && path === '/conversations/search') {
    const q = url.searchParams.get('q')?.toLowerCase()?.trim();
    if (!q) { json(res, []); return; }
    const files = readdirSync(DATA).filter(f => f.endsWith('.json') && f !== 'memory.json' && f !== 'settings.json' && f !== 'gateway-stats.json');
    const results = [];
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8'));
        const msgs = d.messages || [];
        const matches = [];
        for (let i = 0; i < msgs.length; i++) {
          const c = typeof msgs[i].content === 'string' ? msgs[i].content : '';
          const idx = c.toLowerCase().indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 30);
            const end = Math.min(c.length, idx + q.length + 50);
            matches.push({ role: msgs[i].role, snippet: (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : ''), index: i });
          }
        }
        const titleMatch = (d.title || '').toLowerCase().includes(q);
        if (matches.length || titleMatch) {
          results.push({ id: d.id, title: d.title || 'New chat', created_at: d.created_at, starred: d.starred || false, project: d.project || null, titleMatch, matches: matches.slice(0, 3) });
        }
      } catch(e) {}
    }
    results.sort((a,b) => (b.matches.length || 0) - (a.matches.length || 0));
    json(res, results);
  }
  // GET /conversations/:id
  else if (req.method === 'GET' && path.match(/^\/conversations\/[^/]+$/)) {
    const id = path.split('/')[2];
    const file = `${DATA}/${id}.json`;
    if (!existsSync(file)) { json(res, {error:'not found'}, 404); return; }
    json(res, JSON.parse(readFileSync(file,'utf8')));
  }
  // POST /conversations - create
  else if (req.method === 'POST' && path === '/conversations') {
    const body = JSON.parse(await readBody(req));
    writeFileSync(`${DATA}/${body.id}.json`, JSON.stringify(body,null,2));
    json(res, {ok:true});
  }
  // PUT /conversations/:id - update
  else if (req.method === 'PUT' && path.match(/^\/conversations\/[^/]+$/)) {
    const id = path.split('/')[2];
    const file = `${DATA}/${id}.json`;
    // Backup before overwrite
    if (existsSync(file)) {
      const BK = `${DATA}/backups`;
      if (!existsSync(BK)) mkdirSync(BK, {recursive:true});
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      writeFileSync(`${BK}/${id}_${ts}.json`, readFileSync(file));
      // Keep max 20 backups per conv
      const bks = readdirSync(BK).filter(f=>f.startsWith(id+'_')).sort();
      while(bks.length > 20) { try { unlinkSync(`${BK}/${bks.shift()}`); } catch(e){} }
    }
    const body = JSON.parse(await readBody(req));
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    // Safety: reject if incoming messages would shrink the conversation (stale client)
    if (body.messages && existing.messages && body.messages.length < existing.messages.length) {
      console.warn('[PUT-blocked] ' + id + ': incoming ' + body.messages.length + ' < existing ' + existing.messages.length);
      json(res, { ok: false, error: 'stale_messages', existing: existing.messages.length, incoming: body.messages.length }, 409);
      return;
    }
    const merged = { ...existing, ...body, id };
    delete merged.updated_at;
    writeFileSync(file, JSON.stringify(merged,null,2));
    json(res, {ok:true});
  }
  // DELETE /conversations/:id
  else if (req.method === 'DELETE' && path.match(/^\/conversations\/[^/]+$/)) {
    const id = path.split('/')[2];
    const file = `${DATA}/${id}.json`;
    if (existsSync(file)) unlinkSync(file);
    json(res, {ok:true});
  }
  
  // PATCH /conversations/:id - partial update (title, starred, project)
  else if (req.method === 'PATCH' && path.match(/^\/conversations\/[^/]+$/)) {
    const id = path.split('/')[2];
    const file = `${DATA}/${id}.json`;
    if (!existsSync(file)) { json(res, {error:'not found'}, 404); return; }
    const conv = JSON.parse(readFileSync(file, 'utf8'));
    const updates = JSON.parse(await readBody(req));
    if (updates.title !== undefined) conv.title = updates.title;
    if (updates.starred !== undefined) conv.starred = updates.starred;
    if (updates.project !== undefined) conv.project = updates.project;
    writeFileSync(file, JSON.stringify(conv, null, 2));
    json(res, { ok: true });
  }
  // POST /inject - inject a proactive assistant message + push notification
  else if (req.method === 'POST' && path === '/inject') {
    const body = JSON.parse(await readBody(req));
    const content = body.content;
    if (!content) { json(res, {error:'content required'}, 400); return; }
    
    // 找目标对话：指定id或最近的
    let convId = body.conversation_id;
    if (!convId) {
      const files = readdirSync(DATA).filter(f => f.endsWith('.json') && f !== 'memory.json' && f !== 'settings.json' && f !== 'gateway-stats.json');
      const convs = files.map(f => {
        try { const d = JSON.parse(readFileSync(`${DATA}/${f}`,'utf8')); return { id:d.id, created_at:d.created_at }; }
        catch { return null; }
      }).filter(Boolean).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
      if (convs.length) convId = convs[0].id;
    }
    if (!convId) { json(res, {error:'no conversation found'}, 404); return; }
    
    const file = `${DATA}/${convId}.json`;
    if (!existsSync(file)) { json(res, {error:'conversation not found'}, 404); return; }
    const conv = JSON.parse(readFileSync(file,'utf8'));
    
    // 添加assistant消息
    const msg = { role:'assistant', content, timestamp: Date.now() };
    if (!conv.messages) conv.messages = [];
    conv.messages.push(msg);
    writeFileSync(file, JSON.stringify(conv,null,2));
    
    // 推送通知
    try {
      const pushBody = JSON.stringify({ title: '新消息', body: content.slice(0, 100), url: '/chat/' });
      const pushReq = http.request({ hostname:'127.0.0.1', port:3600, path:'/push/send', method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(pushBody)} }, ()=>{});
      pushReq.write(pushBody);
      pushReq.end();
    } catch(e) {}
    
    json(res, { ok:true, conversation_id:convId, message_count:conv.messages.length });
  }
  // GET /settings
  else if (req.method === 'GET' && path === '/settings') {
    const file = DATA + '/settings.json';
    if (existsSync(file)) json(res, JSON.parse(readFileSync(file,'utf8')));
    else json(res, {});
  }
  // PUT /settings
  else if (req.method === 'PUT' && path === '/settings') {
    const body = JSON.parse(await readBody(req));
    writeFileSync(DATA + '/settings.json', JSON.stringify(body,null,2));
    json(res, {ok:true});
  }
  // POST /proxy - forward API requests to any provider (avoids CORS)
  else if (req.method === 'POST' && path === '/proxy') {
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const { targetUrl, headers: fwdHeaders, payload } = parsed;
    if (!targetUrl) { json(res, {error:'missing targetUrl'}, 400); return; }
    const https = await import('https');
    const urlObj = new URL(targetUrl);
    const opts = { method:'POST', hostname:urlObj.hostname, port:443, path:urlObj.pathname+urlObj.search, headers:{'Content-Type':'application/json',...fwdHeaders} };
    const payloadStr = JSON.stringify(payload);
    opts.headers['Content-Length'] = Buffer.byteLength(payloadStr);
    const proxyReq = https.default.request(opts, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || 'application/json';
      res.writeHead(proxyRes.statusCode, {'Content-Type':ct,'Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => json(res, {error:e.message}, 502));
    proxyReq.write(payloadStr);
    proxyReq.end();
  }

  // GET|POST /memory/v2/inject — delegates to memory-gateway (3900)
  else if ((req.method === 'GET' || req.method === 'POST') && path === '/memory/v2/inject') {
    let userContext = '';
    if (req.method === 'POST') {
      try { const b = JSON.parse(await readBody(req)); userContext = b.context || ''; } catch(e) {}
    }

    // Thin proxy to 3900's /inject (kept for the chat frontend's memory panel;
    // gateway.mjs calls 3900 directly since 2026-06-11)
    let result = { injection: '', static: '', dynamic: '', token_estimate: 0, semantic_hits: 0, facts_injected: 0 };
    try {
      const igRes = await fetch('http://127.0.0.1:3900/inject', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ context: userContext })
      });
      result = await igRes.json();
    } catch(e) { console.warn('[inject] memory-gateway unreachable:', e.message); }

    json(res, result);
  }


    // GET /memory/v2/profile
  else if (req.method === 'GET' && path === '/memory/v2/profile') {
    const user = readMdFile(MEM_DIR + '/profile/user.md') || '';
    const relationship = readMdFile(MEM_DIR + '/profile/relationship.md') || '';
    json(res, { user, relationship });
  }

  // PUT /memory/v2/profile/:type
  else if (req.method === 'PUT' && path.match(/^\/memory\/v2\/profile\/(user|relationship)$/)) {
    const type = path.split('/').pop();
    const body = JSON.parse(await readBody(req));
    writeFileSync(MEM_DIR + '/profile/' + type + '.md', body.content);
    json(res, { ok: true });
  }

  // GET /memory/v2/facts
  else if (req.method === 'GET' && path === '/memory/v2/facts') {
    json(res, listFacts());
  }

  // POST /memory/v2/facts
  else if (req.method === 'POST' && path === '/memory/v2/facts') {
    const body = JSON.parse(await readBody(req));
    const id = body.id || Date.now().toString(36);
    const filename = id + '.md';
    const tags = body.tags ? '[' + body.tags.join(', ') + ']' : '[]';
    const md = '---\ntype: fact\nid: ' + id + '\ncreated: ' + (body.created || new Date().toISOString().slice(0,10))
      + (body.expires ? '\nexpires: ' + body.expires : '')
      + '\nresolved: ' + (body.resolved ? 'true' : 'false') + '\ntags: ' + tags
      + '\n---\n' + body.content;
    writeFileSync(factsDir() + '/' + filename, md);
    json(res, { ok: true, id, filename });
  }

  // PUT /memory/v2/facts/:id
  else if (req.method === 'PUT' && path.match(/^\/memory\/v2\/facts\/[^/]+$/)) {
    const id = path.split('/').pop();
    const dir = factsDir();
    const file = readdirSync(dir).find(f => f === id + '.md' || f === id);
    if (!file) { json(res, { error: 'not found' }, 404); return; }
    const body = JSON.parse(await readBody(req));
    writeFileSync(dir + '/' + file, body.content);
    json(res, { ok: true });
  }

  // DELETE /memory/v2/facts/:id
  else if (req.method === 'DELETE' && path.match(/^\/memory\/v2\/facts\/[^/]+$/)) {
    const id = path.split('/').pop();
    const dir = factsDir();
    const file = readdirSync(dir).find(f => f === id + '.md' || f === id);
    if (!file) { json(res, { error: 'not found' }, 404); return; }
    unlinkSync(dir + '/' + file);
    json(res, { ok: true });
  }

  // GET /memory/v2/memories
  else if (req.method === 'GET' && path === '/memory/v2/memories') {
    try {
      const sr = await fetch('http://127.0.0.1:3900/query?limit=50');
      const rows = await sr.json();
      json(res, rows);
    } catch(e) { json(res, []); }
  }

  // POST /memory/v2/memories/search — semantic search
  else if (req.method === 'POST' && path === '/memory/v2/memories/search') {
    try {
      const body = JSON.parse(await readBody(req));
      const sr = await fetch('http://127.0.0.1:3900/search', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ query: body.query || '', n: body.n || 10 })
      });
      const d = await sr.json();
      json(res, d.results || []);
    } catch(e) { json(res, []); }
  }

  // GET /memory/v2/stats
  else if (req.method === 'GET' && path === '/memory/v2/stats') {
    const facts = listFacts();
    let memCount = 0;
    try { const h = await fetch('http://127.0.0.1:3900/health'); const hd = await h.json(); memCount = hd.vectors || 0; } catch(e) {}
    json(res, {
      profiles: { user: existsSync(MEM_DIR + '/profile/user.md'), relationship: existsSync(MEM_DIR + '/profile/relationship.md') },
      facts: { total: facts.length, active: facts.filter(f => !f.resolved).length },
      memories: memCount
    });
  }

  // POST /ingest — proxy to memory-gateway for <mem> tag extraction
  else if (req.method === 'POST' && path === '/ingest') {
    try {
      const body = await readBody(req);
      const igReq = http.request({ hostname:'127.0.0.1', port:3900, path:'/ingest', method:'POST',
        headers:{'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body)} }, (igRes) => {
        let d = '';
        igRes.on('data', c => d += c);
        igRes.on('end', () => { try { json(res, JSON.parse(d)); } catch(e) { json(res, {ok:true}); } });
      });
      igReq.on('error', () => json(res, {extracted:[], error:'gateway unreachable'}));
      igReq.write(body);
      igReq.end();
    } catch(e) { json(res, {error:e.message}, 500); }
  }

  // POST /gateway/send — main gateway endpoint
  else if (req.method === "POST" && path === "/gateway/send") {
    try {
      const body = JSON.parse(await readBody(req));
      await handleGatewaySend(body, res);
    } catch(e) {
      if (!res.headersSent) {
        res.writeHead(500, {"Content-Type":"text/event-stream","Access-Control-Allow-Origin":"*"});
        res.write("data: " + JSON.stringify({type:"error",error:{message:e.message}}) + "\n\n");
      }
      res.end();
    }
  }
  // GET /gateway/stats — analytics dashboard data
  else if (req.method === "GET" && path === "/gateway/stats") {
    json(res, getGatewayStats());
  }
  // GET /gateway/context — inspect BP blocks
  else if (req.method === "GET" && path.startsWith("/gateway/context")) {
    const url = new URL(req.url, "http://localhost");
    const convId = url.searchParams.get("conv") || null;
    const blocks = await getContextBlocks(convId);
    json(res, blocks);
  }
  // GET /gateway/mcp — MCP server status and tools
  else if (req.method === "GET" && path === "/gateway/mcp") {
    const refresh = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
    const status = await getMcpStatus(refresh);
    json(res, status);
  }
  // GET /gateway/status — gateway info
  else if (req.method === "GET" && path === "/gateway/status") {
    json(res, { ok: true, version: "2.0", segments: 6 });
  }


  // POST /gateway/count-tokens — accurate token count via provider API
  else if (req.method === "POST" && path === "/gateway/count-tokens") {
    try {
      const body = JSON.parse(await readBody(req));
      const text = body.text || "";
      const settings = JSON.parse(readFileSync(DATA + "/settings.json", "utf8"));
      const accts = settings.accounts || [];
      const acct = accts.find(a => a.name === "ofox") || accts.find(a => a.provider === "anthropic" && a.endpoint && a.endpoint.includes("anthropic")) || {};
      const apiKey = acct.apiKey || settings.apiKey;
      const endpoint = acct.endpoint || "https://api.anthropic.com";
      const url = new URL(endpoint);
      const basePath = url.pathname.replace(/\/$/, "");
      const payload = JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: text }]
      });
      const https = await import("https");
      const result = await new Promise((resolve, reject) => {
        const r = https.default.request({
          hostname: url.hostname,
          path: basePath + "/v1/messages/count_tokens",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          }
        }, resp => {
          let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
        });
        r.on("error", reject);
        r.write(payload);
        r.end();
      });
      json(res, JSON.parse(result));
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  else { console.log("[404] " + req.method + " " + path); json(res, {error:"not found"}, 404); }
}).listen(PORT, () => console.log('Chat API on', PORT));
