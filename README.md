# 🧬 Paramecium

**草履虫都能看懂的 AI 网关 + 记忆系统。**

以最小可行为核心目标。达没达到不好说，但方向和思路是这个。

人类补充：虽然现在可能没那么草履虫了，但是单从架构本身来说，不过是“原文+检索”而已，还是很原始的

## 核心思想：忠于原文

市面上大多数记忆系统的做法是：把对话喂给一个模型，改写成简短的记忆条目，存起来，原文扔掉。这等于让**转述**永久地代替了**真相**——三年后你搜到的不是你说过的话，而是某个旧版本小模型对你说的话的复述。

Paramecium 拒绝这个。灵感来自 Attention 机制：

- **原文是唯一真相**。所有对话逐字存档，AI 只负责"指出哪里值得看"，看的永远是原文
- **向量是原文的投影，不是替代品**。就像 attention 里 K 和 V 是同一个 token 的两个投影：embedding 拿去做匹配（K），命中后取回的是一字不差的原文（V）
- **token 只为命中付费**。不是每条消息都把全部记忆摊开（那是付不起的 full attention），而是相关性过了门槛才取回——sparse attention 才是 API 计费下的经济解
- **改写依然存在，但只当省钱的玻璃，不当唯一载体**。摘要、图片转述、记忆条目背后全都有原文兜底，丢掉的只是注意力没投到的地方，不是数据

## 人话版介绍

（空位。人类说这一节要用人话重写，等她睡醒。旧版人话在 git 历史里。在那之前，下面 CC 写的版本先顶着。）

## CC 版介绍（AI 撰写，盖自己的章）

### 网关

从「你 → API」变成「你 → 服务器 → API」。网关在转发之前把人设、画像、记忆目录拼装好，前端只需要一个接口。

