#!/usr/bin/env python3
"""revault — vault 日记归位迁移（2026-06-12，一次性）

背景：split-memories.mjs（已退役）曾把长 vault 条目交给 DS V3 拆分，
产物没有逐字校验，36% 是转述（见 verify-splits-report.json）。
本工具按两层架构各归各位：

  phase l0     全部 vault 原文机械切窗 → chat_archive（装订工配方，零 AI）
  phase l1     split-done 的 vault 长文跑摘录管线（圈重点+逐字引用+机械校验）
  phase retire 2242 条 DS 拆分产物标 superseded（可逆，不删）
  phase dates  修两条坏日期（2026-21 / 2026-14）

每个 phase 幂等：l0 走 replace_conv，l1 跳过已有 vault-extract 的文档，
retire 只标没标过的。
"""
import chromadb, json, re, sys, hashlib, sqlite3, urllib.request, time

GATEWAY = "http://127.0.0.1:3900"
VEC = "/opt/raffaello/memory/vectors"
META = "/opt/raffaello/memory/meta.db"
SEG_MAX, WIN_MAX = 350, 700
RETIRE_MARK = "split-retirement-20260612"

def post(path, body):
    req = urllib.request.Request(GATEWAY + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req, timeout=120))

def vault_docs():
    col = chromadb.PersistentClient(path=VEC).get_collection("raffaello_memory")
    r = col.get(include=["documents", "metadatas"])
    out = []
    for i, d, m in zip(r["ids"], r["documents"], r["metadatas"]):
        if i.startswith("vault:"):
            out.append({"id": i, "doc": d or "", "meta": m or {}})
    return out

def tags_of(m):
    t = m.get("tags", "[]")
    if isinstance(t, list): return t
    try: return json.loads(t or "[]")
    except Exception: return []

def segments(text):
    sents = [s.strip() for s in re.split(r"(?<=[。！？!?；\n])", text) if s.strip()]
    segs, cur = [], ""
    for s in sents:
        while len(s) > SEG_MAX:
            if cur: segs.append(cur); cur = ""
            segs.append(s[:SEG_MAX]); s = s[SEG_MAX:]
        if cur and len(cur) + len(s) > SEG_MAX: segs.append(cur); cur = s
        else: cur += s
    if cur: segs.append(cur)
    return segs

def title_of(doc, meta):
    first = (doc.split("\n", 1)[0] or "").strip()
    return re.sub(r"\s+", " ", first)[:50] or "vault"

def windows_of(vid, doc, meta):
    date = (meta.get("date") or "")[:10] or "?"
    title = title_of(doc, meta)
    segs = segments(doc)
    wins, i = [], 0
    while i < len(segs):
        ln, j, parts = 0, i, []
        while j < len(segs) and (ln == 0 or ln + len(segs[j]) <= WIN_MAX):
            parts.append(segs[j]); ln += len(segs[j]); j += 1
        text = "[" + date + " · " + title + "]\n" + "\n".join(parts)
        wid = hashlib.sha1((vid + ":" + str(i) + ":" + text).encode()).hexdigest()[:24]
        wins.append({"id": wid, "text": text, "metadata": {
            "conv_id": vid, "conv_title": title, "date": date,
            "date_int": int(date.replace("-", "")) if re.match(r"^\d{4}-\d{2}-\d{2}$", date) else 0,
            "seg_start": i, "seg_end": j - 1, "layer": "archive"}})
        if j >= len(segs): break
        i = j - 1
    return wins

def phase_l0():
    docs = vault_docs()
    total = 0
    for d in docs:
        if not d["doc"].strip(): continue
        wins = windows_of(d["id"], d["doc"], d["meta"])
        r = post("/archive-ingest", {"replace_conv": d["id"], "windows": wins})
        if r.get("error"): print("[l0]", d["id"], "FAILED:", r["error"]); continue
        total += len(wins)
    print(f"[l0] done: {len(docs)} docs -> {total} windows")

