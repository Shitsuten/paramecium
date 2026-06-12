import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import https from 'https';
import http from 'http';
import { exec as execShell } from 'child_process';

const DATA = '/opt/chat-api/data';
const STATS_FILE = `${DATA}/gateway-stats.json`;
const CYCLE_TOKEN_THRESHOLD = 60000;
const RELAY_COUNT = 8;
const USER_ID = 'paramecium-user-stable'; // 发给上游API的稳定用户标识，随意命名

// ============================================================
//  File I/O
// ============================================================

function loadConv(id) {
  const f = `${DATA}/${id}.json`;
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

function saveConv(conv) {
  writeFileSync(`${DATA}/${conv.id}.json`, JSON.stringify(conv, null, 2));
}

function loadSettings() {
  const f = `${DATA}/settings.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

function loadStats() {
  return existsSync(STATS_FILE) ? JSON.parse(readFileSync(STATS_FILE, 'utf8')) : { requests: [], cacheHits: [] };
}

function appendStat(entry) {
  const stats = loadStats();
  stats.requests.push(entry);
  if (stats.requests.length > 200) stats.requests = stats.requests.slice(-200);
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function appendError(entry) {
  const stats = loadStats();
  if (!stats.errors) stats.errors = [];
  stats.errors.push(entry);
  if (stats.errors.length > 100) stats.errors = stats.errors.slice(-100);
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// ============================================================
//  Account Resolution
// ============================================================

function resolveAccount(settings, accountName) {
  const accounts = settings.accounts || [];
  if (accountName) {
    const found = accounts.find(a => a.name === accountName);
    if (found) return found;
  }
  if (settings.endpoint && settings.apiKey) {
    const matched = accounts.find(a => a.endpoint === settings.endpoint && a.apiKey === settings.apiKey);
    if (matched) return matched;
  }
  if (accounts.length) return accounts[0];
  return { name: 'default', endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model };
}

function isAnthropicProvider(account) {
  const ep = (account.endpoint || '').toLowerCase();
  const prov = (account.provider || '').toLowerCase();
  if (prov === 'anthropic') return true;
  if (prov && prov !== 'anthropic') return false;
  return ep.includes('anthropic.com') || ep.includes('aihubmix') || ep.includes('gptsapi');
}

function resolveAnthropicAccount(settings) {
  const found = (settings.accounts || []).find(a => isAnthropicProvider(a));
  return found || { endpoint: 'https://api.anthropic.com', apiKey: settings.apiKey || '' };
}

function resolveEndpoint(account, isAnthropic) {
  if (isAnthropic) {
    return (account.endpoint || 'https://api.anthropic.com') + '/v1/messages';
  }
  const raw = account.endpoint || 'https://openrouter.ai/api/v1/chat/completions';
  return raw.includes('/chat/completions') ? raw : raw.replace(/\/+$/, '') + '/v1/chat/completions';
}

// ============================================================
//  Format Conversion (Anthropic → OpenAI)
// ============================================================

function convertToOpenAIBody(body) {
  const oai = { model: body.model, stream: true, max_tokens: body.max_tokens, messages: [] };

  if (body.system?.length) {
    const sysText = body.system.map(b => b.text || '').filter(Boolean).join('\n\n');
    if (sysText) oai.messages.push({ role: 'system', content: sysText });
  }

  for (const msg of (body.messages || [])) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = msg.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
      }));
      const oaiMsg = { role: 'assistant' };
      if (textParts) oaiMsg.content = textParts;
      if (toolCalls.length) oaiMsg.tool_calls = toolCalls;
      oai.messages.push(oaiMsg);
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      const otherParts = msg.content.filter(b => b.type !== 'tool_result');

      for (const tr of toolResults) {
        const text = typeof tr.content === 'string' ? tr.content :
          Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('') : JSON.stringify(tr.content);
        oai.messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: text });
      }

      if (otherParts.length) {
        const parts = otherParts.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'image') {
            return { type: 'image_url', image_url: { url: `data:${b.source?.media_type || 'image/jpeg'};base64,${b.source?.data || ''}` } };
          }
          return { type: 'text', text: b.text || JSON.stringify(b) };
        });
        oai.messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      }
    } else {
      oai.messages.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
    }
  }

  if (body.tools?.length) {
    oai.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
    }));
  }

  return oai;
}

// ============================================================
//  Time Helpers
// ============================================================

function getActiveStyle(settings) {
  if (!settings.activeStyleId || !settings.styles) return null;
  const style = settings.styles.find(s => s.id === settings.activeStyleId);
  return style?.content || null;
}

function formatTimestamp(ts) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(ts);
  return `[${months[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}]`;
}

function todayBeijing() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function nowBeijing() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' CST+8';
}

// ============================================================
//  Recent Diary — pull latest from vault JSON for BP2
// ============================================================

let _diaryCache = null;
let _diaryCacheDay = '';  // BP2 day-anchored (2026-06-10): refresh once per day, not hourly —
                          // intra-day vault writes no longer invalidate BP2+history cache

function getRecentDiaries(days = 2) {
  const now = Date.now();
  const _today = todayBeijing();
  if (_diaryCache !== null && _diaryCacheDay === _today) return _diaryCache;

  try {
    const raw = readFileSync('/opt/memory-mcp/data/memories.json', 'utf8');
    const all = JSON.parse(raw);
    const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const diaries = all
      .filter(m => m.category === '日记' && (m.created_at || '').slice(0, 10) >= cutoff)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 3);
    const memos = all
      .filter(m => m.category === '备忘录' && (m.created_at || '').slice(0, 10) >= cutoff)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const entries = [];
    for (const d of diaries) {
      const date = (d.created_at || '').slice(0, 10);
      const content = d.content.length > 800 ? d.content.slice(0, 800) + '…' : d.content;
      entries.push('[' + date + ' 日记] ' + content);
    }
    for (const m of memos.slice(0, 2)) {
      const date = (m.created_at || '').slice(0, 10);
      const content = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
      entries.push('[' + date + ' 备忘录] ' + content);
    }

    _diaryCache = entries.length ? entries.join('\n\n---\n\n') : '';
    _diaryCacheDay = _today;
    return _diaryCache;
  } catch (e) {
    console.warn('[diary] failed to read vault:', e.message);
    return '';
  }
}

// ============================================================
//  Memory Injection
// ============================================================

async function getMemoryInjection(context, echo = '') {
  // 2026-06-11: call the memory gateway (3900) directly — the old hop through
  // 3800's /memory/v2/inject only added a dead supplement read.
  // 2026-06-12: echo = the assistant's previous reply, sent as a second query
  // lane ("回复的余味") — what the AI just said shapes what surfaces next turn.
  try {
    const resp = await fetch('http://127.0.0.1:3900/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, echo }),
      // 5s cap: degrade to no injection rather than stall /gateway/send before
      // headers are written (→ nginx 504). 3900 is threaded now (2026-06-11),
      // but a slow ChromaDB query or rebuild can still hang a request.
      signal: AbortSignal.timeout(5000)
    });
    return await resp.json();
  } catch {
    return { static: '', dynamic: '', facts_injected: 0, semantic_hits: 0, memory_ids: [] };
  }
}

// ============================================================
//  Context Builder — Cache-Optimized Layout
//
//  System: [BP1 stable] [BP2 daily] [BP3 session summary]
//  Messages: [...history...] [BP4 on last history msg] [current user + volatile]
// ============================================================

function buildSystemBlocks(settings, injection, conv, isAnthropic) {
  const blocks = [];

  // BP1: Personality + profiles
  let seg1 = settings.systemPrompt || '';
  if (injection.static) seg1 += (seg1 ? '\n\n' : '') + injection.static;
  if (seg1) {
    const block = { type: 'text', text: seg1 };
    if (isAnthropic) block.cache_control = { type: 'ephemeral', ttl: '1h' };
    blocks.push(block);
  }

  // BP2: Recent diary/memo from vault (changes ~daily, caches well)
  const recentDiary = getRecentDiaries(2);
  if (recentDiary) {
    const block = { type: 'text', text: `<recent_context>\n${recentDiary}\n</recent_context>` };
    if (isAnthropic) block.cache_control = { type: 'ephemeral', ttl: '1h' };
    blocks.push(block);
  }

  // BP3: Session context — compression summary only (stable, cacheable)
  const summary = conv.instantSummary || conv.compressionSummary || '';
  if (summary) {
    const block = { type: 'text', text: `<conversation_context>\n${summary}\n</conversation_context>` };
    if (isAnthropic) block.cache_control = { type: 'ephemeral', ttl: '1h' };
    blocks.push(block);
  }

  return blocks;
}


// Lossy image compression: call Haiku to describe image, replace base64 with text
async function compressImageMessage(conv, msgIdx) {
  const msg = conv.messages[msgIdx];
  const imgBlock = msg.content.find(b => b.type === 'image');
  if (!imgBlock) return;

  let description = '图片';
  try {
    const settings = loadSettings();
    const accts = settings.accounts || [];
    const acct = accts.find(a => a.name === 'ofox') || accts.find(a => a.provider === 'anthropic') || {};
    const apiKey = acct.apiKey || settings.apiKey;
    const baseUrl = (acct.endpoint || 'https://api.anthropic.com').replace(/\/$/, '');

    const resp = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: [imgBlock, { type: 'text', text: '简洁描述这张图片（一两句中文）。' }] }]
      })
    });
    const data = await resp.json();
    if (data.content?.[0]?.text) description = data.content[0].text;
  } catch(e) { console.warn('[img-compress] haiku failed:', e.message); }

  // Preserve originals to disk before stripping — never destroy what isn't saved
  const imgBlocks = msg.content.filter(b => b.type === 'image' && b.source?.data);
  const savedPaths = [];
  for (const b of imgBlocks) {
    try {
      const ext = ((b.source.media_type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
      const hash = createHash('sha1').update(b.source.data).digest('hex').slice(0, 16);
      const dir = '/opt/chat-api/images';
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const p = `${dir}/${conv.id}_${hash}.${ext}`;
      if (!existsSync(p)) writeFileSync(p, Buffer.from(b.source.data, 'base64'));
      savedPaths.push(p);
    } catch (e) { console.warn('[img-save] failed:', e.message); }
  }
  if (savedPaths.length < imgBlocks.length) {
    console.warn('[img-compress] aborted: originals not fully preserved, keeping base64');
    return;
  }
  // Replace base64 with text, keep original text parts
  const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
  msg.content = textParts.length ? textParts.join('\n') : '';
  msg.imageDescription = description;
  if (savedPaths.length) msg.imageFiles = savedPaths;
  saveConv(conv);
  console.log('[img-compress] ' + description.slice(0, 60));
}

function buildHistoryMessages(messages, isAnthropic) {
  const history = [];
  const imgAgeLimit = Math.max(0, messages.length - 6);

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    // 2026-06-11: proactive image downgrade for old messages
    if (mi < imgAgeLimit && Array.isArray(msg.content)) {
      const hasImage = msg.content.some(b => b.type === 'image');
      if (hasImage && !msg.imageDescription) {
        msg.imageDescription = '图片(已降级)';
      }
    }
    if (msg.role === 'user') {
      let content = typeof msg.content === 'string' ? msg.content : msg.content;
      // Lossy compression: strip base64 images, use text description if available
      if (Array.isArray(content)) {
        content = content.map(b => {
          if (b.type === 'image') return null;
          return b;
        }).filter(Boolean);
        // Check for imageDescription field (set by async compressImageMessage)
        if (msg.imageDescription) {
          content.push({ type: 'text', text: '[图片: ' + msg.imageDescription + ']' });
        }
        content = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
        if (!content) content = '[图片]';
      }
      if (typeof content === 'string' && msg.timestamp) {
        content = formatTimestamp(msg.timestamp) + '\n\n' + content;
      }
      history.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      if (msg.blocks?.length) {
        // Collect thinking blocks, convert tool_use to text summaries
        const thinkingBlocks = [];
        const textParts = [];
        for (const b of msg.blocks) {
          if (b.type === 'thinking') {
            const d = { type: 'thinking', thinking: b.thinking || '' };
            if (b.signature) d.signature = b.signature;
            thinkingBlocks.push(d);
          } else if (b.type === 'tool_use') {
            const inputPreview = b.input ? JSON.stringify(b.input).slice(0, 120) : '';
            textParts.push('[工具: ' + (b.name || '?') + (inputPreview ? ' ' + inputPreview : '') + ']');
          } else if (b.type === 'text') {
            if (b.text) textParts.push(b.text);
          }
        }
        const fullText = textParts.join('\n');
        // 2026-06-10: historical thinking blocks are stripped from the API
        // payload (kept in archive for the frontend). Saves middleman-billed
        // tokens; tool_use is already textified so no signature constraint.
        if (fullText) {
          history.push({ role: 'assistant', content: fullText });
        }
      } else {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) history.push({ role: 'assistant', content: text });
      }
    }
  }

  // BP4: Rolling breakpoint on last user message (array-wrapping assistant msgs breaks thinking on some providers)
  if (isAnthropic && history.length >= 2) {
    let bp4Target = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { bp4Target = history[i]; break; }
    }
    if (!bp4Target) bp4Target = history[history.length - 1];
    if (typeof bp4Target.content === 'string') {
      bp4Target.content = [{ type: 'text', text: bp4Target.content, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    } else if (Array.isArray(bp4Target.content) && bp4Target.content.length) {
      bp4Target.content[bp4Target.content.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' };
    }
  }

  return history;
}

function buildVolatileContext(injection, conv) {
  let parts = [`当前时间: ${nowBeijing()}`];
  if (injection.dynamic) parts.push(injection.dynamic);
  return `<gateway_volatile_context>仅供参考，勿复述：\n${parts.join('\n')}\n</gateway_volatile_context>`;
}

function buildCurrentUserMessage(text, imageData, imageMediaType, styleContent, volatileContext) {
  const parts = [];
  if (volatileContext) parts.push({ type: 'text', text: volatileContext });
  if (imageData) parts.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageData } });

  let msgText = text || '';
  if (styleContent) msgText += '\n\n<userStyle>\n' + styleContent + '\n</userStyle>';
  if (msgText) parts.push({ type: 'text', text: msgText });

  if (parts.length === 1 && parts[0].type === 'text' && !imageData && !volatileContext) {
    return { role: 'user', content: parts[0].text };
  }
  return { role: 'user', content: parts };
}

// ============================================================
//  SSE Helpers
// ============================================================

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function emit(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

// ============================================================
//  Stream Handlers (separated by provider)
// ============================================================

function handleAnthropicChunk(evt, state, clientRes, line) {
  clientRes.write(line + '\n\n');

  switch (evt.type) {
    case 'message_start':
      state.model = evt.message?.model || '';
      if (evt.message?.usage) state.usage = evt.message.usage;
      break;
    case 'content_block_start':
      state.blockType = evt.content_block?.type || 'text';
      state.blockData = { type: state.blockType };
      if (state.blockType === 'tool_use') {
        state.blockData.id = evt.content_block.id;
        state.blockData.name = evt.content_block.name;
        state.blockData.inputJson = '';
      }
      break;
    case 'content_block_delta': {
      const d = evt.delta || {};
      if (d.type === 'text_delta') {
        state.fullText += d.text || '';
        state.blockData.text = (state.blockData.text || '') + (d.text || '');
      } else if (d.type === 'thinking_delta') {
        state.thinkingText += d.thinking || '';
        state.blockData.thinking = (state.blockData.thinking || '') + (d.thinking || '');
      } else if (d.type === 'signature_delta') {
        state.blockData.signature = (state.blockData.signature || '') + (d.signature || '');
      } else if (d.type === 'input_json_delta') {
        state.blockData.inputJson = (state.blockData.inputJson || '') + (d.partial_json || '');
      }
      break;
    }
    case 'content_block_stop':
      if (state.blockType === 'tool_use' && state.blockData.inputJson) {
        try { state.blockData.input = JSON.parse(state.blockData.inputJson); } catch {}
        delete state.blockData.inputJson;
      }
      state.blocks.push({ ...state.blockData });
      state.blockType = '';
      state.blockData = {};
      break;
    case 'message_delta':
      if (evt.delta) state.stopReason = evt.delta.stop_reason;
      if (evt.usage) state.usage = { ...(state.usage || {}), ...evt.usage };
      break;
  }
}

function handleOpenAIChunk(evt, state, clientRes) {
  if (!state.started) {
    state.started = true;
    state.model = evt.model || '';
    emit(clientRes, {
      type: 'message_start',
      message: { id: evt.id || 'msg_or', type: 'message', role: 'assistant', model: state.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } }
    });
    emit(clientRes, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  }

  const choice = evt.choices?.[0];
  if (!choice) return;

  // Reasoning (DeepSeek etc.)
  const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning;
  if (reasoning) {
    state.thinkingText += reasoning;
    emit(clientRes, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoning } });
  }

  // Text content
  if (choice.delta?.content) {
    if (!state.textStarted) {
      state.textStarted = true;
      emit(clientRes, { type: 'content_block_stop', index: 0 });
      emit(clientRes, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    }
    state.fullText += choice.delta.content;
    emit(clientRes, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: choice.delta.content } });
  }

  // Tool calls
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state.toolCalls[idx]) {
        state.toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', args: '', index: idx };
        emit(clientRes, {
          type: 'content_block_start', index: idx + 2,
          content_block: { type: 'tool_use', id: state.toolCalls[idx].id, name: state.toolCalls[idx].name }
        });
      }
      if (tc.function?.arguments) {
        state.toolCalls[idx].args += tc.function.arguments;
        emit(clientRes, { type: 'content_block_delta', index: idx + 2, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
    }
  }

  if (choice.finish_reason) {
    state.stopReason = choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
  }

  if (evt.usage) {
    state.usage = { input_tokens: evt.usage.prompt_tokens || 0, output_tokens: evt.usage.completion_tokens || 0 };
  }
}

function finalizeOpenAIStream(state, clientRes) {
  for (const tc of Object.values(state.toolCalls)) {
    let input = {};
    try { input = JSON.parse(tc.args); } catch {}
    state.blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    emit(clientRes, { type: 'content_block_stop', index: tc.index + 2 });
  }
  emit(clientRes, { type: 'content_block_stop', index: state.textStarted ? 1 : 0 });
  emit(clientRes, { type: 'message_delta', delta: { stop_reason: state.stopReason || 'end_turn' }, usage: state.usage || {} });
  emit(clientRes, { type: 'message_stop' });
}

// ============================================================
//  Streaming Proxy
// ============================================================

function proxyStream(endpoint, apiKey, body, clientRes, conv, account, injection, isAnthropic, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = JSON.stringify(body);

    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${apiKey}` };
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'POST', hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let errBody = '';
        proxyRes.on('data', c => errBody += c);
        proxyRes.on('end', () => {
          const errMsg = `${proxyRes.statusCode}: ${errBody.slice(0, 500)}`;
          emit(clientRes, { type: 'error', error: { message: errMsg } });
          if (opts.returnState) { resolve({ error: errMsg }); return; }
          clientRes.end();
          saveConv(conv);
          appendError({ ts: Date.now(), conv: conv.id, account: account.name, model: body.model, provider: isAnthropic ? 'anthropic' : 'openai', status: proxyRes.statusCode, message: errBody.slice(0, 300) });
          console.error(`[gateway-err] ${proxyRes.statusCode} account=${account.name} ${errBody.slice(0, 100)}`);
          resolve();
        });
        return;
      }

      const state = {
        fullText: '', thinkingText: '', model: '', usage: null,
        blocks: [], blockType: '', blockData: {}, stopReason: null,
        started: false, textStarted: false, toolCalls: {}
      };

      let buffer = '';
      proxyRes.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            if (!isAnthropic) finalizeOpenAIStream(state, clientRes);
            continue;
          }

          try {
            const evt = JSON.parse(data);
            if (isAnthropic) {
              handleAnthropicChunk(evt, state, clientRes, line);
            } else {
              handleOpenAIChunk(evt, state, clientRes);
            }
          } catch {}
        }
      });

      proxyRes.on('end', async () => {
        if (buffer.startsWith('data: ')) clientRes.write(buffer + '\n\n');
        if (opts.returnState) { resolve({ stopReason: state.stopReason, blocks: state.blocks, state }); return; }
        clientRes.end();

        // Persist cache stats
        const cacheRead = state.usage?.cache_read_input_tokens || 0;
        const cacheCreate = state.usage?.cache_creation_input_tokens || 0;
        const inputTotal = state.usage?.input_tokens || 0;
        if (cacheRead > 0 || cacheCreate > 0) {
          const hitRate = inputTotal > 0 ? Math.round(cacheRead / (cacheRead + inputTotal) * 100) : 0;
          console.log(cacheRead > 0 ? `[cache] HIT ${hitRate}% (${cacheRead}/${cacheRead + inputTotal})` : `[cache] MISS (created ${cacheCreate})`);
        }

        // Save assistant message with enriched metadata
        if (state.fullText || state.blocks.length) {
          const msg = {
            role: 'assistant', content: state.fullText,
            timestamp: Date.now(), account: account.name || 'unknown', model: state.model
          };
          if (state.thinkingText) msg.thinking = state.thinkingText;
          console.log(`[thinking] account=${account.name} thinking=${state.thinkingText ? state.thinkingText.length + "chars" : "none"} blocks=${state.blocks.map(b=>b.type).join(",")}`);
          if (state.blocks.length) msg.blocks = state.blocks;
          if (state.usage) msg.usage = state.usage;
          if (injection.facts_injected || injection.semantic_hits) {
            msg.memoryHits = Math.max(injection.facts_injected || 0, injection.semantic_hits || 0);
          }
          if (injection.memory_ids?.length) {
            msg.memoryIds = injection.memory_ids;
          }
          conv.messages.push(msg);
        }

        saveConv(conv);

        // Async: compress image in user message (replace base64 with description)
        const userMsgIdx = conv.messages.length - 2;
        if (userMsgIdx >= 0 && Array.isArray(conv.messages[userMsgIdx]?.content) &&
            conv.messages[userMsgIdx].content.some(b => b.type === 'image')) {
          compressImageMessage(conv, userMsgIdx).catch(e => console.warn('[img-compress]', e.message));
        }

        // Persist request stat
        appendStat({
          ts: Date.now(), conv: conv.id, account: account.name,
          model: state.model, provider: isAnthropic ? 'anthropic' : 'openai',
          usage: state.usage || {}, cacheRead, cacheCreate, inputTotal,
          memoryHits: injection.facts_injected || 0,
          semanticHits: injection.semantic_hits || 0
        });

        // Auto-ingest <mem> tags
        if (state.fullText.includes('<mem')) {
          try {
            await fetch('http://127.0.0.1:3800/ingest', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: state.fullText })
            });
          } catch {}
        }

        await checkCycle(conv, account);
        resolve();
      });
    });

    req.on('error', e => {
      appendError({ ts: Date.now(), conv: conv.id, account: account.name, model: body.model, provider: isAnthropic ? 'anthropic' : 'openai', status: 0, message: e.message });
      console.error('[gateway-err] connection:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}


// ============================================================
//  Built-in Tools — executed in-process, no MCP protocol involved.
//  Definitions must stay byte-identical (tools lead the cached prompt prefix).
// ============================================================

const BUILTIN_TOOLS = [{
  name: 'exec',
  description: '在VPS上执行shell命令（你住的这台服务器，ubuntu用户，家目录/home/ubuntu）。返回stdout和stderr。60秒超时，适合查状态、读写文件、curl等日常操作；长任务用nohup放后台。',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell命令' }
    },
    required: ['command']
  }
}, {
  name: 'recall',
  description: '搜索你们的长期记忆并返回原文。两层数据：vault（精选记忆条目）+ archive（全部聊天原文的逐字存档），语义检索默认两层都搜。<memory_index>里是和当前话题相关的记忆目录（只有标题）——想看条目细节、或想搜目录之外的内容时用这个。exact=true按原文逐字检索（适合找"她原话怎么说的"，需要至少3个字）。问到"最近/上周"这类时间问题时自己换算日期填after/before。存档命中会带conv_id，把它传回来可以在那场对话里继续深挖。',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词，自然语言或关键词' },
      exact: { type: 'boolean', description: 'true=原文逐字检索(FTS)，省略=语义检索' },
      after: { type: 'string', description: '只看此日期之后(YYYY-MM-DD)，作用于archive层' },
      before: { type: 'string', description: '只看此日期之前(YYYY-MM-DD)，作用于archive层' },
      conv_id: { type: 'string', description: '只搜这一场对话的存档（用之前命中带的conv_id）' }
    },
    required: ['query']
  }
}];

