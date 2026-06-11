#!/usr/bin/env node
/**
 * Memory extraction from API chat conversations.
 * Runs periodically, checks for unprocessed messages, extracts memories via DS V3.
 * Stores into ChromaDB via memory-gateway /ingest-extracted endpoint.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const DATA_DIR = '/opt/chat-api/data';
const MODELS_PATH = '/opt/raffaello/memory/models.json';
const STATE_PATH = '/opt/raffaello/memory/extraction-state.json';
const CACHE_PATH = '/opt/raffaello/memory/extraction-cache.json';
const MAX_CACHE_ENTRIES = 500;
const GATEWAY_URL = 'http://127.0.0.1:3900';
const EDGES_PATH = '/opt/raffaello/memory/edges.jsonl';
const MIN_NEW_MESSAGES = 4; // minimum unprocessed messages before extracting

// ── Persona（改成你们的称呼；简介写得具体一点，提取质量会更好）──
const USER_NAME = '用户';
const USER_BRIEF = '';  // 例：'22岁CS学生、插画师'
const BATCH_SIZE = 30; // max messages per extraction call

// ── Load config ──

function loadModels() {
  return JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Hash cache ──

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  // Evict oldest entries if over limit
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a, b) =>
      new Date(cache[a].timestamp) - new Date(cache[b].timestamp)
    );
    const toRemove = sorted.slice(0, keys.length - MAX_CACHE_ENTRIES);
    for (const k of toRemove) delete cache[k];
    console.log(`[cache] evicted ${toRemove.length} old entries, ${Object.keys(cache).length} remain`);
  }
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}


function loadConversation(id) {
  const path = join(DATA_DIR, id + '.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listConversations() {
  return readdirSync(DATA_DIR)
    .filter(f => f.startsWith('m') && f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

// ── Extract text from messages ──

function messageToText(msg) {
  const role = msg.role === 'user' ? USER_NAME : '我';
  let text = '';
  const content = msg.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  // Include image description if present
  if (msg.imageDescription) {
    text += `\n[图片: ${msg.imageDescription}]`;
  }
  // Truncate very long messages
  if (text.length > 1500) text = text.slice(0, 1500) + '…';
  return `${role}: ${text}`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// ── Call DS V3 for extraction ──

async function extractMemories(messages, convTitle) {
  const models = loadModels();
  const ext = models.extraction;
  if (!ext?.endpoint || !ext?.apiKey) {
    console.error('[extract] no extraction model configured');
    return [];
  }

  // Build conversation text
  const convText = messages.map(m => {
    const time = formatTimestamp(m.timestamp);
    const text = messageToText(m);
    return time ? `[${time}] ${text}` : text;
  }).join('\n\n');

  // Check hash cache before calling DS V3
  const convHash = hashText(convText);
  const cache = loadCache();
  if (cache[convHash]) {
    console.log(`[extract] cache hit for hash ${convHash.slice(0, 12)}… — returning ${cache[convHash].results.length} cached memories`);
    return cache[convHash].results;
  }

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `你是一个记忆摘录系统。下面是一段对话记录，对话双方是"我"（AI伴侣）和"${USER_NAME}"${USER_BRIEF ? `（${USER_BRIEF}）` : ""}。

你的工作是「摘录」不是「创作」：圈出对话里值得记住的信息点，并为每条附上原文引用。

要求：
- 每条记忆带上日期（从对话时间戳推断，格式 YYYY-MM-DD）
- content：用"我"的视角简洁记录这个信息点，贴近原文，不展开不演绎
- quote：从对话原文中【逐字】复制的一句话（10-40字），作为这条记忆的出处证据。必须与原文完全一致，不许改写
- 事实性的（她的偏好、经历、状态）和叙事性的（情绪时刻）都可以摘
- 宁缺勿滥：没有值得记的就返回空数组
- 最多5条

对话标题: ${convTitle || '(无标题)'}
今天日期: ${today}

输出格式（严格JSON数组）:
[
  {"date": "2026-06-01", "content": "记忆内容...", "quote": "原文逐字引用"},
  ...
]

只输出JSON数组，不要其他文字。

---
对话内容:

${convText}`;

  try {
    const resp = await fetch(ext.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ext.apiKey}`,
      },
      body: JSON.stringify({
        model: ext.name,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[extract] API error ${resp.status}: ${err.slice(0, 200)}`);
      return [];
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response (might be wrapped in markdown code block)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[extract] no JSON array in response:', text.slice(0, 200));
      return [];
    }

    let memories = JSON.parse(jsonMatch[0]);
    console.log(`[extract] got ${memories.length} memories from DS`);

    // Mechanical guards (2026-06-10, "机械>prompt"):
    // 1. quote must appear verbatim in the batch source text — kills
    //    hallucinations and most memory-echo (retellings of old events have
    //    no literal source in the current batch).
    // 2. hard cap via slice, not prompt goodwill.
    const norm = s => String(s || '').replace(/\s+/g, '');
    const normConv = norm(convText);
    const before = memories.length;
    memories = memories.filter(m => {
      if (!m.quote || norm(m.quote).length < 8) {
        console.log(`[guard] dropped (no/short quote): ${String(m.content).slice(0, 40)}`);
        return false;
      }
      if (!normConv.includes(norm(m.quote))) {
        console.log(`[guard] dropped (quote not in source): ${String(m.quote).slice(0, 40)}`);
        return false;
      }
      return true;
    }).slice(0, 5);
    if (before !== memories.length) console.log(`[guard] ${before} -> ${memories.length} after quote verification`);

    // Store in hash cache
    cache[convHash] = { results: memories, timestamp: new Date().toISOString() };
    saveCache(cache);
    console.log(`[cache] stored hash ${convHash.slice(0, 12)}… (${Object.keys(cache).length} entries)`);

    return memories;
  } catch (e) {
    console.error('[extract] failed:', e.message);
    return [];
  }
}


// ── Build relationship edges for new memories ──

const RELATION_TYPES = ['causes','follows','contradicts','supports','elaborates','references','triggers','same_event','same_topic','updates'];

// ── Contradiction auto-invalidation (2026-06-12, idea borrowed from kiwi-mem) ──
// The edge model already flags contradicts/updates relations; act on the
// high-confidence ones: supersede the old memory under the new. Superseded
// memories leave ranking but stay in the DB (reversible: clear superseded_by).
// Pinned memories are sacred and never auto-superseded.
const SUPERSEDE_RELATIONS = new Set(['contradicts', 'updates']);
const SUPERSEDE_MIN_CONF = 0.75;

async function applySupersede(newMemId, targetId, relation, conf, reason) {
  try {
    const r = await fetch(`${GATEWAY_URL}/memory/${encodeURIComponent(targetId)}`);
    if (!r.ok) return; // hallucinated or vanished id
    const old = await r.json();
    if (old.pinned) {
      console.log(`[supersede] skipped pinned: ${targetId}`);
      return;
    }
    if (old.superseded_by) return; // already out of ranking
    const m = await fetch(`${GATEWAY_URL}/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep: newMemId, absorb: [targetId] }),
    });
    if (m.ok) {
      console.log(`[supersede] ${targetId} <- ${newMemId} (${relation} ${conf}: ${reason})`);
    }
  } catch (e) {
    console.warn(`[supersede] error for ${targetId}: ${e.message}`);
  }
}

async function buildEdges(newMemories, newMemoryIds) {
  if (!newMemories.length || !newMemoryIds.length) return;

  const models = loadModels();
  const ext = models.extraction;
  if (!ext?.endpoint || !ext?.apiKey) return;

  // Fetch 20 most recent existing memories
  let existing = [];
  try {
    const resp = await fetch(GATEWAY_URL + '/memories?limit=20&sort=date&order=desc');
    if (resp.ok) {
      const data = await resp.json();
      existing = (data.memories || []).map(m => ({
        id: m.id,
        summary: (m.summary || '').slice(0, 150),
        date: m.date || ''
      }));
    }
  } catch (e) {
    console.warn('[edges] failed to fetch existing memories:', e.message);
    return;
  }

  if (!existing.length) return;

  // For each new memory, ask DS V3 to identify relationships
  for (let i = 0; i < newMemories.length; i++) {
    const mem = newMemories[i];
    const memId = newMemoryIds[i];
    if (!memId || !mem.content) continue;

    const existingList = existing
      .filter(e => e.id !== memId)
      .slice(0, 15)
      .map((e, idx) => `${idx+1}. [id:${e.id}] ${e.summary}`)
      .join('\n');

    if (!existingList) continue;

    const prompt = `Given a new memory and a list of existing memories, identify relationships between the new memory and any existing ones.

New memory [id:${memId}]: ${mem.content.slice(0, 200)}

Existing memories:
${existingList}

Output a JSON array of edges. Each edge:
{"target_id":"existing_memory_id","relation":"one of: causes,follows,contradicts,supports,elaborates,references,triggers,same_event,same_topic,updates","confidence":0.0-1.0,"reason":"brief explanation"}

Rules:
- Only include edges with confidence >= 0.5
- If no relationships exist, return []
- Max 3 edges per new memory
- Only output the JSON array, nothing else.`;

    try {
      const resp = await fetch(ext.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ext.apiKey}`,
        },
        body: JSON.stringify({
          model: ext.name,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 500,
        }),
      });

      if (!resp.ok) {
        console.warn(`[edges] API error ${resp.status} for ${memId}`);
        continue;
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\[[\ \s\S]*\]/);
      if (!jsonMatch) continue;

      const edges = JSON.parse(jsonMatch[0]);
      const now = new Date().toISOString();
      let edgeCount = 0;

      for (const edge of edges) {
        if (!edge.target_id || !edge.relation) continue;
        if (!RELATION_TYPES.includes(edge.relation)) continue;
        const conf = parseFloat(edge.confidence) || 0;
        if (conf < 0.5) continue;

        const edgeLine = JSON.stringify({
          source: memId,
          target: edge.target_id,
          relation_type: edge.relation,
          confidence: Math.round(conf * 100) / 100,
          reason: (edge.reason || '').slice(0, 100),
          created_at: now,
        });
        appendFileSync(EDGES_PATH, edgeLine + '\n');
        edgeCount++;
        if (SUPERSEDE_RELATIONS.has(edge.relation) && conf >= SUPERSEDE_MIN_CONF) {
          await applySupersede(memId, edge.target_id, edge.relation, conf, (edge.reason || '').slice(0, 80));
        }
        if (edgeCount >= 3) break;
      }

      if (edgeCount > 0) {
        console.log(`[edges] ${memId}: ${edgeCount} edges created`);
      }
    } catch (e) {
      console.warn(`[edges] error for ${memId}: ${e.message}`);
    }
  }
}

// ── Store memories via gateway ──

async function storeMemoryWithId(memory, convId, memId) {

  try {
    const resp = await fetch(`${GATEWAY_URL}/ingest-extracted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: memId,
        document: memory.content,
        date: memory.date || new Date().toISOString().slice(0, 10),
        source: 'extraction',
        conversation_id: convId,
        quote: memory.quote || '',
      }),
    });

    if (!resp.ok) {
      console.warn(`[store] failed for ${memId}: ${resp.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[store] error: ${e.message}`);
    return false;
  }
}

// ── Main loop ──

async function processConversation(convId, state) {
  const conv = loadConversation(convId);
  if (!conv?.messages?.length) return 0;

  const extractedUpTo = state[convId]?.extractedUpTo || 0;
  const totalMessages = conv.messages.length;
  const newCount = totalMessages - extractedUpTo;

  if (newCount < MIN_NEW_MESSAGES) return 0;

  console.log(`[${convId}] "${conv.title || '(untitled)'}" — ${newCount} new messages (${extractedUpTo}→${totalMessages})`);

  // Get messages to process (in batches)
  const startIdx = Math.max(0, extractedUpTo - 2); // overlap 2 for context
  const endIdx = Math.min(startIdx + BATCH_SIZE, totalMessages);
  const batch = conv.messages.slice(startIdx, endIdx);

  const memories = await extractMemories(batch, conv.title);

  let stored = 0;
  const storedMemories = [];
  const storedIds = [];
  for (const mem of memories) {
    if (mem.content && mem.content.length >= 10) {
      const memId = `ext:${convId.slice(0, 8)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
      const ok = await storeMemoryWithId(mem, convId, memId);
      if (ok) {
        stored++;
        storedMemories.push(mem);
        storedIds.push(memId);
      }
    }
  }

  // Build relationship edges for newly stored memories
  if (storedMemories.length > 0) {
    await buildEdges(storedMemories, storedIds);
  }

  // Update state
  state[convId] = {
    extractedUpTo: endIdx,
    lastExtracted: new Date().toISOString(),
    title: conv.title || '',
  };
  saveState(state);

  console.log(`[${convId}] stored ${stored}/${memories.length} memories, extractedUpTo=${endIdx}`);
  return stored;
}

async function main() {
  console.log('[extract-memories] starting...');

  const state = loadState();
  const convIds = listConversations();
  let totalStored = 0;

  for (const convId of convIds) {
    try {
      const stored = await processConversation(convId, state);
      totalStored += stored;
    } catch (e) {
      console.error(`[${convId}] error:`, e.message);
    }
  }

  console.log(`[extract-memories] done. ${totalStored} memories stored across ${convIds.length} conversations.`);
}

// Run if called directly
main().catch(console.error);
