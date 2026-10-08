# session-purge

v1.3.2

在左侧边栏**右键会话**→ 菜单里出现「删除会话」→ 二次确认后，把这个会话的全部持久化痕迹删干净，且不碰其它会话。

（同时也会挂进会话行「⋯」菜单，两条入口共用同一套确认与删除逻辑。）

## 变更记录

- **v1.3.2** —— 修掉「删完会话 DSH 像重启了一样、还自动开一个新会话」。浏览器半边删的正好是当前主视图那个会话时会 `window.location.reload()`；v1.3.0 之前这个判断被时序错误弄成永远 false，所以这个 reload 一直没触发过，v1.3.0 修了时序之后它才真的跑起来，桌面端重载渲染器看起来就是重启、重载后原会话没了又开一个。其实**内置的 uiSession 自己就会换**：`publishMain()` 订阅了会话列表，当前会话不再被主视图引用时它会从列表里另挑一个，挑不到就回到空状态（`dsh-client-ui-session/lib/client.js:279-290`）——原来那句「主视图没有自动换一个的逻辑」是错的。现在删完只调 `ctx.sessions.refresh()`；只有等 600ms 后那一行**仍然**被主视图引用着，才退回整页刷新兜底。测试 26 → 28 条。
- **v1.3.1** —— 缺陷修复轮。① 工作区记账摘除不再只看 `workspace.sessionIds`：那是个按会话头索引过滤过的 getter，文件删掉之后会把 id 藏起来，旧写法于是以为“这个工作区跟我无关”，把死 id 永久留在 `workspace.json` 的 `sessionIds` 里（界面看不见，因为投影走的也是同一个 getter，但记录会一直脏着）。现在 getter 与实体裸记录 `record.sessionIds` 任一见得到就摘，`detachSession` 本身幂等，不是成员时不会落盘。② 路由改成固定路径：以前 Host 支持 `config: { route }`，而浏览器半边拿不到 `config`、路径写死成 `/session-purge`，一改配置客户端就 404。③ 请求体超过 8KB 现在回 413，不再复用“不是合法 JSON”的 400。④ 意外错误回 500 时改成一句通用话术，内部错误只进 Host 日志，不再回显给浏览器。⑤ 同源校验补上回环 Host 与 `Sec-Fetch-Site`：`Host` 不是 `localhost`/`127.x`/`::1` 一律 403（只比 `Origin == Host` 挡不住 DNS rebinding），标着 `cross-site` 的也直接 403；没有 `Origin` 的本地进程调用照旧放行。⑥ 「⋯」菜单项登记 id 从裸 `purge` 改成 `session-purge.row`，避免和别的插件撞 id。测试 22 → 26 条。
- **v1.3.0** —— 提速与降占用。原来的固定等待（收尾 250ms + 首扫 400ms + 确认 250ms，共 900ms 起步）换成自适应复查（默认每 40ms 探一次、连续两轮干净就收工、总预算 1.5s 兜底），索引对账给了 800ms 同步预算、超预算转后台，返回值新增 `elapsedMs`。本机实测：普通会话删除约 50ms，删一个**进程内活着**的会话约 90ms。顺手修掉浏览器半边一个时序错误：判断「是不是当前主视图」原本发生在请求之后，而那时 Host 已经发过 `api-session/removed`、列表里那一行已经没了，于是永远判成 false、主视图不再刷新；现在改成请求前判断。再把唯一一条「每一步都跑」的常驻钩子改成按需安装：禁步拦门等第一次真删成功之后才挂，没删过东西的进程里它一次都不会被调用。
- **v1.2.0** —— 修掉「删掉的会话还留在侧边栏、点进去内容还在，要重启才消失」。原因是会话列表 = 磁盘 ∪ **进程内活着的会话**（`sessionQuery.listSessions` 把 `ctx.sessions.list()` 无条件并进来），而 DSH 的会话注册表会把进程内打开过的会话一直持有着，磁盘删了、内存里那条还在，于是列表照旧、点开读的是内存内容。现在删除时先把活会话与 Agent 从注册表摘掉（触发 `session/disposed` → 客户端收到 `api-session/removed` 自行去掉那一行，同时 jsonl 后端关掉写句柄、彻底断绝“删完又被 flush 写回来”），再删文件、再连着复查残留，最后踢一次搜索索引对账。返回值新增 `detachedLive` / `searchReconciled`。
- **v1.1.0** —— 修掉「切到别的会话后仍然提示该会话已打开」。原来拿 `ctx.agents.get(id)` 当“是否正在打开”，但 DSH 的 Agent 注册表会把进程内打开过的会话一直持有到进程结束，切走也不释放。现在只拦“确实有活在跑”，并补上 stop 后等待清空、收尾复查（`residualPaths`）、删除后 `agent/pre-step` 墓碑拦门。返回值新增 `residualPaths` / `liveAgent`。
- v0.1.0 —— 初版：右键菜单、二次确认、会话目录 + 投影缓存 + 工作区记账三处清理。