async function callBuiltinTool(name, input) {
  if (name === 'exec') {
    const cmd = (input?.command || '').trim();
    if (!cmd) return '(empty command)';
    return new Promise(resolve => {
      execShell(cmd, { timeout: 60000, maxBuffer: 1024 * 1024, cwd: '/home/ubuntu' }, (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? '\n[stderr] ' + stderr : '');
        if (err && !out) out = 'error: ' + err.message;
        else if (err?.killed) out += '\n[killed: 60s timeout]';
        if (out.length > 8000) out = out.slice(0, 8000) + '\n…(truncated)';
        resolve(out.trim() || '(no output)');
      });
    });
  }
  if (name !== 'recall') return null;  // not ours — fall through to MCP
  try {
    const q = (input?.query || '').trim();
    if (!q) return '(empty query)';
    if (input?.exact) {
      const r = await fetch('http://127.0.0.1:3900/raw-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, n: 6 }),
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (!d.results?.length) return '原文检索无结果。提示：逐字匹配整个短语、至少3个字；可换更短的词组，或去掉exact用语义检索。';
      return d.results.map(x => `[${x.date || '?'} ${x.source || ''} ${x.role || ''}] ${x.content}`).join('\n---\n');
    }
    // 两层并查：vault（精选）+ archive（聊天原文逐字存档）。
    // conv_id/after/before 只对 archive 有意义；指定了 conv_id 就不查 vault。
    const archiveBody = { query: q, n: 4 };
    if (input?.after) archiveBody.after = input.after;
    if (input?.before) archiveBody.before = input.before;
    if (input?.conv_id) archiveBody.conv_id = input.conv_id;
    const wantVault = !input?.conv_id;
    const [vaultRes, archRes] = await Promise.all([
      wantVault ? fetch('http://127.0.0.1:3900/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, n: 4 }),
        signal: AbortSignal.timeout(10000)
      }).then(r => r.json()).catch(e => ({ error: e.message })) : Promise.resolve(null),
      fetch('http://127.0.0.1:3900/archive-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archiveBody),
        signal: AbortSignal.timeout(10000)
      }).then(r => r.json()).catch(e => ({ error: e.message }))
    ]);
    const parts = [];
    if (vaultRes?.results?.length) {
      parts.push(vaultRes.results.map(x => `[${x.metadata?.date || '?'} ${x.metadata?.category || ''}] ${x.document}`).join('\n---\n'));
    }
    if (archRes?.results?.length) {
      parts.push('——聊天原文存档——\n' + archRes.results.map(x => `${x.document}\n(conv_id=${x.metadata?.conv_id})`).join('\n---\n'));
    }
    if (!parts.length) return '没有找到相关记忆' + (input?.after || input?.before ? '（试试放宽日期范围）' : '');
    return parts.join('\n\n');
  } catch (e) {
    return 'recall失败: ' + e.message;
  }
}