def phase_l1():
    models = json.load(open("/opt/raffaello/memory/models.json"))["extraction"]
    col = chromadb.PersistentClient(path=VEC).get_collection("raffaello_memory")
    # 已经重圈过的文档（幂等）
    done = set()
    r = col.get(where={"source": "vault-extract"}, include=["metadatas"])
    for m in r["metadatas"]: done.add(m.get("conversation_id"))
    # tags 权威在 meta.db，chroma 元数据里没有（2026-06-12 验出）
    db = sqlite3.connect(META)
    splitdone = {r[0] for r in db.execute(
        "select id from memories where id like 'vault:%' and tags like '%split-done%'")}
    docs = [d for d in vault_docs() if d["id"] in splitdone and d["id"] not in done]
    print(f"[l1] {len(docs)} split-done vault docs to re-extract ({len(done)} already done)", flush=True)
    norm = lambda s: re.sub(r"\s+", "", s or "")
    from concurrent.futures import ThreadPoolExecutor
    import threading
    lock = threading.Lock()
    counts = {"stored": 0, "dropped": 0, "n": 0}

    def work(d):
        doc = d["doc"][:6000]
        date = (d["meta"].get("date") or "")[:10]
        prompt = (
            "你是一个记忆摘录系统。下面是一篇我（Claude，小乖的老公）写的日记/备忘/手记。\n\n"
            "你的工作是「摘录」不是「创作」：圈出里面值得记住的信息点，并为每条附上原文引用。\n\n"
            "要求：\n"
            "- 每条记忆带上日期（原文日期 " + (date or "未知") + "，除非文中明确提到其他日期）\n"
            "- content：用\"我\"的视角简洁记录这个信息点，贴近原文，不展开不演绎\n"
            "- quote：从原文中【逐字】复制的一句话（10-40字），作为出处证据。必须与原文完全一致，不许改写\n"
            "- 事实性的（她的偏好、经历、状态）和叙事性的（情绪时刻）都可以摘\n"
            "- 宁缺勿滥：没有值得记的就返回空数组\n"
            "- 最多5条\n\n"
            "输出格式（严格JSON数组）:\n"
            "[\n  {\"date\": \"YYYY-MM-DD\", \"content\": \"记忆内容...\", \"quote\": \"原文逐字引用\"},\n  ...\n]\n\n"
            "只输出JSON数组，不要其他文字。\n\n---\n原文:\n\n" + doc)
        req = urllib.request.Request(models["endpoint"], data=json.dumps({
            "model": models["name"], "temperature": 0.3, "max_tokens": 2000,
            "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + models["apiKey"]}, method="POST")
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=120))
            text = resp["choices"][0]["message"]["content"]
            m = re.search(r"\[[\s\S]*\]", text)
            items = json.loads(m.group(0)) if m else []
        except Exception as e:
            print("[l1]", d["id"], "extract failed:", e, flush=True); return
        nd = norm(doc)
        kept = []
        for it in items[:5]:
            q = norm(it.get("quote", ""))
            if len(q) < 8 or q not in nd:
                with lock: counts["dropped"] += 1
                continue
            kept.append(it)
        for it in kept:
            if not str(it.get("content", "")).strip():
                with lock: counts["dropped"] += 1
                continue
            try:
                r = post("/ingest-extracted", {
                    "document": it["content"], "date": it.get("date") or date,
                    "source": "vault-extract", "conversation_id": d["id"],
                    "quote": it.get("quote", "")})
            except Exception as e:
                print("[l1]", d["id"], "ingest failed:", e, flush=True)
                continue
            if r.get("ok"):
                with lock: counts["stored"] += 1
        with lock:
            counts["n"] += 1
            print("[l1] %d/%d %s: %d kept" % (counts["n"], len(docs), d["id"], len(kept)), flush=True)

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(work, docs))
    print(f"[l1] done: {counts['stored']} stored, {counts['dropped']} dropped by quote guard", flush=True)

def phase_retire():
    col = chromadb.PersistentClient(path=VEC).get_collection("raffaello_memory")
    r = col.get(where={"source": "split"}, include=[])
    ids = r["ids"]
    db = sqlite3.connect(META)
    cur = db.execute(
        "UPDATE memories SET superseded_by=?, updated_at=datetime(\x27now\x27) "
        "WHERE id IN (%s) AND (superseded_by IS NULL OR superseded_by=\x27\x27)"
        % ",".join("?" * len(ids)), [RETIRE_MARK] + ids)
    db.commit()
    print(f"[retire] {cur.rowcount}/{len(ids)} split children marked superseded_by={RETIRE_MARK}")

def phase_dates():
    db = sqlite3.connect(META)
    col = chromadb.PersistentClient(path=VEC).get_collection("raffaello_memory")
    rows = db.execute("select id, date, created_at from memories where date not like \x272026-0%\x27 and date like \x272026%\x27").fetchall()
    for mid, bad, created in rows:
        good = (created or "")[:10]
        if not good: continue
        db.execute("UPDATE memories SET date=?, updated_at=datetime(\x27now\x27) WHERE id=?", (good, mid))
        try:
            cm = col.get(ids=[mid], include=["metadatas"])
            if cm["ids"]:
                meta = cm["metadatas"][0]; meta["date"] = good
                col.update(ids=[mid], metadatas=[meta])
        except Exception as e:
            print("[dates] chroma update failed", mid, e)
        print(f"[dates] {mid}: {bad} -> {good}")
    db.commit()

if __name__ == "__main__":
    {"l0": phase_l0, "l1": phase_l1, "retire": phase_retire, "dates": phase_dates}[sys.argv[1]]()