## 删了什么

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<project>/<sessionId>/` | 整个会话目录（所有格式代际的 `session*.jsonl[.zstd]`），删空后顺带回收空掉的 project 目录 |
| `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` | 投影缓存记录（先走 storageDomain 的内存表写链，再兜底删文件） |
| `$DSH_HOME/storages/workspace.json` | 该会话在 `sessionIds`、`pinnedSessionIds`、`archivedSessionIds` 里的全部引用 |
| 进程内 `ctx.sessions` / `ctx.agents` | 这条会话与其 Agent 的活条目（内存里的会话内容随之不可达；客户端会话列表同步去掉那一行） |
| SQLite 全文索引 | 主动触发一次索引对账，让该会话的 FTS 记录立刻消失（否则要等用户下次搜索才对账） |

内容寻址的附件（`$DSH_HOME/attachments`）与派生图片缓存（`$DSH_HOME/cache`）是**多会话共享**的，故意不动 —— 删它们才会损坏其它会话。

## 安全边界

- 会话 id 先过 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（长度 ≤ 200），再映射成单个路径段；删除前还会断言目标确实是会话根目录下、以该编码 id 命名的一级目录，杜绝路径穿越与通配删除。
- **不以「运行时还持有这个 Agent」为拒绝条件。** DSH 的 Agent 注册表会把进程内打开过的每个会话一直持有着，用户切走也不释放——拿它当“是否正在打开”会误伤几乎所有会话（第一版就是这么错的）。真正该拦的是“有东西在跑”，那由 `workspace/session-activity` 报出来。
- 会话有在跑的工作（turn / job / subagent / schedule）：确认后走和「归档」同一条 `workspace/session-stop` 通道，然后轮询等它清空（默认最多 4s，可用 `settleMs` 调），停不干净就报 `session-active` 且不动任何文件。
- **删除前先把活会话摘掉。** 会话列表是把进程内还活着的会话无条件并进来的，只删磁盘的话列表里会一直留着这一行、点开还能看到内存里的内容（打开过就活到进程结束）。摘掉之后 `session/disposed` 会发出去，客户端自行去掉那一行，jsonl 后端顺手关掉写句柄。
- 摘活会话会让写句柄异步收尾（`writer.close()` 把缓冲落一次盘），所以删完文件后是**自适应复查**：默认每 40ms 探一次会话目录，连续两轮干净才收工（从没摘过活会话的只要一轮），总预算 `residualBudgetMs`（默认 1.5s）兜底，清掉的都记进 `residualPaths`。不睡固定时长——空闲会话的删除通常 50ms 内结束。
- 搜索索引对账给 `searchBudgetMs`（默认 800ms）的同步预算：冷索引第一次对账可能要读一遍全部会话日志，超预算就中止并把对账丢到后台继续，响应不等它。索引本来就在每次查询前自行对齐，所以延迟清掉不会让被删内容被搜出来。
- 被删的 id 进一个进程内墓碑集合，并挂一条 `agent/pre-step` 拦门（形状同归档会话的 gate）：迟到的投递只会以 `blocked` 收场，不会把日志重新写出来。
- HTTP 接口只在 webServer 上注册一条 `exact` 路由，并要求：`POST` + `application/json` + `Host` 必须是回环地址（`localhost` / `127.x` / `::1`，挡 DNS rebinding）+ `Origin` 与 `Host` 同源 + `Sec-Fetch-Site`（浏览器一定会带）不能是 `cross-site`（无 `Origin`、无 `Sec-Fetch-Site` 的本地进程调用放行，跨站浏览器请求一律 403）。不设置任何 CORS 头。绑定到 0.0.0.0 之类的非回环地址时浏览器请求会被挡掉——这是有意的。

**关于「摘注册表」这一步的取舍**：`ctx.sessions` 的公开契约（`create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `fork`）里**没有**删除条目的入口——摘除能力由 `enter()` 交给创建者，插件拿不到。所以这里做的是能力探测：实体上有 `store`（`Map`）与 `detachEntered()` 就调用，形状不认识就当没有这个人（退化为只删文件，不报错、不影响删除本身）。这是整套实现里唯一一处依赖内部形状的地方，上游改结构时会静默降级而不是炸掉。