// ============================================================
//  MCP Tool Execution (server-side)
// ============================================================

let mcpToolCache = null;
let mcpToolCacheTime = 0;
// Last fully-successful fetch, keyed to the settings that produced it.
// Survives cache clears (getMcpStatus nulls mcpToolCache on every refresh).
let mcpLastGood = null;  // { urls: string, tools: [] }

async function getMcpTools(settings) {
  if (mcpToolCache && Date.now() - mcpToolCacheTime < 300000) return mcpToolCache;
  const urlsRaw = settings.mcpServers || '';
  const urls = urlsRaw.split('\n').filter(u => u.trim());
  if (!urls.length) { mcpToolCache = []; mcpToolCacheTime = Date.now(); mcpLastGood = null; return []; }

  const tools = [];
  let failed = 0;
  for (const rawUrl of urls) {
    const url = rawUrl.includes('|') ? rawUrl.split('|').pop().trim() : rawUrl.trim();
    try {
      const initRes = await fetch(url, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 0, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'paramecium-gateway', version: '1.0'}}}),
        signal: AbortSignal.timeout(8000)
      });
      if (!initRes.ok) { failed++; continue; }
      const ct = initRes.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { failed++; continue; }

      await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}}), signal: AbortSignal.timeout(8000)});

      const toolsRes = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}), signal: AbortSignal.timeout(8000)});
      const toolsData = await toolsRes.json();
      for (const t of (toolsData.result?.tools || [])) {
        tools.push({ name: t.name, description: t.description || '', input_schema: t.inputSchema || {type: 'object', properties: {}}, _url: url });
      }
    } catch(e) { failed++; console.warn('[mcp] connect failed:', url, e.message); }
  }

  // 2026-06-11: tools lead the cached prompt prefix — a flaky server that
  // shrinks the list busts the entire cache for 5 min. On partial failure,
  // keep serving the last-known-good list for this same config.
  if (failed > 0 && mcpLastGood && mcpLastGood.urls === urlsRaw && tools.length < mcpLastGood.tools.length) {
    console.warn(`[mcp] ${failed} server(s) failed, got ${tools.length}/${mcpLastGood.tools.length} tools — keeping last-known-good list`);
    mcpToolCache = mcpLastGood.tools;
    mcpToolCacheTime = Date.now();
    return mcpToolCache;
  }

  if (failed === 0) mcpLastGood = { urls: urlsRaw, tools };
  mcpToolCache = tools;
  mcpToolCacheTime = Date.now();
  if (tools.length) console.log('[mcp] ' + tools.length + ' tools from ' + urls.length + ' server(s)');
  return tools;
}