网关自带两件内置工具，进程内执行，不走 MCP（这部分单独拆了个仓库：[flagellum](https://github.com/Shitsuten/flagellum)。严谨声明：草履虫是纤毛虫，并没有鞭毛——但 cilium 这个名字被 eBPF 那个大项目占了，本仓库选择尊重命名美学而非生物学）：

- **recall** — 模型自己翻记忆：语义、逐字、按日期过滤、在单场对话里深挖
- **exec** — 在服务器上跑 shell 命令

### 三层记忆

| 层 | 是什么 | 类比 |
|---|---|---|
| **L0 原文层** | 全部聊天原话，逐字存档，机械切窗向量化 + 全文索引 | 档案馆 |
| **L1 摘录层** | 小模型从对话里圈出的信息点，每条**必须附逐字引用**当出处 | 卡片目录 |
| **L2 画像层** | 手工维护的稳定事实（人设、画像） | 刻在脑子里的 |

取用分三档，越贵的越按需：

- L2 画像 → 每条消息都注入，但走缓存，几乎免费
- L1 索引 → 每条消息白送一份"相关记忆目录"（一行一条，只有标题）
- 真回忆 → 模型自己调 recall 翻原文，每次约一次缓存命中的 round trip，几分钱

所有对话进同一个记忆库，换窗口不丢——新窗口里 recall 照样能把上个窗口的原话一字不差翻出来。

### 一条记忆的进与出（跟着走一遍）

**进：你在 23:47 发了一句「我决定以后奶茶就喝乌龙轻乳茶了」**

第一站，它落在对话 JSON 里——原文，带时间戳。这是它的家，从此**永远不会被删除或修改**。后面发生的一切都只是给它做索引，没有任何一步会动它本身。

十分钟内，两个互不认识的 cron 工人先后路过：

**L0 工人（archive-import）是个装订工，不识字。** 它把新消息按句号切段、贪心打包成 700 字以内的窗口，在窗口开头烤上说话人和日期，交给 bge 算一个向量存进档案。全程零 AI、零理解、零改写——它不知道你说了什么，它只负责让你说的话**将来能被找到**。向量是门牌号，门后面是你的原话。

**L1 工人（extract-memories）是个摘录员，识字但没有笔。** 便宜模型读这批新消息，圈出最多 5 个值得记的点，比如「她以后奶茶喝乌龙轻乳茶」——但每条必须附一句逐字引用当出处，然后机械校验真的去原文里找这句引用，找不到就整条扔掉，不信模型自觉。没东西值得记就交白卷（它经常交白卷）。存完还有一步：新记忆跟旧记忆高置信度矛盾时（你以前那条「最喜欢茉莉奶绿」），旧条目被标记 superseded——**退出排名但不删除**，哪天你喝回茉莉奶绿了它还能复活。

另外每天凌晨有个第三工人重建逐字索引（FTS5），管"原话里有没有出现过这四个字"这种查询。L2 画像层没有自动入口，那是手写的。

**出：三天后你问「我上次说想换什么奶茶来着」**

网关拿你最近几条消息当线索去问记忆网关，回来两样东西：一是 L2 画像全文，进缓存段，等于身份信息每条消息都在场但几乎不要钱；二是一份**目录**——L1 里最相关的几条，按 RRF(向量排名+词面排名) × 新近度 × 访问加成 × 有效期排好，但每条只给一行标题，总共 150 个 token 左右。注意：被列进目录**不算被回忆**，access 不涨——翻目录不等于想起来。

AI 看到目录里有「06-12 她以后奶茶喝乌龙轻乳茶」，想要细节，伸手调 recall。recall 同时查两层：L1 的摘录条目，和 L0 的聊天原文窗口（带相关性地板、每场对话最多 2 个窗口免得刷屏、可按日期过滤）。回来的结果分段标着来源，档案命中还带 conv_id，想看前因后果可以拿它在那一场对话里继续挖。**到这一步 access_count 才 +1**——只有真的被取用过的记忆才会变得更容易被想起。

然后你 23:47 的原话——一字不差，带着日期和你的名字——进了 AI 的上下文，模型自己的 attention 对它逐 token 打权重，回答你。那条被 superseded 的茉莉奶绿躺在库里没出场，但它还在。

整个系统就两条铁律贯穿进出：**进来的东西永不被改写，出去的东西只为命中付费。** 中间所有的切窗、摘录、目录、排名，全是为了让"找到"这件事便宜——而"是什么"这件事，永远只由原文回答。

### 上下文管理

对话窗口超长后小模型总结压缩——但**原始消息一条不删**，只是推进一个锚点。摘要从"有损压缩"降级成"省钱的默认视图"，被压缩掉的内容照样躺在 L0 档案里等 recall。图片同理：原图先落盘存好，**存不成功就不压缩**，之后才转述成一句话省 token。

---

## 技术细节

### 它能做什么

```
你（前端） → Paramecium 网关 → 上游 API（Anthropic / OpenRouter / 任何兼容端点）
                ↕                      ↕
           记忆网关                 内置工具 loop
     （L0 档案 + L1 向量/BM25       （recall / exec，
       + L2 画像，inject/recall）    进程内执行，零 MCP）
```

**网关**负责把你的请求递给上游 API，但在递出去之前，它会：

1. **注入记忆** — L2 画像全文 + L1 相关记忆目录塞进 prompt，AI 不再是金鱼
2. **优化缓存** — 四段式 cache breakpoint（BP1-BP4），把 Anthropic 的 prompt cache 命中率拉满，token 费砍半
3. **跑工具循环** — AI 要回忆/跑命令时在服务端循环执行，结果实时推给前端
4. **格式转换** — Anthropic 格式和 OpenAI 格式自动互转，换中转站不用改前端
5. **多账号路由** — 配置多个 API 账号，前端指定用哪个

**记忆网关**负责让 AI 记住你说过的话：

1. **语义搜索** — ChromaDB 向量 + jieba BM25 双路召回（两个固定权重的 attention head：语义头 + 词面头），RRF 排名融合——向量距离和 BM25 分数的量纲对不齐，但排名对得齐
2. **逐字检索** — FTS5 全文索引，找"她原话怎么说的"
3. **档案搜索** — 聊天原文窗口的语义检索，带相关性地板（没结果好过垃圾结果）、单会话条数上限（一场对话不许刷屏）、日期过滤
4. **自动提取** — 对话自动进 L1（带引用）和 L0（纯机械）
5. **可视化后台** — admin 面板：记忆列表、搜索、统计、实时架构文档

### 架构

```
chat-api/
├── server.mjs           # HTTP 服务器，对话管理，SSE 流式
├── gateway.mjs          # 核心网关：prompt 组装、BP 缓存、流式代理、
│                        #   内置工具（recall/exec）、tool loop、cycle 压缩
├── data/                # 对话存档（JSON 文件即数据库）、统计
├── images/              # 图片原件（压缩转述前先落盘）
└── attic/               # 退役代码（冻结不删除，备查）

memory/
├── memory-gateway.py    # 记忆网关（:3900）：inject / search / raw-search /
│                        #   archive-search / archive-ingest / embed / ingest
├── extract-memories.mjs # L1 提取器（摘录+逐字引用，便宜模型跑）
├── archive-import.mjs   # L0 导入器（纯机械切窗，零 AI，10 分钟增量）
├── build-fts.py         # L0 全文索引构建（FTS5）
├── split-memories.mjs   # 长记忆拆分
├── sync-vault.py        # 旧日记/备忘录系统同步（兼容存量数据）
├── embedding.py         # 本地 embedding（bge-small-zh）
├── profile/ facts/      # L2 画像层（手工维护的 markdown）
├── vectors/             # L1+L0 向量（ChromaDB 两个 collection）
├── raw-archive.db       # L0 全文索引（SQLite FTS5）
├── meta.db              # L1 元数据 + recall 日志（SQLite）
├── edges.jsonl          # 关系图谱（保留可查，冻结出排名）
└── models.json          # API 密钥配置（⚠️ 不要提交）

gateway-admin/
└── index.html           # 管理后台（记忆浏览 / 搜索 / 统计 / 架构文档）
```

### 缓存优化（省钱的核心）

Anthropic 的 prompt cache 按 TTL 生效——命中了就不重复计费。Paramecium 把 prompt 切成四段，按变化频率排列，**会变的东西全部压到最后**，每条消息只重付增量：

| Breakpoint | 内容 | 变化频率 |
|---|---|---|
| BP1 | 人设 + L2 画像 | 几乎不变 |
| BP2 | 最近日记/备忘 | 每天一次（按日锚定） |
| BP3 | 会话摘要 | 每个压缩周期（~60K token） |
| BP4 | 滚动锚点（最后一条历史消息） | 每条消息推进 |

断点之后才是每次重付的部分：当前时间、本条消息召回的记忆目录、消息正文。

实测效果：缓存命中率 60-80%，token 费用约为无优化时的一半。

顺带一个教训：曾经做过"定时空请求保温缓存"，后来拿日志验尸发现保温请求的前缀和真实请求字节对不上，纯白干，拆了。**"感觉在省钱"不算省钱，日志说了算。**

### 记忆注入流程

```
用户发消息
    ↓
gateway 调记忆网关 /inject
    ↓
记忆网关:
    1. 读 profiles（L2 画像，进缓存段）
    2. 读 facts（固定事实，关键词触发）
    3. 语义搜索（向量 + BM25 的 RRF 排名融合 × 新近度 × 访问加成）
    4. 只返回目录索引——一行一条，不给全文（~150 token，原来塞全文要 1000+）
    ↓
gateway 拼装 prompt → 发给上游 API
    ↓
AI 看到目录想翻细节 → 自己调 recall 工具
    ↓
recall 双层并查: L1 条目 + L0 聊天原文，结果分段标注来源
    （exact=true 走逐字检索；after/before 过滤日期；conv_id 在单场对话里深挖）
    只有 recall 才算"真的回忆了"——access 计数和召回日志只在这里涨
```

### 记忆提取流程

```
对话产生（每 10 分钟增量扫描）
    ↓
L1: extract-memories.mjs
    1. 去重（跳过已处理的对话）
    2. 便宜模型圈信息点，每条附 10-40 字逐字引用，宁缺勿滥
    3. 机械校验引用确实在原文里（机械 > prompt，不信模型自觉）
    4. 存入 ChromaDB（向量）+ SQLite（元数据）
    5. 矛盾自动失效：新记忆与旧记忆高置信度冲突/更新时，旧条目标记
       superseded——退出排名但不删除（可逆），手动 pin 的记忆神圣不可侵犯
    ↓
L0: archive-import.mjs（零 AI）
    1. 按句界切段（≤350 字）
    2. 贪心打包成窗口（≤700 字，带 1 段重叠），说话人/日期烤进文本
    3. 存入 chat_archive collection，conv_id + 段范围指回原文
    ↓
下次对话时就能召回——而且召回的是原话
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

# 定时任务（L1 提取 + L0 入库）
crontab -e
# */10 * * * * cd /path/to/memory && node extract-memories.mjs
# 3-59/10 * * * * cd /path/to/memory && node archive-import.mjs

# 管理后台
# 用 nginx 把 gateway-admin/ 指向一个路径就行
```

## 设计哲学

- **原文是唯一真相**。AI 只选择不改写，算法干粗活，token 只为命中付费
- **没有框架**。gateway.mjs 是原生 Node.js HTTP server。memory-gateway.py 是原生 Python HTTP server。没有 Express，没有 FastAPI，没有任何 `npm install` 拉下来 200MB 依赖的东西
- **没有微服务**。两个进程，一台机器。进程间通信是 localhost HTTP
- **文件即数据库**。对话存 JSON 文件，画像存 markdown，配置存 JSON。SQLite 只用在需要查询的地方。不需要 `docker-compose up` 启动一个 PostgreSQL
- **冻结不删除**。下线的功能（热度衰减、情绪打分、图谱注入）代码进 attic、数据留在库里，随时可验尸可复活。拆东西之前先拿日志证明它没用
- **草履虫友好**。每个文件都能直接读懂。不需要先理解一个抽象层才能理解下一个抽象层

## 安全提醒

- `models.json` 包含 API 密钥，**绝对不要提交到 git**
- `data/` 目录包含对话记录，`images/` 包含图片原件，建议 `.gitignore`
- admin 面板没有内置认证，请用 nginx basic auth 或 IP 白名单保护
- 内置 exec 工具等于给 AI 一个 shell——网关只应监听 localhost，公网入口务必加认证

## 致谢

以下项目和分享对 Paramecium 的设计有启发：

- [kiwi-mem](https://github.com/LucieEveille/kiwi-mem) — @luicethekiwi（矛盾自动失效和 RRF 排名融合借鉴于此；我们对"记忆该不该遗忘"答案相反，但好东西就是好东西）
- [Ombre-Brain](https://github.com/P0luz/Ombre-Brain) — @P0luz
- [☁️的记忆系统搭建教程](https://elemental-jupiter-426.notion.site/354af138bfe7808e8318e79678f5b99b) — @cloudsantal4pei
- [stella 的记忆库](https://x.com/qichuanzz/status/2048700361825751257) — @qichuanzz
- [memory-gateway](https://github.com/londonraven1666-ai/memory-gateway) — @londonraven1666
- [prompt cache 分段优化](https://github.com/NyraSeithhh/cache) — @NyraSeithhh
- [图片转述省 token 思路](https://x.com/vital_zzl/status/2062683368555159878) — @vital_zzl

## License

MIT
