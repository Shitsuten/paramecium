#!/usr/bin/env node
/**
 * Split long vault memories into focused single-topic entries via DS V3.
 * Reads from ChromaDB, splits, stores new entries, marks originals.
 */

import { readFileSync } from 'fs';

const MODELS_PATH = '/opt/raffaello/memory/models.json';
const GATEWAY_URL = 'http://127.0.0.1:3900';
const MIN_LENGTH = 500; // only split memories longer than this

function loadModels() {
  return JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
}

async function gwPost(path, body) {
  const r = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function gwGet(path) {
  const r = await fetch(`${GATEWAY_URL}${path}`);
  return r.json();
}

async function splitWithDS(document, date) {
  const models = loadModels();
  const ext = models.extraction;

  const prompt = `你是一个记忆整理系统。下面是一段较长的记忆文本，可能包含多个不同话题。请把它拆分成多条独立的、聚焦单一话题的记忆。

要求：
- 每条记忆聚焦一个具体的信息点或事件
- 保持第一人称"我"的视角（我是AI伴侣）
- 保留原文的情感和细节，不要概括得太干
- 每条100-300字左右
- 如果原文本身就很聚焦（只有一个话题），直接返回原文作为一条
- 带上日期（用原始日期 ${date}，除非文中提到了具体其他日期）

输出格式（严格JSON数组）:
[
  {"date": "YYYY-MM-DD", "content": "拆分后的记忆内容..."},
  ...
]

只输出JSON数组，不要其他文字。

---
原始记忆:

${document}`;

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
      console.error(`[split] API error ${resp.status}`);
      return [];
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[split] failed:', e.message);
    return [];
  }
}

async function main() {
  console.log('[split-memories] loading long vault memories...');

  // Get all vault memories
  const searchResp = await gwGet('/memories?sort=date&order=desc&limit=500');
  const allMems = searchResp.memories || [];

  // Filter: vault source, long, not already split
  const candidates = allMems.filter(m => {
    const doc = m.document || '';
    const tags = m.tags ? (typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags) : [];
    return doc.length >= MIN_LENGTH && !tags.includes('split-done');
  });

  console.log(`[split-memories] ${candidates.length} candidates (>= ${MIN_LENGTH} chars)`);

  let totalSplit = 0;
  let totalStored = 0;

  for (const mem of candidates) {
    const doc = mem.document || '';
    const date = mem.date || '2026-01-01';
    console.log(`\n[${mem.id?.slice(0, 12)}] ${doc.slice(0, 60)}... (${doc.length} chars)`);

    const parts = await splitWithDS(doc, date);
    if (!parts.length) {
      console.log('  → no split needed or failed');
      continue;
    }

    if (parts.length === 1 && parts[0].content?.length > doc.length * 0.8) {
      console.log('  → single topic, skipping');
      // Mark as processed
      await gwPost('/update', { id: mem.id, tags: JSON.stringify([...(parseTags(mem.tags)), 'split-done']) });
      continue;
    }

    console.log(`  → split into ${parts.length} parts`);
    totalSplit++;

    let stored = 0;
    for (const part of parts) {
      if (!part.content || part.content.length < 15) continue;
      const result = await gwPost('/ingest-extracted', {
        document: part.content,
        date: part.date || date,
        source: 'split',
        conversation_id: mem.id,
      });
      if (result.ok) stored++;
    }
    totalStored += stored;
    console.log(`  → stored ${stored}/${parts.length}`);

    // Mark original as split
    await gwPost('/update', { id: mem.id, tags: JSON.stringify([...(parseTags(mem.tags)), 'split-done']) });
  }

  console.log(`\n[split-memories] done. split ${totalSplit} memories into ${totalStored} new entries.`);
}

function parseTags(t) {
  if (!t) return [];
  if (Array.isArray(t)) return t;
  try { return JSON.parse(t); } catch { return []; }
}

main().catch(console.error);