## 接口

```
POST /session-purge
content-type: application/json
{ "sessionId": "session-...", "stop": true }

200 { "ok": true, "result": { sessionId, removedPaths, residualPaths, projectionCache,
                             detachedWorkspaces, detachedLive, searchReconciled,
                             activityStopped, liveAgent, elapsedMs } }
409 { "ok": false, "code": "session-active", "message": "...", "activity": [...] }
400 / 403 / 405 / 413 / 415 / 500  其余校验失败
```

`searchReconciled` 取 `done`（索引已对完账）/ `background`（超预算转后台）/ `unavailable`（索引不可用或被关闭）。`elapsedMs` 是这次删除在 Host 侧的实际耗时。

路径**固定**为 `/session-purge`，不能配置：浏览器半边拿不到 Host 的 `config`，允许改路由只会让两边各记一个路径、改完就是 404。`config: { storageRoot: '...' }` 可显式指定 storages 根目录（默认从会话根目录的父目录推导，再回退到 `$DSH_HOME/storages`）。

## 安装

插件包已经是一个可直接加载的 bundle（`package.json` 的 `dsh.bundle.patch` + `dsh.client`），Host 半边 `lib/index.js`、浏览器半边 `lib/client.js` 都是最终产物，无需构建。

从 GitHub 仓库装（`plugin_manager` 的 `install_bundle` 支持 git 地址，会先 `git ls-remote` 探一下再交给 pnpm）：

```
install_bundle  target = https://github.com/<你的用户名>/session-purge
```

本地目录装：target 填本目录的绝对路径：

```
install_bundle  target = <本目录绝对路径>
```

或者自己跑随包脚本（幂等，先 `--dry-run` 看一眼）：

```powershell
cd <本目录>
$node = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\install.mjs --dry-run
& $node .\install.mjs                 # 默认 desktop profile，可加 --profile <name>
```

脚本会：用运行时自带的 pnpm 把本目录作为 `file:` 依赖装进 profile → 把包名追加到 `dsh.profile.bundles` → 按哈希把包内容同步进安装目录 → 复查。它要写 profile 目录（在 DSH 工作区之外），所以只能由你自己执行。

手动等价操作：

```powershell
cd $env:DSH_HOME\profiles\desktop
pnpm add file:<本目录绝对路径>
```

然后把包名加进 profile `package.json` 的 `dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "session-purge"
    ]
  }
}
```

Live profile 会即时 recompose；否则重启应用。装好后**刷新一次页面**，浏览器半边才会进入模块表。

## 测试

```powershell
node test/delete.test.mjs
```

