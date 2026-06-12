#!/usr/bin/env python3
"""verify-splits — 拆分件保真度核对（只读 dry-run）

split-memories.mjs（2026-06-12 退役出 cron）曾用 DS V3 拆长条目，
没有逐字校验。本工具把每个 source=split 的子条目和它的父条目对账：

  verbatim   规范化（去空白）后是父文档的子串 —— 逐字
  near       匹配块覆盖子条目 >= 85% —— 基本逐字，零星改动
  paraphrase 覆盖率 < 85% —— 转述
  orphan     父条目失踪

报告写到 verify-splits-report.json，不改库。
"""
import chromadb, json, re
from difflib import SequenceMatcher

def norm(s):
    return re.sub(r"[\s　]+", "", s or "")

c = chromadb.PersistentClient(path="/opt/raffaello/memory/vectors")
col = c.get_collection("raffaello_memory")

res = col.get(where={"source": "split"}, include=["documents", "metadatas"])
children = list(zip(res["ids"], res["documents"], res["metadatas"]))
print(f"split children: {len(children)}")

pids = sorted({m.get("conversation_id") for _, _, m in children if m.get("conversation_id")})
parents = {}
for i in range(0, len(pids), 100):
    batch = pids[i:i+100]
    r = col.get(ids=batch, include=["documents"])
    parents.update(dict(zip(r["ids"], r["documents"])))
print(f"parents resolved: {len(parents)}/{len(pids)}")

buckets = {"verbatim": [], "near": [], "paraphrase": [], "orphan": []}
for cid, doc, meta in children:
    pdoc = parents.get(meta.get("conversation_id"))
    if not pdoc:
        buckets["orphan"].append({"id": cid})
        continue
    nd, np_ = norm(doc), norm(pdoc)
    if nd and nd in np_:
        buckets["verbatim"].append({"id": cid})
        continue
    sm = SequenceMatcher(None, nd, np_, autojunk=False)
    cover = sum(b.size for b in sm.get_matching_blocks()) / max(len(nd), 1)
    row = {"id": cid, "cover": round(cover, 3), "parent": meta.get("conversation_id")}
    buckets["near" if cover >= 0.85 else "paraphrase"].append(row)

total = len(children)
print()
for k in ("verbatim", "near", "paraphrase", "orphan"):
    n = len(buckets[k])
    print(f"{k:12s} {n:5d}  ({n*100//max(total,1)}%)")

paras = sorted(buckets["paraphrase"], key=lambda r: r["cover"])
print("\n最失真的5条（覆盖率最低）:")
for r in paras[:5]:
    print(" ", r["id"], r["cover"])

with open("/opt/raffaello/memory/verify-splits-report.json", "w") as f:
    json.dump(buckets, f, ensure_ascii=False, indent=1)
print("\nreport -> verify-splits-report.json（只读 dry-run，库未动）")