async function callMcpTool(name, input, tools) {
  const tool = tools.find(t => t.name === name);
  if (!tool) return 'Tool not found: ' + name;
  try {
    const res = await fetch(tool._url, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name, arguments: input}}),
      signal: AbortSignal.timeout(60000)  // match exec's 60s ceiling
    });
    const data = await res.json();
    if (data.error) return 'Error: ' + (data.error.message || JSON.stringify(data.error));
    return (data.result?.content || []).map(c => c.text || JSON.stringify(c)).join('\n') || 'OK';
  } catch(e) { return 'MCP error: ' + e.message; }
}

// ============================================================
//  Main Gateway Handler
// ============================================================

export async function handleGatewaySend(reqBody, res) {
  const { conversation_id, message, image_data, image_media_type, account: accountName, edit_at, retry } = reqBody;

  if (!conversation_id) {
    res.writeHead(400, sseHeaders());
    res.end('data: {"type":"error","error":{"message":"conversation_id required"}}\n\n');
    return;
  }

  const conv = loadConv(conversation_id);
  if (!conv) {
    res.writeHead(404, sseHeaders());
    res.end('data: {"type":"error","error":{"message":"conversation not found"}}\n\n');
    return;
  }

  const settings = loadSettings();
  const account = resolveAccount(settings, accountName);
  const isAnthropic = isAnthropicProvider(account);
  console.log(`[req] account=${accountName} resolved=${account.name} provider=${isAnthropic ? 'anthropic' : 'openai'}`);

  // Edit / Retry
  if (typeof edit_at === 'number' && edit_at >= 0 && edit_at < (conv.messages || []).length) {
    conv.messages = conv.messages.slice(0, edit_at);
  }
  if (retry && conv.messages?.length) {
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
  }
  if (!conv.messages) conv.messages = [];
  // 2026-06-11 fix: editing before the cycle anchor left cycleStart pointing
  // past the end (empty history window, stale BP3). Reset both — the raw
  // messages come back into the window and will re-compress naturally.
  if ((conv.cycleStart || 0) > conv.messages.length) {
    conv.cycleStart = 0;
    conv.instantSummary = '';
  }
  // Same for the web frontend's manual compression anchor
  if ((conv.compressedUpTo || 0) > conv.messages.length) {
    delete conv.compressedUpTo;
    delete conv.compressionSummary;
  }

  // User message
  conv.messages.push({
    role: 'user',
    content: image_data ? [
      { type: 'image', source: { type: 'base64', media_type: image_media_type || 'image/jpeg', data: image_data } },
      ...(message ? [{ type: 'text', text: message }] : [])
    ] : message,
    timestamp: Date.now()
  });

  // Memory injection
  const recentContext = conv.messages.filter(m => m.role === 'user').slice(-3)
    .map(m => typeof m.content === 'string' ? m.content : '').join(' ').trim();
  const lastReply = conv.messages.filter(m => m.role === 'assistant').slice(-1)
    .map(m => typeof m.content === 'string' ? m.content
      : Array.isArray(m.blocks) ? m.blocks.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
      : '').join('').trim().slice(0, 500);
  const injection = recentContext ? await getMemoryInjection(recentContext, lastReply) : { static: '', dynamic: '', memory_ids: [] };

  // Build request
  const systemBlocks = buildSystemBlocks(settings, injection, conv, isAnthropic);
  // History window starts at whichever anchor is furthest: auto cycle (cycleStart)
  // or the web frontend's manual compression (compressedUpTo). BP3 carries the summary.
  const histStart = Math.max(conv.cycleStart || 0, conv.compressedUpTo || 0);
  const historyMsgs = buildHistoryMessages(conv.messages.slice(histStart, -1), isAnthropic);
  const volatileCtx = buildVolatileContext(injection, conv);
  const currentMsg = buildCurrentUserMessage(message, image_data, image_media_type, getActiveStyle(settings), volatileCtx);

  const requestBody = {
    model: account.model || settings.model || 'claude-sonnet-4-20250514',
    max_tokens: 48000, stream: true,
    thinking: { type: 'enabled', budget_tokens: 32000 },
    system: systemBlocks,
    messages: [...historyMsgs, currentMsg]
  };

  const endpoint = resolveEndpoint(account, isAnthropic);
  if (isAnthropic) requestBody.metadata = { user_id: USER_ID };

  // Tools: built-ins (in-process, Anthropic only) + MCP
  const mcpTools = await getMcpTools(settings);
  const toolDefs = [
    ...(isAnthropic ? BUILTIN_TOOLS : []),
    ...mcpTools.map(t => ({name: t.name, description: t.description, input_schema: t.input_schema}))
  ];
  if (toolDefs.length) {
    requestBody.tools = toolDefs;
  }

  let finalBody = requestBody;
  if (!isAnthropic) {
    finalBody = convertToOpenAIBody(requestBody);
    console.log('[openai-compat] -> ' + endpoint + ' model=' + finalBody.model);
  }

  console.log('[gateway-req] account=' + account.name + ' model=' + requestBody.model + ' tools=' + toolDefs.length + ' msgs=' + requestBody.messages.length);
  res.writeHead(200, sseHeaders());

  // SSE keepalive: tool execution (exec can run up to 60s) sends no bytes,
  // which trips nginx/Cloudflare idle timeouts (~60s/100s) → client sees 504.
  // Only ping when the stream has been idle, so a ping can never land inside
  // a partially-flushed event from proxyStream.
  const _origWrite = res.write.bind(res);
  let _lastWrite = Date.now();
  res.write = (...a) => { _lastWrite = Date.now(); return _origWrite(...a); };
  const _pingTimer = setInterval(() => {
    if (!res.writableEnded && Date.now() - _lastWrite > 14000) res.write(': ping\n\n');
  }, 5000);
  res.once('close', () => clearInterval(_pingTimer));

  if (toolDefs.length > 0 && isAnthropic) {
    // === Tool loop mode ===
    let maxLoops = 10;
    let loopMessages = [...historyMsgs, currentMsg];
    let allBlocks = [];
    let fullText = '';
    let thinkingText = '';
    let lastModel = '';
    let lastUsage = null;

    try {
      while (maxLoops-- > 0) {
        const loopBody = { ...requestBody, messages: loopMessages };
        const result = await proxyStream(endpoint, account.apiKey || settings.apiKey || '', loopBody, res, conv, account, injection, isAnthropic, { returnState: true });
        if (!result || result.error) { console.error('[mcp] stream error:', result?.error); break; }

        allBlocks.push(...result.blocks);
        fullText += result.state.fullText;
        thinkingText += result.state.thinkingText || '';
        lastModel = result.state.model || lastModel;
        if (result.state.usage) {
          if (!lastUsage) {
            lastUsage = { ...result.state.usage };
            const cr = result.state.usage.cache_read_input_tokens || 0;
            const cc = result.state.usage.cache_creation_input_tokens || 0;
            const it = result.state.usage.input_tokens || 0;
            if (cr > 0 || cc > 0) {
              const hitRate = (cr + it) > 0 ? Math.round(cr / (cr + it) * 100) : 0;
              console.log(cr > 0 ? `[cache/tool] HIT ${hitRate}% (${cr}/${cr + it})` : `[cache/tool] MISS (created ${cc})`);
            }
          } else {
            lastUsage.output_tokens = (lastUsage.output_tokens || 0) + (result.state.usage.output_tokens || 0);
            if (result.state.usage.input_tokens) lastUsage.input_tokens = result.state.usage.input_tokens;
          }
        }

        if (result.stopReason !== 'tool_use') break;

        const toolUseBlocks = result.blocks.filter(b => b.type === 'tool_use');
        if (!toolUseBlocks.length) break;
        console.log('[mcp] executing ' + toolUseBlocks.length + ' tool(s): ' + toolUseBlocks.map(b => b.name).join(', '));

        const assistantContent = result.blocks.map(b => {
          if (b.type === 'tool_use') return {type: 'tool_use', id: b.id, name: b.name, input: b.input};
          if (b.type === 'thinking') { const d = {type: 'thinking', thinking: b.thinking || ''}; if (b.signature) d.signature = b.signature; return d; }
          return {type: 'text', text: b.text || ''};
        });
        loopMessages.push({role: 'assistant', content: assistantContent});

        const toolResults = [];
        for (const tub of toolUseBlocks) {
          const builtinResult = await callBuiltinTool(tub.name, tub.input);
          const resultText = builtinResult !== null ? builtinResult : await callMcpTool(tub.name, tub.input, mcpTools);
          tub.result = resultText;
          toolResults.push({type: 'tool_result', tool_use_id: tub.id, content: resultText});
          // Custom SSE event so the web client can render results live
          // (Anthropic-format parsers ignore unknown event types)
          emit(res, {type: 'gateway_tool_result', tool_use_id: tub.id, content: resultText.slice(0, 600)});
          console.log('[mcp] ' + tub.name + ' -> ' + resultText.slice(0, 100));
        }
        loopMessages.push({role: 'user', content: toolResults});
      }
    } catch(e) {
      console.error('[mcp] loop error:', e.message);
      emit(res, { type: 'error', error: { message: e.message || 'tool loop error' } });
    }

    if (fullText || allBlocks.length) {
      const msg = { role: 'assistant', content: fullText, timestamp: Date.now(), account: account.name, model: lastModel };
      if (thinkingText) msg.thinking = thinkingText;
      if (allBlocks.length) msg.blocks = allBlocks;
      if (lastUsage) msg.usage = lastUsage;
      if (injection.facts_injected || injection.semantic_hits) msg.memoryHits = Math.max(injection.facts_injected || 0, injection.semantic_hits || 0);
      if (injection.memory_ids?.length) msg.memoryIds = injection.memory_ids;
      conv.messages.push(msg);
    }
    res.end();
    saveConv(conv);
    // 2026-06-11 fix: image compression only lived in the non-tool-loop path,
    // so with MCP tools enabled it never ran — mirror it here.
    const toolUserIdx = conv.messages.length - 2;
    if (toolUserIdx >= 0 && Array.isArray(conv.messages[toolUserIdx]?.content) &&
        conv.messages[toolUserIdx].content.some(b => b.type === 'image')) {
      compressImageMessage(conv, toolUserIdx).catch(e => console.warn('[img-compress]', e.message));
    }
    const _cr = lastUsage?.cache_read_input_tokens || 0;
    const _cc = lastUsage?.cache_creation_input_tokens || 0;
    const _it = lastUsage?.input_tokens || 0;
    appendStat({ ts: Date.now(), conv: conv.id, account: account.name, model: lastModel, provider: 'anthropic', usage: lastUsage || {}, cacheRead: _cr, cacheCreate: _cc, inputTotal: _it, memoryHits: injection.facts_injected || 0, semanticHits: injection.semantic_hits || 0 });
    if (fullText.includes('<mem')) {
      try { await fetch('http://127.0.0.1:3800/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: fullText }) }); } catch {}
    }
    await checkCycle(conv, account);

  } else {
    // === Original path — no tools or non-Anthropic ===
    try {
      await proxyStream(endpoint, account.apiKey || settings.apiKey || '', finalBody, res, conv, account, injection, isAnthropic);
    } catch (e) {
      emit(res, { type: 'error', error: { message: e.message || 'proxy error' } });
      res.end();
      saveConv(conv);
      appendError({ ts: Date.now(), conv: conv.id, account: account.name, model: finalBody.model, provider: isAnthropic ? 'anthropic' : 'openai', status: 0, message: e.message || 'proxy error' });
    }
  }
}

// ============================================================
//  Gateway Stats API
// ============================================================

export function getGatewayStats() {
  const stats = loadStats();
  const now = Date.now();
  const last24h = stats.requests.filter(r => now - r.ts < 86400000);
  const last7d = stats.requests.filter(r => now - r.ts < 7 * 86400000);

  const totalRequests = last24h.length;
  const cacheHits = last24h.filter(r => r.cacheRead > 0).length;
  const cacheMisses = last24h.filter(r => r.cacheRead === 0 && r.cacheCreate > 0).length;
  const avgHitRate = last24h.length ? Math.round(last24h.reduce((s, r) => {
    const total = (r.cacheRead || 0) + (r.inputTotal || 0);
    return s + (total > 0 ? (r.cacheRead || 0) / total * 100 : 0);
  }, 0) / last24h.length) : 0;

  const byProvider = {};
  for (const r of last24h) {
    const p = r.provider || 'unknown';
    byProvider[p] = (byProvider[p] || 0) + 1;
  }

  const byAccount = {};
  for (const r of last24h) {
    const a = r.account || 'unknown';
    byAccount[a] = (byAccount[a] || 0) + 1;
  }

  const tokenUsage = last24h.reduce((s, r) => ({
    input: s.input + (r.usage?.input_tokens || 0),
    output: s.output + (r.usage?.output_tokens || 0),
    cacheRead: s.cacheRead + (r.cacheRead || 0),
    cacheCreate: s.cacheCreate + (r.cacheCreate || 0)
  }), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

  const recentRequests = stats.requests.slice(-30).reverse().map(r => ({
    ts: r.ts, conv: r.conv?.slice(-3), account: r.account, model: r.model,
    provider: r.provider,
    cacheRead: r.cacheRead || 0, cacheCreate: r.cacheCreate || 0, inputTotal: r.inputTotal || 0,
    outputTokens: r.usage?.output_tokens || 0,
    memoryHits: r.memoryHits, semanticHits: r.semanticHits
  }));

  const recentErrors = (stats.errors || []).slice(-20).reverse().map(e => ({
    ts: e.ts, conv: e.conv?.slice(-3), account: e.account, model: e.model,
    provider: e.provider, status: e.status, message: e.message
  }));

  const cacheTimeline = stats.requests.slice(-50).map(r => ({
    ts: r.ts, read: r.cacheRead || 0, create: r.cacheCreate || 0, input: r.inputTotal || 0
  }));

  return {
    period: '24h', totalRequests, cacheHits, cacheMisses, avgHitRate,
    byProvider, byAccount, tokenUsage, recentRequests, recentErrors, cacheTimeline,
    accounts: loadSettings().accounts || [],
    weekly: { total: last7d.length },
    totalErrors: (stats.errors || []).filter(e => now - e.ts < 86400000).length
  };
}

// ============================================================
//  Cycle Engine
// ============================================================

function estimateTokensCjk(messages) {
  // 2026-06-10: CJK chars ~1 token each, ASCII ~1/4 — chars/2 underestimated
  // Chinese ~2x, so the 60K cycle threshold actually fired around 120K.
  let t = 0;
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content :
      Array.isArray(m.content) ? m.content.map(b => b.text || b.thinking || '').join('') :
      JSON.stringify(m.content || '');
    for (const ch of text) {
      const c = ch.codePointAt(0);
      t += (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x30FF) || (c >= 0xFF00 && c <= 0xFFEF) ? 1 : 0.25;
    }
  }
  return Math.ceil(t);
}

async function checkCycle(conv, account) {
  const cycleStart = Math.max(conv.cycleStart || 0, conv.compressedUpTo || 0);
  const cycleMessages = conv.messages.slice(cycleStart);
  const tokenEstimate = estimateTokensCjk(cycleMessages);
  if (tokenEstimate < CYCLE_TOKEN_THRESHOLD) return;

  const toSummarize = cycleMessages.slice(0, cycleMessages.length - RELAY_COUNT);
  const relay = cycleMessages.slice(cycleMessages.length - RELAY_COUNT);
  if (toSummarize.length < 4) return;

  console.log(`[cycle] Token estimate ${tokenEstimate} >= ${CYCLE_TOKEN_THRESHOLD}, compressing ${toSummarize.length} messages`);

  // 2026-06-11 fix: when summaries stack ≥3 deep, feed the old summary INTO the
  // summarizer so it actually merges — previously the replacement dropped it.
  // compressionSummary fallback: web's manual summary seeds the stack so its
  // content survives once auto-cycling takes over.
  const existingSummary = conv.instantSummary || conv.compressionSummary || '';
  const recompress = !!existingSummary && existingSummary.split('\n\n---\n\n').length >= 3;

  const convoInput = toSummarize.map(m => {
    const prefix = m.role === 'user' ? '用户: ' : '助手: ';
    const text = typeof m.content === 'string' ? m.content : (m.content?.text || JSON.stringify(m.content)).slice(0, 500);
    return prefix + text;
  }).join('\n\n');
  const summaryInput = recompress
    ? '[已有摘要]\n' + existingSummary + '\n\n[新对话]\n' + convoInput
    : convoInput;
  const summarySystem = recompress
    ? '你是一个对话摘要助手。下面有一份已有摘要和一段新对话。请把两者合并成一份摘要：保留关键信息、情感基调、做出的承诺和讨论的话题，已有摘要中的重要内容不要丢失。使用与对话相同的语言。控制在800字以内。'
    : '你是一个对话摘要助手。请将以下对话压缩成简洁的摘要，保留关键信息、情感基调、做出的承诺和讨论的话题。使用与对话相同的语言。控制在500字以内。';

  try {
    const orKey = (loadSettings().accounts || []).find(a => a.name === 'openrouter')?.apiKey || '';

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${orKey}`
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-pro', max_tokens: 1500,
        messages: [
          { role: 'system', content: summarySystem },
          { role: 'user', content: summaryInput }
        ]
      })
    });

    if (resp.ok) {
      const result = await resp.json();
      const text = result.choices?.[0]?.message?.content || '';
      if (text) {
        // 2026-06-11: anchor-based window — don't delete old messages (keeps
        // raw archive intact). Just advance cycleStart past summarized msgs.
        // BP3 carries the summary; history window starts from new anchor.
        if (recompress) {
          // Merged summary already incorporates the old one (see summaryInput)
          conv.instantSummary = text;
        } else {
          conv.instantSummary = existingSummary ? existingSummary + '\n\n---\n\n' + text : text;
        }
        conv.cycleStart = conv.messages.length - RELAY_COUNT;
        saveConv(conv);
        console.log(`[cycle] Compressed ${toSummarize.length} messages for ${conv.id}`);
      }
    }
  } catch (e) {
    console.warn('[cycle] Failed:', e.message);
  }
}


// ============================================================
//  Context Inspector — returns current BP block contents
// ============================================================

export async function getContextBlocks(convId) {
  const settings = loadSettings();
  const conv = convId ? loadConv(convId) : null;

  const recentContext = conv?.messages?.filter(m => m.role === 'user').slice(-3)
    .map(m => typeof m.content === 'string' ? m.content : '').join(' ').trim() || '';
  const lastReply = (conv?.messages || []).filter(m => m.role === 'assistant').slice(-1)
    .map(m => typeof m.content === 'string' ? m.content
      : Array.isArray(m.blocks) ? m.blocks.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
      : '').join('').trim().slice(0, 500);
  const injection = await getMemoryInjection(recentContext || "general context", lastReply);

  // BP1: Personality + profiles
  let bp1 = settings.systemPrompt || '';
  if (injection.static) bp1 += (bp1 ? '\n\n' : '') + injection.static;

  // BP2: Recent diary/memo from vault
  const bp2 = getRecentDiaries(2);

  // BP3: Session context — summary only (stable, cacheable)
  const summary = conv?.instantSummary || conv?.compressionSummary || '';

  // Volatile context — time + dynamic memories (changes every message, never cached)
  let volatileParts = ['当前时间: ' + nowBeijing()];
  if (injection.dynamic) volatileParts.push(injection.dynamic);
  const volatile = volatileParts.join('\n');

  // History messages count
  const historyCount = conv ? Math.max(0, (conv.messages || []).length - 1) : 0;

  return {
    bp1: { label: 'BP1 — personality + profiles', text: bp1, cached: true },
    bp2: { label: 'BP2 — daily summary', text: bp2, cached: true },
    bp3: { label: 'BP3 — session summary', text: summary, cached: true },
    bp4: { label: 'BP4 — rolling breakpoint', text: '(on last history message)', cached: true },
    volatile: { label: 'volatile — time + recall', text: volatile, cached: false },
    meta: {
      historyMessages: historyCount,
      cycleStart: conv?.cycleStart || 0,
      convId: convId || null
    }
  };
}

// ============================================================
//  MCP Status API
// ============================================================

export async function getMcpStatus(forceRefresh = false) {
  const settings = loadSettings();
  const urls = (settings.mcpServers || '').split('\n').filter(u => u.trim());
  if (!urls.length) return { servers: [] };

  if (forceRefresh) { mcpToolCache = null; mcpToolCacheTime = 0; }

  const servers = [];
  for (const rawUrl of urls) {
    const name = rawUrl.includes('|') ? rawUrl.split('|')[0].trim() : '';
    const url = rawUrl.includes('|') ? rawUrl.split('|').pop().trim() : rawUrl.trim();
    const entry = { url, name: name || url, status: 'disconnected', tools: [] };

    try {
      const initRes = await fetch(url, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 0, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'paramecium-gateway', version: '1.0'}}}),
        signal: AbortSignal.timeout(8000)
      });
      if (!initRes.ok) { entry.status = 'failed'; servers.push(entry); continue; }
      const ct = initRes.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { entry.status = 'failed'; servers.push(entry); continue; }
      const initData = await initRes.json();
      entry.serverName = initData.result?.serverInfo?.name || '';

      await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}}), signal: AbortSignal.timeout(8000)});

      const toolsRes = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}), signal: AbortSignal.timeout(8000)});
      const toolsData = await toolsRes.json();
      entry.tools = (toolsData.result?.tools || []).map(t => t.name);
      entry.status = 'connected';
    } catch(e) {
      entry.status = 'failed';
      entry.error = e.message;
    }
    servers.push(entry);
  }

  // Refresh tool cache while we're at it
  mcpToolCache = null; mcpToolCacheTime = 0;
  await getMcpTools(settings);

  return { servers };
}