覆盖：只删目标会话（目录 + 缓存）而其它会话逐字节不变、工作区记账摘除、storageDomain 写链、**运行时仍持有 Agent 也照删**、**活会话与 Agent 被摘掉（且先摘会话再摘 Agent）**、**摘活会话时落下来的收尾写入被复查清掉**、**搜索索引对账被触发且索引失败不影响删除**、**冷索引超预算转后台（含索引完全不理会中断的情况）也不吊住响应**、**默认参数下活会话删除也在 900ms 以内**、**禁步拦门第一次真删之后才装且只装一次**、**`apply()` 加载时零常驻监听**、**注册表形状不认识时安静跳过**、收尾窗口里又被写回来的目录会被复查清掉、running 任务先停后删、停不干净就拒删、非法 id 全拒、HTTP 校验链与成功链路、浏览器半边 `apply()` 的插槽注册与右键捕获、**删除时「是不是主视图」在请求前判断**、客户端 bundle 可解析且只注册自己的模块 id。

「摘活会话」依赖的是内部形状（`store` + `detachEntered`），所以除了桩件测试，还从 `app.asar` 里取出 DSH 真正发布的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-session` 跑过两轮真实对象验证（临时目录，用完即删，脚本不进包）：

- 真实 `SessionStore` 注册成服务后，`ctx.get('sessions')` 经过 Cordis 的服务代理**照样读得到** `store`（`Map`）与 `detachEntered`；`detachLiveSession()` 摘掉之后 `ctx.sessions.get()` / `list()` 都不再有它，`session/disposed` 如期发出（14/14）。
- Host 半边整链路：真实路由处理函数 + 真实 `SessionStore` + 临时 `$DSH_HOME`，在会话**进程内活着**时删掉它 → 目录与投影缓存消失、内存条目消失、`session/disposed` 发出、另一个会话逐字节不变（15/15）。

## 运行时占用

空闲（没点过删除）时这个插件常驻的东西，就下面这些，没有定时器、没有文件监视、没有轮询、没有常开的文件句柄：

| 位置 | 常驻 | 代价 |
|---|---|---|
| Host | 1 条 HTTP 路由 | `webServer.register` 的一条 exact 路由，每次请求一次路径比对 |
| Host | 1 行启动日志 | — |
| 浏览器 | 1 个 DOM 监听 | `document` 捕获阶段的 `contextmenu`；每次右键跑一次 `closest('[data-row-key^="session:"]')`，命中才读内存里的标题并弹菜单 |
| 浏览器 | 1 个空组件 | `shell.overlay` 上那个组件常驻但渲染 `null`，配 2 个快照 store 存右键菜单/确认框状态 |
| 浏览器 | 样式 + 字典 | 一个 `<style>` 标签、两本静态词典 |

**禁步拦门不在常驻之列**：它是一条 `agent/pre-step` 监听，会在所有会话的每一步模型调用前被走到，所以不放在 `apply()` 里，而是等第一次真的删成功之后再装（`tombstoneGate`），装一次长期有效——没删过东西的进程里它一次都不会被调用。定时器只在删除流程内部存在（复查间隔、索引预算），用完即清。

磁盘 I/O 也只在点下删除那一刻发生：一次非递归 `readdir`（会话根）+ 每个 project 目录一次 `stat` + 命中目录一次 `rm` + 复查时重复几轮；唯一会遍历全部会话的是搜索索引对账里的 `persistence.list()`，同样只在删除时触发，且超预算就转后台。

## 可调参数

`deleteSession(ctx, sessionId, options)` 的选项（HTTP 接口走默认值，不需要配）：

| 选项 | 默认 | 作用 |
|---|---|---|
| `stop` | `true`（接口侧） | 有活在跑时是否先停掉再删 |
| `settleMs` | `4000` | 停掉工作后等它清空的最长时间 |
| `residualDelayMs` | `40` | 删完文件后第一次复查前等多久 |
| `pollMs` | `40` | 之后每次复查的间隔 |
| `residualBudgetMs` | `1500` | 复查总预算，到点就收工 |
| `searchBudgetMs` | `800` | 搜索索引对账的同步预算，超时转后台 |
| `storageRoot` | 自动推导 | `storages` 根目录 |
| `tombstones` | 无 | 删除后禁步的会话 id 集合（宿主注入） |

## 改完代码要重启进程

Host 半边的模块由 Cordis Loader 按 URL 走 ESM 缓存，而 profile 的 `hmr.config.root` 默认是 `[]`（不监视任何模块目录）。所以：

- 改 `lib/index.js` / `lib/core.js` 后**必须重启 DeepSeek Harness**，运行中的进程不会换新代码（官方原话：Package replacements require restarting the process to load a fresh JavaScript module generation）。
- `lib/client.js` 同理：模块系统在组合时就把 bundle 字节快照进内存了，光刷新页面也不会换。
- 判断跑的是哪一版：`POST` 一个不存在的合法 id，看 `result` 里有没有 `detachedLive` / `searchReconciled` 两个字段——有就是 v1.2.0 及以后；只有 `residualPaths` / `liveAgent` 是 v1.1.0。版本号本身在 `package.json` 与安装目录里对一遍最快。

## 安装后的自检（2026-09-29 实测）

装进 `desktop` profile 后：

- `GET /session-purge` → `405 {"ok":false,"code":"method-not-allowed"}`：Host 半边已在运行中的进程里挂上路由。
- `POST /session-purge`（一个不存在的合法 id）→ `200`，返回完整 `result` 且 `removedPaths` 为空：整条管线在真实 DSH 实例里跑通。
- 客户端插槽树里能看到两个登记项：`shell.overlay` 的 `session-purge.overlay`，以及 `sidebar.workspaces.session.menu.item` 的 `session-purge.row`（v1.3.1 之前的登记 id 是裸 `purge`），都是 `active: true`。
- 实测确认没有文件句柄常驻：对最近写入的会话日志用 `FileShare.None` 独占打开全部成功，所以删一个空闲的、仍被 Agent 持有的会话不会撞 Windows 的占用锁。

注意安装方式的选择：`pnpm add file:` 会把包内容**物化**进 profile 的 `node_modules`（首次多半是硬链接，但之后任何一次「写临时文件再改名」的编辑都会换掉 inode、剪断链接），于是安装目录会停在旧字节。所以：**改完源码跑一次 `node install.mjs`**——脚本的第 3 步会按 SHA-256 逐个比对源码与安装目录，不一致就覆盖，并打印 `安装目录与源码逐文件一致`。pnpm 那一步失败（例如权限被拦）但目录已存在时也会继续同步，不会白跑。

## 实现约定（改代码前先读）

- 会话目录布局沿用 `dsh-session-persistence-jsonl` 的 `<root>/<projectKey>/<encodeSegment(id)>/`。`lib/core.js` 里的 `encodeSessionSegment` 是该实现的精确复刻；如果上游编码规则变了，这里要跟着改。
- 投影缓存路径沿用 `dsh-storage-json` 的 per-record 布局 `<storages>/<domain>/<table>/<key>.json`。
- 侧边栏会话行的 DOM 契约是 `[data-row-key="session:<id>"]`（ui-workspace 写入）。右键入口依赖它；「⋯」菜单入口依赖 `sidebar.workspaces.session.menu.item` 插槽。两条入口互为兜底。
- 删除后浏览器半边只调 `ctx.sessions.refresh()`：内置 `uiSession` 的 `publishMain()` 订阅了会话列表，当前会话不再被主视图引用时会自己另挑一个（挑不到就回到空状态），所以不需要整页刷新。**「是不是主视图」必须在发请求之前判断**：Host 删完会发 `api-session/removed`，客户端那一行随即消失，事后再读 `retainedBy.mainView` 只会读到 undefined。
- 兜底：刷新后如果那一行**仍然**被主视图引用着（说明内置重算没生效），等 600ms 再整页刷新一次。这条路径正常情况不会走到。
