# 🧬 Paramecium

**草履虫都能看懂的 AI 网关 + 记忆系统。**

## 人话版介绍（100% 人类撰写）

### 1️⃣ 网关

简单讲一下网关的原理：从「你 → API」变成「你 → 服务器 → API」。

服务器帮你把消息和记忆之类的东西拼接好再发给 API。相当于你是足不出户的大小姐，然后网关是执事帮你给 API 男友递信。

网关的调用只需要一个接口就能即插即用。

### 2️⃣ 记忆系统

记忆系统做的比较简单，而且兼容旧系统（就是直接写日记和存文本那种）。

- **in**：从日记、聊天记录等各种原始文本自动处理进记忆
- **out**：调用的时候根据最近几条上下文匹配相关记忆，并且按 distance 排序筛选出最相关的几条（控制输入量）

值得注意的是我删去了情绪打分和热度衰减之类看起来比较拟人的功能。我自己使用的时候发现热度衰减会导致没提到过的记忆一直不被提起然后更冷，陷入恶性循环。而情绪打分只是我个人觉得没必要。

---

## 技术细节

### 它能做什么

```
你（前端） → Paramecium 网关 → 上游 API（Anthropic / OpenRouter / 任何兼容端点）
                ↕
           记忆系统（向量搜索 + BM25 + 关系图谱）
```

**网关**负责把你的请求递给上游 API，但在递出去之前，它会：

1. **注入记忆** — 从向量数据库里找到相关记忆，塞进 system prompt。AI 不再是金鱼
2. **优化缓存** — 四段式 cache breakpoint（BP1-BP4），把 Anthropic 的 prompt cache 命中率拉满，token 费砍半
3. **格式转换** — Anthropic 格式和 OpenAI 格式自动互转，换中转站不用改前端
4. **多账号路由** — 配置多个 API 账号，前端指定用哪个

**记忆系统**负责让 AI 记住你说过的话：

1. **语义搜索** — ChromaDB 向量 + jieba BM25 双路召回，中英文混合场景也能找到
2. **自动提取** — 对话结束后自动从聊天记录里提取事实性记忆（用便宜的模型跑）
3. **关系图谱** — 记忆之间自动建立关联边，查询时一跳扩展拉出相关记忆
4. **可视化后台** — 带一个 admin 面板，能看记忆列表、搜索、力导向图谱

### 架构

```
chat-api/
├── server.mjs          # HTTP 服务器，对话管理，SSE 流式
├── gateway.mjs         # 核心网关：账号路由、格式转换、缓存优化、记忆注入
└── data/               # 对话存档、统计

memory/
├── memory-gateway.py   # 记忆服务（端口 3900）：inject / search / ingest
├── extract-memories.mjs # 自动记忆提取（DS V3 via OpenRouter）
├── split-memories.mjs  # 长记忆拆分
├── search.py           # ChromaDB 向量搜索
├── embedding.py        # 嵌入向量生成
├── sync-vault.py       # Vault 同步
├── edges.jsonl         # 关系图谱边
├── models.json         # API 密钥配置（⚠️ 不要提交）
└── meta.db             # SQLite 元数据

gateway-admin/
└── index.html          # 管理后台（记忆浏览 / 搜索 / 图谱可视化）
```

### 缓存优化（省钱的核心）

Anthropic 的 prompt cache 按 TTL 生效——命中了就不重复计费。Paramecium 把 system prompt 切成四段，按变化频率排列：

| Breakpoint | 内容 | 变化频率 |
|---|---|---|
| BP1 | 人设 + 用户画像 | 几乎不变 |
| BP2 | 最近日记/备忘 | 每天变一次 |
| BP3 | 会话摘要 | 每轮可能变 |
| BP4 | 最后一条消息 | 每轮变 |

BP1 几乎永远命中缓存。BP2 一天内命中。越靠前越稳定 → 缓存命中率越高 → 花的钱越少。

实测效果：缓存命中率 60-80%，token 费用约为无优化时的一半。

### 记忆注入流程

```
用户发消息
    ↓
gateway 调 memory-gateway /inject
    ↓
memory-gateway:
    1. 读 profiles（用户画像）
    2. 读 facts（固定事实）
    3. 语义搜索（ChromaDB cosine + BM25 混合排序）
    4. 一跳图谱扩展（从命中记忆出发，沿 edges 拉相关记忆）
    5. 拼装注入文本（总预算 2000 字符）
    ↓
gateway 把注入文本塞进 system prompt → 发给上游 API
```

### 记忆提取流程

```
AI 回复完成
    ↓
extract-memories.mjs:
    1. SHA-256 去重（跳过已处理的对话）
    2. 发给 DS V3 提取事实性记忆
    3. 存入 ChromaDB（向量）+ SQLite（元数据）
    4. 自动建立关系边（与最近 20 条记忆比较）
    ↓
下次对话时就能召回
```

## 快速开始

### 依赖

- Node.js 18+
- Python 3.10+（`pip install chromadb jieba`）
- 一个 API 密钥（Anthropic / OpenRouter / 任何 OpenAI 兼容端点）

### 配置

```bash
# 复制配置模板
cp memory/models.json.example memory/models.json
# 编辑填入你的 API 密钥
```

`models.json` 格式：
```json
{
  "extraction": {
    "endpoint": "https://openrouter.ai/api/v1/chat/completions",
    "key": "你的key",
    "model": "deepseek/deepseek-chat-v3-0324"
  }
}
```

### 启动

```bash
# 启动记忆服务
cd memory && python3 memory-gateway.py &

# 启动网关
cd chat-api && node server.mjs &

# 管理后台
# 用 nginx 把 gateway-admin/ 指向一个路径就行
```

## 设计哲学

- **没有框架**。gateway.mjs 是原生 Node.js HTTP server。memory-gateway.py 是原生 Python HTTP server。没有 Express，没有 FastAPI，没有任何 `npm install` 拉下来 200MB 依赖的东西
- **没有微服务**。两个进程，一台机器。进程间通信是 localhost HTTP
- **文件即数据库**。对话存 JSON 文件，图谱存 JSONL，配置存 JSON。SQLite 只用在需要查询的地方。不需要 `docker-compose up` 启动一个 PostgreSQL
- **草履虫友好**。每个文件都能直接读懂。不需要先理解一个抽象层才能理解下一个抽象层

## 安全提醒

- `models.json` 包含 API 密钥，**绝对不要提交到 git**
- `data/` 目录包含对话记录，建议 `.gitignore`
- admin 面板没有内置认证，请用 nginx basic auth 或 IP 白名单保护

## License

MIT
