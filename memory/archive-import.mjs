#!/usr/bin/env node
/**
 * Archive layer importer — chat conversations → window chunks → chat_archive (3900).
 *
 * No AI anywhere in this pipeline: mechanical sentence splitting, verbatim text,
 * source pointers. The model only ever pays for windows that retrieval hits.
 *
 * Windowing: messages are split at sentence boundaries into segments (≤SEG_MAX
 * chars), consecutive segments are greedily packed into windows (≤WIN_MAX chars,
 * fits bge-small-zh's 512-token budget) with a 1-segment overlap so context
 * never cuts dead at a boundary. Speaker labels and dates are baked into the
 * window text itself — the vector knows who said it.
 *
 * Incremental: archive-state.json tracks per-conv message counts; a changed
 * conversation is re-windowed wholesale and replaces its old windows (cheap at
 * this scale, and immune to window-drift bugs).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const DATA_DIR = '/opt/chat-api/data';
const STATE_PATH = '/opt/raffaello/memory/archive-state.json';
const GATEWAY = 'http://127.0.0.1:3900';
const SEG_MAX = 350;
const WIN_MAX = 700;
const SKIP = new Set(['settings.json', 'gateway-stats.json', 'memory.json']);

// ── Persona（说话人名字会烤进窗口文本，改成你们的称呼）──
const USER_NAME = '用户';
const ASSISTANT_NAME = 'AI';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (b && b.type === 'text') return b.text || '';
      if (b && b.type === 'image') return '[图片]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function dateOf(ts, fallback) {
  const d = ts ? new Date(ts) : (fallback ? new Date(fallback) : null);
  if (!d || isNaN(d)) return '?';
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10); // Beijing
}

function segments(text) {
  const sents = text.split(/(?<=[。！？!?；\n])/).map(s => s.trim()).filter(Boolean);
  const segs = [];
  let cur = '';
  for (let s of sents) {
    while (s.length > SEG_MAX) { // run-on with no punctuation: hard split
      if (cur) { segs.push(cur); cur = ''; }
      segs.push(s.slice(0, SEG_MAX));
      s = s.slice(SEG_MAX);
    }
    if (cur && cur.length + s.length > SEG_MAX) { segs.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) segs.push(cur);
  return segs;
}

function windowsOf(conv) {
  const title = (conv.title || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const flat = [];
  for (const m of conv.messages || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = textOf(m.content).trim();
    if (!text) continue;
    const speaker = m.role === 'user' ? USER_NAME : ASSISTANT_NAME;
    const date = dateOf(m.timestamp, conv.created_at);
    for (const seg of segments(text)) flat.push({ speaker, date, seg });
  }
  const wins = [];
  let i = 0;
  while (i < flat.length) {
    let len = 0, j = i;
    const parts = [];
    while (j < flat.length && (len === 0 || len + flat[j].seg.length <= WIN_MAX)) {
      parts.push(flat[j]); len += flat[j].seg.length; j++;
    }
    const lines = [];
    let prevSpeaker = null;
    for (const p of parts) {
      if (p.speaker !== prevSpeaker) { lines.push(p.speaker + ': ' + p.seg); prevSpeaker = p.speaker; }
      else lines.push(p.seg);
    }
    const text = '[' + parts[0].date + ' · ' + title + ']\n' + lines.join('\n');
    wins.push({
      id: createHash('sha1').update(conv.id + ':' + i + ':' + text).digest('hex').slice(0, 24),
      text,
      metadata: {
        conv_id: conv.id, conv_title: title, date: parts[0].date,
        date_int: parseInt(parts[0].date.replace(/-/g, ''), 10) || 0,
        seg_start: i, seg_end: j - 1, layer: 'archive'
      }
    });
    if (j >= flat.length) break;
    i = j - 1; // 1-segment overlap
  }
  return wins;
}

async function main() {
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !SKIP.has(f));
  let totalWins = 0, changed = 0;
  for (const f of files) {
    let conv;
    try { conv = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')); } catch { continue; }
    if (!conv || !conv.id || !Array.isArray(conv.messages)) continue;
    if (state[conv.id] === conv.messages.length) continue;
    const wins = windowsOf(conv);
    const res = await fetch(GATEWAY + '/archive-ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_conv: conv.id, windows: wins })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) { console.error('[' + conv.id + '] ingest failed: ' + (d.error || res.status)); continue; }
    state[conv.id] = conv.messages.length;
    changed++; totalWins += wins.length;
    console.log('[' + conv.id + '] ' + conv.messages.length + ' msgs -> ' + wins.length + ' windows');
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log('[archive-import] done. ' + changed + ' conversations updated, ' + totalWins + ' windows ingested.');
}

main().catch(e => { console.error('[archive-import] fatal:', e.message); process.exit(1); });
