# 开发文档

> 写给要改代码或写插件的开发者：目录结构、已实现的架构、开发步骤与测试。第三方插件请先读 [插件开发指南](plugin-guide.md)；项目约定（必须遵守）见 [AGENTS.md](../AGENTS.md)；规划中的架构见 [design/architecture.md](design/architecture.md)。

## 1. 目录结构

```

src/
  index.ts                 Worker 入口：启动内核、按插件注册的路由分发请求
  plugins.ts               ★ 服务端插件清单（启用 / 禁用插件只改这里）
  kernel/                  内核：插件装配、扩展点、纯函数模拟引擎（不含任何游戏逻辑）
    types.ts               Plugin / PluginContext / 各扩展点的类型契约
    kernel.ts              依赖排序、注册表、冲突检测
    engine.ts              executeCommand（原子提交 + 乐观锁重试）/ computeViews / runReport
    config.ts              可调规则：解析、合并默认值、校验器
  runtime/
    context.ts             为每个请求构造引擎上下文（玩家、时间、当前规则）
    kernel-instance.ts     每个 isolate 只启动一次内核
  plugins/<id>/            每个服务端插件一个目录（index.ts + data/*.csv，含 data/i18n.csv 文案）；清单与分工见 docs/plugin_architecture_reference.md
  lib/http.ts              JSON 响应与错误映射
  shared/api.ts            ★ 前后端接口契约（纯类型，无依赖；两端都从这里 import）
migrations/                D1 表结构（每个插件的表以插件 id 为前缀）
extensions/<id>/           第三方扩展（server.ts / client.ts / data/），两端构建时自动收集，官方清单不用改
examples/                  示例扩展：watchtower（新建筑）、otherworld（只写后端的小网格副本）、clock（自带前端控件的服务器时钟）；复制到 extensions/ 即启用，测试保证它们一直能用
index.html                 前端 HTML 外壳（只有一个 #app）
web/                       Vue 前端
  main.ts                  启动：加载插件 → 挂载 App
  plugins.ts               ★ 前端插件清单
  core/                    前端插件宿主（game.ts）、API 客户端、布局 App.vue、数字格式化
  widgets/                 官方通用控件（ui.cards / rows / timers / grid / tree / cells / report / lanes / sync …，数据形状在 src/shared/ui.ts），由前端插件 widgets 注册
  plugins/<id>/            前端插件：外壳（auth、settlement、resource-bar、forms）、widgets、mail（邮箱）、gm-panel；放在哪由服务端声明（见 docs/design/ui.md 第 3 节）
  styles.css               设计 token 与基础元素样式
scripts/data.mjs           本地测试数据的清除 / 备份 / 恢复
scripts/map/               地图生成（map:generate）与导入（map:import）
vite.config.ts             Vite + Cloudflare 插件（本地数据目录在这里配置）
test/                      kernel / 游戏规则 / HTTP 端到端 测试
docs/
  HANDOFF.md               ★ 当前状态与待办（接手时先读它）
  design/gameplay.md       玩法设计（目标，以它为准）
  design/ui.md             界面布局
  design/architecture.md   规划中的架构、已知限制
  changelogs/              已完成的改动记录（按日期）
  deployment.md            部署与运维（本地运行、数据、命令、上线、常见问题）
  development.md           开发文档（本文件）
  plugin-guide.md          插件开发指南（第三方从这里开始）
  plugin_architecture_reference.md  插件清单
humannotes.md              用户给 AI 的留言（处理后删除）
README.md                  项目简介（是什么、部署、玩法、开发、免责声明）
AGENTS.md                  项目约定（AI 与人类开发者都要遵守）
LICENSE                    GPL-3.0 许可证全文
```

### 数据文件

内容和设计数值不写在代码里：每个插件目录下的 `data/*.csv` 是它的数据（建筑策划表、兵种公式参数、分摊比例、城墙、科技、道具、各系统的设计数值…），构建时以文本打包进 Worker。GM 在后台的修改覆盖在这些默认值之上。表格格式见 `src/kernel/data.ts` 和各系统插件的 `defineFromCsv` 说明。

## 2. 架构

### 2.1 请求流程

```
浏览器（Vue）──/assets/*──▶ Workers Assets（构建产物，不经过 Worker）
   │
   └──/api/*──▶ Worker(index.ts) ──matchRoute──▶ 插件注册的路由
                                                   │  accounts: cookie → 会话 → 用户（D1）
                                                   │  loadConfig（经 gm 插件从 D1 读取 GM 覆盖值）
                                                   ▼
                                    engine（src/kernel/engine.ts）
                                      读：computeViews → 各插件的 view 按需查询自己的表
                                      写：executeCommand → 命令按需读取 → 写入排队
                                           → 一个原子 batch 提交（带乐观锁，冲突自动重试）
```

### 2.2 内核扩展点

插件在 `setup(ctx)` 中通过 `ctx` 注册一切。所有注册项在内核启动时做冲突检测，重名直接报错。

| 扩展点                                                          | 用途                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.services.provide/get`                                      | 插件间 API（类型通过 `ServiceMap` 声明合并）；插件的表只能通过它的服务读写                                                                                                                                                                                                                                                                                                                                                   |
| `api.memo(…, { current: true })`                                | 声明缓存由拥有者随写入同步更新，命令之后的视图直接沿用（见 2.3 节）                                                                                                                                                                                                                                                                                                                                                          |
| `api.derived(key, { owner, salt }, compute)` / `derive(api, …)` | 常读少变的派生值存成 `engine_derived` 一行（一个玩家的全部一次取回）：它读过的表在 owner 名下的版本、规则版本、salt 都没变就直接读回，否则重算；只存从已提交数据算出来的（命令写了相关表之后算的不存，由命令之后的视图存）。读回时这些表照样记到调用它的视图名下（戳跟着变）。没有 owner 或没有规则版本时每次都算；`derive` 给没有 `derived` 的手搓 api 用。用例：资源的产率与明细、任职英雄的加成、科技定义、不透明科技数值 |
| `api.beforeCommit(key, fn, { last, writes })`                   | `last`：在其他提交前钩子之后再跑（资源结算要等装备合计、声望写完）；`writes`：这个钩子会写的表，没跑之前引擎当它们已经改了（存的派生值不读回），不写则算"任何表"                                                                                                                                                                                                                                                             |
| `api.version(entity)`                                           | 实体被提交过多少次（乐观锁版本，`player:<id>`：玩家的每条命令、别人碰到他的命令都会 +1），只读一行；给视图的 `stamp` 用，表示"只有命令会改的数据没变"                                                                                                                                                                                                                                                                        |
| `playerStamp(api)`                                              | 视图戳的常用部分：在戳里是"这个视图读过的表在这个玩家下的版本"（只有写了这些表、又锁了这个玩家的提交才会变，见 2.4 节"戳按视图读过的表"），在别处是玩家的提交次数；外加规则版本                                                                                                                                                                                                                                              |
| `worldMap.addVirtual` / `settlements.addVirtual`                | 不存进数据库、按规则算出的占用者和城池（如 NPC 营寨）：`occupants / window / claim / findFreeSquare` 和 `get / getMany` 都能看到；存储的占用者在同一格时优先；`worldMap.stored` 只查存储的（虚拟来源判断自己时用，避免递归），`worldMap.forget` 让本次调用重新问虚拟来源；大窗口只要存储的时传 `window(…, { virtual: false })`                                                                                               |
| `api.files.get` / `api.putFile`                                 | 对象存储（R2 桶 `FILES`，`EngineContext.files`）：大块、少变的数据（地图文件、图片）。`files.get` 是读取，视图和被重试的命令里都安全；`putFile` 在命令里只排队，引擎在 D1 提交**之前**写入，提交失败只留下没人引用的文件，所以文件名要由内容决定（如哈希）。没有桶时调用 `putFile` 抛 `PluginError`                                                                                                                          |
| `api.fresh` / `api.isFresh`                                     | 标记本次调用里新建的实体（如新城池），按它读数据的地方直接返回空，省去必然为空的查询                                                                                                                                                                                                                                                                                                                                         |
| `ctx.onReady`                                                   | 所有插件 setup 完之后按插件顺序运行（`caller()` 仍是本插件），用来把别的插件登记的内容一次整理好（例如秘境把掉落分进每个任务的奖励池）；同步、不碰游戏状态                                                                                                                                                                                                                                                                   |
| `ctx.hooks.on/emit`                                             | 事件（类型通过 `HookMap` 声明合并），如 `engine:command`                                                                                                                                                                                                                                                                                                                                                                     |
| `ctx.config.define`                                             | 声明一条 GM 可实时调整的规则（默认值 + 校验），读取用 `handle.get(api)`；`default(rules)` / `parse(raw, rules)` 可以读其他规则（`other.get(rules)`，按需解析、不能成环），这样的规则按"覆盖原文 + 所读规则的值"缓存，不每个请求重算                                                                                                                                                                                          |
| `ctx.commands.add`                                              | 玩家操作：`parse` 校验输入（内核 `shape` + `fields`，`src/kernel/fields.ts`）+ 异步 `execute`；`privileged: true` 表示仅 GM 可用；可附 `form`，由前端通用渲染                                                                                                                                                                                                                                                                |
| `ctx.views.add`                                                 | 发给客户端的只读数据（资源、产率、商店价格…），前端可用 `?views=` 只取需要的                                                                                                                                                                                                                                                                                                                                                 |
| `ctx.statics.add`                                               | 静态视图：只依赖内容和规则、与玩家无关的界面数据（秘境与任务、掉落清单……），`compute({ rules, db })`；按规则版本烘焙进存储（插件提供的 `staticStore` 优先，其次是 R2 桶 `FILES`，都没有时用内存），只重烘焙读过已变规则的（读内容表的写 `content: true`，每次规则版本变化都重烘焙）；同步只带各静态视图的版本，客户端 `game.static(id)` 按版本取一次并缓存                                                                   |
| `ctx.reports.add`                                               | GM 用的跨玩家只读查询（排行、统计、筛选），在 GM 后台 _Reports_ 里运行                                                                                                                                                                                                                                                                                                                                                       |
| `ctx.tasks.add`                                                 | 后台任务（由 cron 触发，线上每 10 分钟；要改游戏状态时以玩家身份 `executeCommand`）。线上的 cron 几乎每次落在新实例上，所以**没活时不装配**：先用一条小查询判断有没有活（如时间线 `due_at <= now LIMIT 1`），有活才 `requestContext`；只随规则变的任务把 `` `${await rulesVersion(kernel, env)}                                                                                                                              | ${kernel.build}` `` 存进自己的状态行，没变就跳过（`kernel.build` = 应用版本 + 各插件版本，`createKernel(plugins, { build })`；`rulesVersion` 只读规则版本号）；清理类任务每小时一次（`now % 3_600_000 < 600_000`）。测试 `test/offline.spec.ts` 断言新实例空闲时不读规则、最多 6 条查询 |
| `ctx.gates.add`（1.4.1）                                        | 请求闸门：每个 `/api` 请求进路由之前先问一遍，`check` 返回一个响应就直接用它（例如用量保护暂停游戏时回 503）；`closed()` 为真时定时任务只跑 `always: true` 的任务。每个请求都会调用，要自己缓存读到的东西                                                                                                                                                                                                                    |
| `ctx.routes.add`                                                | HTTP 路由                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.meta.add`                                                  | 静态游戏数据（名称、图标）：构建时生成成静态文件 `meta.json`（`scripts/bake-meta.mjs`），开发模式下经 `/api/meta` 下发                                                                                                                                                                                                                                                                                                       |

内核还导出与游戏无关的工具：命令输入的 `shape` / `fields`、报错的 `gameErrors` / `errorText`、CSV 解析、规则校验、`seededRandom` / `triangularInt`、`stagedGrowth`（一览见 [共享代码登记](shared-code.md) 第 1 节）。

内核还约定了一个"知名服务" `configStore`：哪个插件提供它，GM 覆盖值就从哪里读取（目前是 `gm` 插件，存在 D1）。没有插件提供时一律使用默认值。读取时发现没有任何插件定义的键（规则改名或删除后留下的），会通过它的可选方法 `prune` 自动删除并记入审计日志；已知键的非法值保留，由 GM 在后台修正，日志里每种问题只警告一次。

### 2.3 数据存储与并发

**所有数据都在一个 D1 库里**（账号、邀请码、GM 配置、玩家存档）。每个插件拥有以自己 id 为前缀的表（`resources_balances`、`buildings_slots`…），表结构在 `migrations/`。

- **按需读写。** 命令和 view 只查询需要的行（例如某个玩家的资源），不存在"整份存档"。同一次调用内，多个插件读同一批数据时用 `api.memo()` 共享，只查一次。
- **命令 = 原子的工作单元。** `execute` 期间的所有写入只是排队，命令结束后由引擎用**一个 `db.batch()`** 提交：要么全部成功，要么全部不生效。抛出 `GameError` 时什么也不写。
- **写入合并。** 提交前，同一张表、同一句的单行 INSERT 合并成多行 INSERT（`src/kernel/coalesce.ts`，每条不超过 D1 的 100 个参数）：只有在这张表之间没有别的语句时才合并，所以每张表的语句顺序不变；不是经引擎 `api.db.prepare` 做出来的语句原样保留。D1 按 batch 里的每条语句计数（每次调用最多 1000 条，免费计划 50 条）。
- **新建的实体。** `api.fresh(entity)` 标记"这次调用里新建、库里还没有它的任何数据"（`settlements.found` 对新城池这样做），按这个实体读数据的地方（时间线、资源池、建筑、驻军、队列、城防、增产、任职英雄）用 `api.isFresh` 直接返回空，不再查库；地图的占用查询也复用这次调用里已读过的窗口。
- **乐观锁。** 每条命令自动锁定 `player:<id>`；跨玩家的命令（攻打、流寇）再 `api.lock('player:<对方>')`。提交时在同一个 batch 里把这些锁的版本号 +1，数据库触发器（`engine_locks_cas`）发现版本已被别人改过就中止整个 batch，引擎用新数据重试（最多 5 次）。因此玩家连点、多个标签页同时操作都不会重复扣款。
- **数据库兜底约束。** 例如资源 `CHECK (amount >= 0)`、建筑数量 `CHECK (count >= 0)`：即使代码有 bug，也写不进非法数据。
- **离线产出按需结算。** 资源行存"结算时的数量 + 结算时间"。读取时按**当前规则**现算：`数量 + 产率 × 经过时间`（经过时间上限为规则 `engine.maxOfflineSeconds`，默认 12 小时）。只有命令会把结算结果写回。任何改变产率的操作（买建筑、GM 改数量）都会先把旧产率下的收益结算落盘。写回时只写变化的行（数量或产率变了、或正在产出的）；没有记录的资源按初始值读，所以不产出、仍是初始值的池（例如 NPC 要塞）一行都不写。
- **规则改动立即生效。** 每个请求都重新读取配置，所以 GM 改完后，所有玩家的下一次请求（包括尚未结算的离线时间）都按新规则计算。非法的存量覆盖值会被忽略并回退默认值。例外是"初始资源"，它只影响还没有资源记录的新玩家。
- **部分覆盖。** GM 只写想改的字段（如 `{"gold-mine": {"produces": {"gold": 5}}}`），其余字段继续跟随内容插件的默认值。
- **扩展方式。** 单个 D1 库串行执行查询，一个库大约支撑几千人同时在线（取决于查询复杂度）。更大规模时按"区服"拆分：一个区服一个库。插件只通过 `api.db` 访问数据库，拆分时不用改插件。

### 2.4 城池系统

- **地图**：1024×1024，x、y ∈ [-511, 512]，两个方向首尾相接。只存储被占用的格子，主键保证一格只能有一个占用者。
- **城池类型**：由 `settlements.defineKind` 注册，默认有首都、分城、资源要塞、军事要塞；NPC 城池由独立插件以 `npc: true` 注册。每个类型的数量上限是 stat `settlements.limit.<kind>`（`limit` 给基础值，`limitMax` 给硬上限，`settlements.limitOf` 读出两者）；科技用里程碑效果（`effects.csv` 的 `atLevel`）加，道具加的记在 `starter_items_stats`。
  - "ring" 布局：内城居中，外城逐个占相邻格。第 1–8 座外城在第一圈，更多（道具）在第二圈，最多 24 座。
  - "single" 布局：占 1 格（要塞）。
- **城区与栏位**：内城栏位固定，外城栏位数量随机（GM 可调）。每类城区接受哪些建筑类别由城池类型声明（外城只接受资源建筑，内城只接受非资源建筑）。一座城的所有城区共享一个资源池 `settlement:<id>`。
- **建筑**：前 7 级按策划表，之后按递增系数；建筑给的 stat 默认按等级线性，可声明 `statsGrowth`（某级起每级乘系数，如武库）；常规上限默认 20，每个实例可以突破（没有最终上限）；每次升级前询问所有拦截器（例如科技的等级段）；建造需要时间、有队列，完成由时间线在精确时刻处理，产出从那一刻起改变。
- **资源**：`净产率 = 产出 × 产出系数 − 维持消耗`。余额增长到库存上限为止，维持消耗最多压到欠债下限。压到下限时触发 `resources.onDepleted`，部队系统据此分轮溃逃 / 降级。`resources.spend(api, holder, cost, purpose)` 的用途是 `spend`（玩家花钱办事，默认）/ `upkeep`（预付维持）/ `transfer`（搬走，如辎重）/ `loss`（被抢）；`onSpent` 收到所有花费，返还用 `refund`（或资源另行回来时只通知 `refunded`），`onRefunded` 收到返还。声望只算 `spend` 并扣回返还。
- **科技（透明科技树）**：在建有**研究所**的城池里研究；每座城池一个队列，同一科技不能在两座城同时研究；研究所等级提升研究速度。科技在定义上声明 `unlocks`（按节点拦截建筑，例如农桑 1 / 3 / 7 级分别解锁农田 6 / 10 / 15 级以上）、`stats` 和 `percent`（给该玩家所有城池加成）。费用由进行研究的城池支付。运行时可以用 `research.registerNode` 注册科技树之外的新节点（给将来的不透明科技插件用），并用 `research.grantLevel` 直接授予等级；`research.addCostModifier` 预留给英雄的研究加成。
- **NPC 城池**：`npc-camps` 用 `settlements.defineKind({ npc: true })` 注册 NPC 类型（据点、要塞），每座 1–10 级（表 `npc_camps_levels`），每级的名称、每路守军（按兵种系列 + 等级从 `troops.list()` 找兵种）、寨栅、抢资源（按地形偏置，用 `terrain.bonus`）/ 抢兵、守将加成都在 `levels.csv`（GM 规则 `npc-camps.levels`）；GM 命令 `npc-camps.spawn` / `spawnAt` 生成，后台任务按目标数量和等级权重补充。行军任务 `uproot`（命令 `npc-camps.uproot`，地图格子上的表单）：目标须在玩家某座城池的外城范围（`settlements.outerArea`）内，到达时照常交战，五路全胜就用 `settlements.remove` 把营寨删掉（先 `api.lock` 这座营寨；`onRemoved` 里删掉自己的等级行）。
- **上限与加成**：都做成 stat（例如外城科技上限、建造队列、库存上限），科技、道具、建筑只需往里加加成。
- **命令之后不再重读**：`api.memo(key, load, { current: true })` 表示"这个缓存由拥有者在每次写入时同步更新"。命令提交成功后，这类缓存交给同一次请求里算视图用（`executeCommand` 返回 `carried`，`computeViews(…, carried)`），其他缓存照常重新读。已标记：建筑栏位与在建、装备、英雄、道具背包、资源池、科技等级、玩家的城池、驻军。新标记一个缓存前，要确认它的每条写入路径都同步更新了缓存；`test/game/perf.spec.ts` 逐条命令比对"沿用"和"重新读"算出的视图必须完全一致。
- **不变的只发一次**（AGENTS.md 性能原则）：界面里与玩家无关的部分做成静态视图（`ctx.statics.add`，`src/runtime/statics.ts`）。规则版本（`gm_config_version`，GM 每次写规则 +1，与覆盖同一条查询读出）变了才烘焙；清单（也在 `staticStore`）记每个静态视图读过的规则及其值的签名，只重烘焙受影响的，发版（包版本与插件版本变）全部重烘焙。`/api/static/<id>/<版本>` 公开、长期缓存；同步结果的 `statics` 是各静态视图的版本。通用控件 `ui.rows` 的视图可写 `base: <静态视图 id>`，只带玩家的部分（显示哪些节和行、覆盖的字段、追加的说明、按 `tag` 隐藏的说明），前端按 id 合并。秘境页是第一个这样拆的（`realms.catalog` + `realms.list`）。解析好的规则值在没变时跨请求保持同一对象，按规则建的东西可以用 `WeakMap` 按对象缓存（例如秘境的掉落清单）。**存储**：有 R2 绑定 `FILES` 时烘焙结果存进桶里（键 `static/<id>/<版本>.json`，长期缓存；清单 `static/manifest.json`，`no-cache`），每个版本全局只烘焙一次，新 isolate 不用重烘；插件也可以提供服务 `staticStore`（`get` / `put`）换成别的存储。配了 `FILES_BASE_URL`（桶的公开域名）时，同步结果带 `filesBase`，浏览器直接从 `<filesBase>/static/<id>/<版本>.json` 取，不经过 Worker。
- **meta 在构建时生成**：meta 只取决于代码和内容，`pnpm build` 之后由 `scripts/bake-meta.mjs` 用 Vite 的 SSR 加载器在 Node 里装配内核，和 Worker 用同一个 `buildMeta`（`src/runtime/meta.ts`）算出正文和版本，写成 `dist/client/meta.json`（`{ version, meta }`）。浏览器先取这个静态文件（不计 Worker 请求，重新验证也免费），没有时（`pnpm dev`）退回 `/api/meta`。
- **会变的也只在变了时发：视图的戳**（`View.stamp`）。客户端带回持有的戳，相同就不算不发；内核把请求参数并进戳（换城池、换英雄一定重算）。常用的戳：资源池的结算时间（`resources.pool`、`resources.production`），`settlements.stamp`（玩家提交次数 `api.version` + 规则版本 + 本城到点事件：城池页的栏位、城区盘、任职英雄，英雄页的卡片、防守顺序、装备），聚宝阁的余额与今日已购。只随时间变的部分（招募候选的轮换窗口）加进戳里。
- **戳按视图读过的表**（`playerStamp`，`src/kernel/reads.ts`，2026-10-19）：在视图的戳里，`playerStamp` 不再是"玩家的提交次数"，而是"这个视图上次算的时候读过的那些表，各自的版本之和"。每次提交按"被锁的玩家 × 写过的表"给 `engine_locks` 里的 `player:<id>#<表>` 加 1（一条多行 upsert）；算视图时，引擎经 AsyncLocalStorage 记下它准备的语句读了哪些表（`FROM` / `JOIN`），memo 记自己的，用到它的视图都算上（在别的 memo 或视图里填进去的 memo 继承填它时已读过的表）；表的代码（4 个字符）放在戳里由客户端带回，下次按这些表的版本比对（玩家的全部表版本一条范围查询）。于是标记邮件已读只让读邮件表的视图重算，城池、建筑、驻军不动。和以前一样只有锁了这个玩家的提交才会让戳变，所以不会比以前更容易看到旧数据；认不出表名的写入（没经过 `api.db` 的语句）算作所有视图都受影响。依赖 Node 兼容（兼容日期 2026-08-04 起默认开启）。客户端只带回本次要的视图的戳（`web/core/game.ts`）。
- **浏览器按计数判断、服务端照样校验**：静态卡片的按钮带 `needs`（计数够不够，各有原因）、价格部件带 `need`（不够变红）、工期部件带 `seconds` + `factor`；表格单元带 `counter` / `over`。计数来自视图的 `counters` 或客户端登记的提供者（资源栏给出插值后的 `resource:<id>`）。建筑卡片由浏览器按 `buildings.catalog` 的规则数据用 `src/shared/buildings.ts` 现算（任意等级），模板生成器经 `defineTemplates` 登记。
- **一次请求答完整个屏幕**：同步和命令的请求可以带 `instances`（JSON 列表，每项 `{ key, view, params }`）：同一次调用里把某个视图按这些参数再算一遍（共用缓存），结果在 `state.instances[key]`。前端用 `game.instance(key, view, params)` 登记（不再显示时取消），表单区域（`FormOutlet`）就是这样拿到自己的表单的，不再单独请求；新登记的会在同一拍里合并成一次请求。
- **服务端驱动的表单**：命令附带 `form`，`prepare()` 决定当前是否可用并填好选项；前端 `forms` 插件用 `<FormOutlet placement="...">` 通用渲染。建外城、出兵、训练、改名都是这样实现的，没有专门的前端代码。表单还可以声明三种前端即时规则（服务端照样再校验）：`budgets`（若干字段之和不超过其他字段 × 权重之和，例如辎重不超过载重）、下拉的 `distinct` 互斥组、选项的 `when` 条件（只在另一个字段取某值时出现）。字段的 `placeholderBy`（`prepare` 也可以给）让占位文字随另一个字段的取值变化（例如训练数量框显示所选兵种"最多 N"）；`placeholderLive` 让前端按"数量、每秒变化、时间、上限"自己推算占位里的数（例如运输各格的"最多 N"随库存增长），表单只在打开时读一次库。表单带 `columns`（表头）时，带 `cells`（只读数值）的字段排成一张表，每行是标签、各格数值、输入框（例如英雄加点）。成功后要醒目提示的写 `notice`，要二次确认的写 `confirm`（按钮 `UiAction` 同样）。需要专门编辑器的字段用 `type: 'widget'`（`widget` 名 + 服务端给的 `data`），前端插件用 `forms.widget(name, { component, payload(value, field) })` 注册。通用的有 `ui.lanes-input`（`LanesInputData`：几路，每路选一组并分配数量，共用一个按另一字段取值的"池子"，另有一个不分组的格子；输出的键名由 `data.output` 指定）——攻打的阵列编辑器就是它；`ui.tally`（`TallyData`：各项在筛选字段上的取值和数量，前端按当前选择计数、加总，不提交），批量拆解用它。`ui.rows` 的分节 `actions` 显示为标题旁带文字的按钮。

### 2.5 游戏系统

玩法细节见 `docs/design/gameplay.md`；这里只讲系统之间怎么接。

- **时间线**（`timeline`）：需要时间的事（建造完成、训练完成、军队到达 / 回城、短缺的每一轮）都是实体（`settlement:<id>`、`army:<id>`、`player:<id>`）上的定时事件，在"下次用到这个实体"时按时间顺序处理（只读视图里也处理，但写入被丢弃）；处理前先把资源结算到事件时刻。每分钟的清扫任务 `timeline.sweep` 以拥有者身份处理没人看的实体，所以离线玩家的事也按时落库。只读视图里处理的结果不落库，所以需要立即提交的地方要用命令（例如前端在军队到点时调用 `armies.sync`）。本地 `pnpm dev` / `pnpm preview` 由 `vite.config.ts` 的 `localCron` 每分钟触发一次定时任务，与线上一致。 一个请求里要逐个处理好几个实体时（一个玩家的各城），先 `timeline.preload(api, 实体)`：一条 `entity IN (…)` 查询把它们的到期事件都读进缓存（驻军提醒、科技等级、秘境都这样用）。
- **NPC 营寨由规则放置**（`npc-camps`，1.4）：全图的营寨按 `npc-camps/layout.ts` 算出（规则 `npc-camps.density` 的种子、块大小、每块座数、浮动、要塞占比，加上等级权重 `npc-camps.spawn`；每块按"种子 + 块"抽数目、位置、类型和等级，按规则值缓存，每个 isolate 每块只算一次），不存进数据库。它们经两个通用扩展点出现在游戏里：`worldMap.addVirtual`（格子上的虚拟占用者：`at` 答零散格子，`area` 按块列出一片区域，不逐格扫描）和 `settlements.addVirtual`（id 为 `npc:<bx>,<by>,<槽位>` 的虚拟城池，`get / getMany` 交给它，`remove` 只跑监听者）。一座规则营寨在不在由 `standing` 判断：`npc_camps_state` 里没记已移除、格子上没有存储的占用者、周围 3×3 里没有首都（一次查状态、一次查周围的存储占用、一次取那几座城池）。只有被打过（`raided_at`）或被移除（`removed`）的才在 `npc_camps_state` 里有一行（迁移 `0011`）。存储的营寨照旧（`settlements_settlements` + `npc_camps_levels`）：新手营寨、GM 放的、补回的。每分钟的任务 `npc-camps.upkeep` 只做补回：被拔除的营寨记在 `npc_camps_respawn`，由 `npc-camps.respawn` 换到别处的空地补成存储的营寨（规则 `npc-camps.respawn`，每分钟最多 100 座）。GM 报表 `npc-camps.count`（规则放的总数直接按块算出、已移除、存储的、新手营寨）；GM 命令 `npc-camps.clearStored` 给 1.4 以前播种的世界清掉从没被打过的旧营寨（每次最多 20 座，不补回）。据点不再有基础产量（`starter-content` 的 `base-production.csv`），否则一结算就要写资源行。
- **资源池**（`resources`）：只有登记过的持有者种类（`addHolderKind`，目前是 `settlement`）有资源池；时间线推进其他实体（如军队）时不结算资源。
- **道具的保底**（`items`）：`items.attempt(api, { target, chance, pity, forgetDays })` 掷一次，失败累计、成功清零，连续失败到保底次数时必成（`pity` 0 = ⌈1 / 成功率⌉）；`items.odds` 给表单显示进度，`items.describeOdds` 生成"保底 1/3"（GM 另见成功率）。目标按"插件id:目标"命名，数据在 `items_pity`（迁移 `0003_items_pity.sql`，从 `starter_items_pity` 拷过来，旧表这个版本保留）。
- **队列**（`queues`）：在城池里排队的活（兵营训练、城墙建造）。拥有者用 `queues.define({ id, seconds, finish })` 登记一种活，`add`（付费后排到某条队列末尾，空闲则立即开工）、`cancel`（未开工的全额返还）、`speedUp`、`jobs`；每条队列同一时间一项，完成时由时间线在精确时刻调用 `finish` 并开工下一项，用时在开工时按当时的加成计算。每条队列可排队数是 stat `queues.waiting`（规则 `queues.maxWaiting`）。数据在 `queues_jobs`（迁移 `0002_queues.sql`）；1.2 存在 `troops_queue` / `starter_siege_queue` 的旧数据在第一次用到那座城时由拥有者用 `queues.adopt` 搬过来（旧表保留不删）。建造（多个并行栏位）和研究（每城一项、不排队）的规则不同，没有接入。
- **数值（stat）**（`stats`）：`(基础 + Σ固定值) × (1 + Σ百分比)`。上限、容量、队列、加成都做成 stat，拥有者 `define`，给加成的 `contribute`。每项加成带来源文字：`contribute(stat, fn, source)`，或 `fn` 按目标返回带 `source` 的加成（一个贡献者代表多个来源时返回数组，例如每项科技、每种建筑一条）；没写来源的算"其他"。`stats.breakdown` 给出基础值和各来源（同名来源合并），`stats.describe` 把它变成"研究所 +20%"这样的行。时间、费用一类的倍率（`buildings.addTimeModifier`、`research.addCostModifier`、`troops.addTrainingTimeModifier` / `addUpkeepModifier`）注册时也带 `source`，拥有者用 `buildings.timeFactors`、`research.factors`、`troops.trainingFactors` / `upkeepFactors` 按来源列出，`stats.factors` 变成"任职英雄 −12%"。界面上地方够就直接列出（研究速度、建造用时、训练用时、维持开销），产量由 `resources.productionTable` 按来源拆开（原始产出；加成：通用产量加成、单项资源加成、城区自带的百分比如地形，都换算成数量；消耗：各维持开销的来源），生产方的分段可以带 `sources`，`resources.addConsumer` 和 `buildings.addDistrictBonus` 注册时带来源文字；城池页左栏用通用表格 `ui.table` 显示（视图 `resources.production`）。地方小的放进 `UiLine.hint` / `UiAction.hint`（悬停显示，带虚下划线）：建造队列、外城上限、英雄上限、库存上限与产量加成（资源栏）。
- **部队**（`troops`）：兵种注册（数值可以是当前规则的函数）、训练（每座兵营一条队列：一批在训、其余为训练计划，加入时付费、开始前可取消全额返还；`trainedAt` 决定在哪个建筑训练）、驻军、维持开销（资源消耗方）、短缺时分轮溃逃 / 降级（`addShortageRule`、`onShortage`）。训练需求 `addTrainingRequirement`（例如 `starter-levies` 的招募令额度：2–4 级兵每个 1 点，下达训练时扣除）。
- **行军**（`armies`）：每次出兵有一个**任务**（`defineMission`）：`attack`（到达时交给遭遇处理函数 `addEncounter`，如 `pvp`、`npc-camps`）、`transfer`（派遣到自己的城池）、`transport`（运往 / 运回自己的另一座城池，部队都返回）、`settle`（`settling` 插件：筑城）、`uproot`（`npc-camps`：拔除外城范围内的营寨）。任务名是定义它的插件的键（`mission:<id>`），`missionName(id)` 给战报等处使用。出发时一次扣清往返粮饷、辎重和任务费用；任务的到达结果决定卸货、驻扎还是返回。附加选项（`addSendOption`，如阵列、带兵英雄）可限定任务：`missions` 列出任务，`forBattle` 表示用于所有要交战的任务（任务上标 `battle: true`，如攻打、拔除），阵列就是这样。整支军队的速度可以由 `addPaceModifier` 改写（军车载最慢的兵，见 `starter-auxiliary`：辎重营训练的军医 / 辎重队 / 军车，军医是战斗的伤亡钩子）。事件：`onArrive`、`onReturn`。
- **战斗**（`battle`）：五路阵列、兵种系列与相克、`fight()` 按路计算；所有加成走修改器 `addModifier`（固定值 + 百分比，可限定兵种 / 等级），伤亡每一步可由 `addCasualtyHook` 修改（辅助兵种）。`pvp` 锁定双方后调用它，同一次提交里完成战斗、损失和掠夺（`onDefense`）。
- **科技**（`research` + `starter-research`）：research 管研究队列、等级、建筑等级段拦截、树上的位置（门类 / 阶 / 题注 / 前置）和卡片上的效果展示（`addEffectDescriber`）；科技的具体效果由 `starter-research` 按 `effects.csv`（GM 规则 `starter-research.effects`）接到各系统现有的接口：stat（固定 / 百分比、每种资源自己的产出 stat `resources.output.<id>`、建筑等级上限 `buildings.cap.<id>`、辎重 `armies.cargo`、斥候 `armies.scouting`、招募候选 `heroes.candidates`、晋升额度 `battle.promotionCost`、城墙 `starter-defense.wallStrength / wallBreach`）、战斗修改器、建造 / 训练 / 维持 / 研究时间修正、行军速度（`armies.addSpeedModifier`）、地形加成（`terrain.addBonus`）。
- **英雄**（`heroes` + `starter-heroes`）：属性、招募地点、职务都是注册的；职务带来的加成通过其他系统已有的接口接入（产出 stat、建造 / 训练时间修正、维持修正、科研费用修正、战斗修改器），其他系统不知道英雄的存在。等级与成长也在 heroes：`grantExp` 升级（天赋点按天生属性自动分配、自由点由玩家 `heroes.allocate`），`addAttributeBonus` 让其他插件（如装备）加属性，效果一律按 `attributesOf`（自身 + 加成）计算；属性变化前 `onAttributesChange` 通知内容插件先结算。
- **用量日志**（`src/runtime/usage.ts`，不是游戏插件）：本地或 Docker 设了 `USAGE_LOG` 时，Worker 入口把 `env.DB` 包一层计数（每次查询的 `rows_read` / `rows_written` / `size_after`），并数请求和命令；每分钟的定时任务把计数加进本地表 `usage_periods`（运行时 `CREATE TABLE IF NOT EXISTS`，不在迁移里），每个周期结束打一行 JSON 日志。CPU 由本地服务器（`vite.config.ts` 的 `localCron`）读 workerd 进程的 CPU 时间，带 `USAGE_TOKEN` 报给 `POST /api/usage/cpu`。没设这个变量时什么都不做。
- **掉落**（`loot`）：奖励池与掉落算法。入口插件定义自己的池（`definePool`：`realms`、`bandits`、`npc-camps`、`pvp`），任何插件往里加东西（`addDrop(pool, { id, weight, value?, where?, preview?, give })`，`weight` 可以是按场合算的函数）；掉落时入口插件只给最低总价值（`roll(api, pool, 场合, 最低总价值, random)`），按权重抽到总价值够为止，再 `give` 发放。每个有东西的池自带"空手格"（规则 `loot.rules.empty`：占抽取的比例和计入的价值；`roll` 的结果里不含它）；名为 `<组>.<名>` 的池属于同一组，GM 权重可以按组写（秘境每个任务一个池 `realms.<秘境>.<任务>`，在 `ctx.onReady` 里按 `realms.addDrop` 的 `where` 分好，所以秘境定义要写 `taskCount`）。价值缺省为基准权重 ÷ 自身权重（所有池共用一个基准权重，规则 `loot.rules.baseWeight`，默认 4；往池里加东西不会改变其他东西的价值）；`meanDrops`（秘境页的"平均约几件"）按"池 + 最低值 + 在场的各项 id / 权重 / 价值"在每个 isolate 里只抽样一次，之后直接用缓存。`preview` 按权重占比分一般 / 偶见 / 罕见，GM 按池和 id 改权重（`loot.weights`）。空池（`empty`）直接跳过。入口插件导出各自的场合类型（如 `NpcCampOccasion`、`PvpOccasion`），`realms.addDrop` / `bandits.addDrop` 只是往自己的池里加。
- **秘境**（`realms` + `starter-realms`）：英雄单独冒险，不经过战斗系统。realms 管地图占格（`world-map.addMarkers` 让它显示在地图上）、解锁、冒险结算（`src/shared/realms.ts` 的 `fightGroups`，前后端共用）、奖励池（`addDrop` / `addClearReward`）、重伤与疗伤、战报邮件；秘境、怪物、冒险属性公式（`addHeroStats`）、掉落和钥匙由 starter-realms 按 CSV 注册。冒险在开始时就决定结果，结束事件挂在英雄挂靠城池的时间线上，到点一次发放。`realms.speedUp` 缩短冒险或疗伤（GM 命令 `realms.hasten`）。连续冒险（命令参数 `repeat`，规则 `repeatMax`）在结束事件里排下一次；每次消耗什么由 `realms.setRepeatSupply` 登记（starter-items 登记行囊），没有登记时免费。
- **装备**（`equipment` + `starter-equipment`）：equipment 只管装备实例（随机出的数值存 JSON）、部位与部位组（饰品，每名英雄的组上限由内容给出）、最低等级、穿戴、按城池存放（stat `equipment.storage`，同城英雄共用）和拆解；每个玩家的"各英雄穿戴合计"存成一行 `equipment_totals`（穿脱时在提交前重写），加成一律读 `equipment.wornStats`，不逐件读装备；数值键自由，只认 `attr.<属性>`（经 `heroes.addAttributeBonus` 生效）；starter-equipment 定义七套常规装备、四套饰品、五色稀有度、武库和秘境商店，并把装备接到秘境（奖励池按套装 × 颜色成项、`adv.*` 冒险属性）和战斗（`battle.*` 每路固定值）。
- **商城与道具**（`shop` + `starter-shop`，道具效果在 `starter-items`）：shop 管元宝钱包（属于玩家、不能为负）、商品、每日限购、购买记录和 GM 发放；商品表在 starter-shop 的 CSV。道具效果都走各系统的通用接口：资源 `resources.add`、加速 `buildings / troops / research.speedUp`、增产 stat `resources.productionFactor`（到期由时间线事件移除）、英雄 `heroes.grantExp / resetFree`、疗伤 `realms.healNow`、连续冒险 `realms.setRepeatSupply`（行囊）。
- **守城器械**（`starter-siege`）：城墙入口的两张表单（城防工事、守城器械）、每城一个建造队列（时间线事件完成）、维持开销（`resources.addConsumer`）、战斗修改器（工事按攻守方给百分比，器械给守方每路固定值）；费用 / 维持 / 时间按数值的幂次公式。
- **掉落的扩展**（`loot`，1.4）：除了 setup 时 `addDrop` 的掉落项，掉落池还从**来源**取（`loot.addSource(池 / 组 / "*", (api, 场合, 池) => 掉落项[])`，每个场合现问，例如 GM 做的拼图）。掉落项可以写 `chance`（0–1）代替权重：每次 `roll` 先逐个独立判定，掉到的价值计入这次的最低总价值，剩下的再按权重抽。拥有者在每个场合（每场打赢的战斗）都调用 `roll`，自己的掉落概率只决定按权重抽的量（没抽中就传最低价值 0），所以别的插件按概率掉的东西每次都有机会。`roll` 是异步的。奖励行 `RewardLine` 可以带 `label`（带变量的 `UiText`），显示时优先于 `name`（`rewardName`）。掉落池的拥有者用 `loot.describeSites` 登记"掉落发生在哪里"（一棵树 + 场合的路径，地址如 `realms/<秘境>/<任务>/<组>`、`npc-camps/<类型>/<等级>`、`bandits/<等级>`、`pvp`），`loot.sites(api)` 给 GM 界面画树，`loot.siteOf(pool, 场合)` 给出地址。有 `"*"` 来源时任何池都不算空（`loot.empty` 为假）。
- **拼图**（`puzzles` + `starter-puzzles`，1.4）：GM 在自己的页签（插槽 `gm-tabs`）里做拼图：图片在 GM 浏览器里裁成正方形、缩放后经 `POST /api/gm/puzzles/image` 存进 R2（`puzzles/<哈希>.<扩展名>`，按文件头识别格式），定义经 `POST /api/gm/puzzles`（特权命令 `puzzles.save`，写审计日志，`configStore.touch` 让规则版本加一）存进 `puzzles_defs`（迁移 `0012`）。定义按规则版本缓存在 isolate 里，平时不多读。碎片经 `loot.addSource('*', …)` 掉落：按场合地址找上线拼图的规则（地址本身和它的每一级上级），每块是一个 `chance` 掉落项；掉到已有的块、或已兑换满，就换成 GM 设的重复奖励。玩家的进度在 `puzzles_pieces`（有就一行）和 `puzzles_claims`，视图 `puzzles.mine`（带戳），静态视图 `puzzles.catalog`（`content: true`）。`puzzles.claim` 检查集齐、没到上限，逐项发奖、清空碎片、次数加一。奖励用 `rewards` 服务（见下一条）；需要选城池的奖励（`chooseSettlement`）在兑换时带 `puzzles.claim { puzzle, settlement }`，不能作为重复碎片的奖励。`starter-puzzles` 用 `items.addCards` 在道具页加"拼图"组（卡片由前端 `web/plugins/puzzles/item-cards.ts` 拼）、用 `ui.entry` 把拼图界面放进听曲楼。前端插件 `puzzles`：`puzzles.board`（按格裁同一张图，缺的格子用 CSS 模糊、压暗）和 `puzzles.gm`（GM 页签）。
- **用量保护**（`usage-guard`，1.4.1）：R2 超出免费额度会扣费（开通 R2 必须绑卡），Workers 和 D1 在免费计划下超额只会报错。后台任务 `usage-guard.check`（`always`，每 `checkMinutes` 分钟一次）用 Cloudflare GraphQL 分析接口（`r2OperationsAdaptiveGroups` 按 `actionType` 分 A / B 类，`r2StorageAdaptiveGroups` 取各桶最新存储量）查本月用量，任一项达到阈值（默认 50%，GM 规则）就记入 `usage_guard_state`（迁移 `0020`）并关掉 R2 公开域名（`FILES_BASE_URL` 的域名，浏览器直连 R2 不经 Worker）；闸门 `usage-guard.pause` 让玩家的 `/api` 请求回 503（GM 和登录除外），定时任务停下。下个月用量回落后自动恢复、域名重新打开；GM 命令 `usage-guard.resume` 可手动解除；报表 `usage-guard.status` 看用量。统计接口出错时保持原状态。需要密钥 `CF_API_TOKEN`（Account Analytics: Read、Workers R2 Storage: Edit）和变量 `CF_ACCOUNT_ID`、`FILES_BUCKET`；没有时什么都不做（本地、Docker）。
- **流寇保护**（`bandits` + `starter-items`，1.4.1）：`bandits.protect(api, 玩家, 毫秒)` / `protectedUntil`，表 `bandits_protection`（迁移 `0016`）。保护期内到点的判定直接跳过，不生成流寇，下一次判定排在保护结束后一个间隔；再用一张从当前结束时刻顺延；已在路上的照常到达；GM 的 `bandits.spawn` 不受影响。数据视图 `bandits.state`（`protectedUntil`），军队页的倒计时 `bandits.protection` 由前端拼出。道具效果 `truce`（`uses.csv`，`amount` 为小时）。
- **永久防御**（`starter-defense` + 战斗修正 `last`，1.4.1）：`battle` 的修正项新增 `last`：所有百分比和克制倍数之后再加，不被任何倍率放大（`(部队 + 固定) × (1 + 百分比) + last`），战报的加成里显示 `+N`。`starterDefense.permanent / addPermanent`，表 `starter_defense_permanent`（迁移 `0017`），城墙卡片写明"永久防御：每路 +N"。
- **不透明科技**（`opaque-research` + `starter-opaque-research`，1.4，玩法第 14 节）：
  - 每个玩家的 256 维隐藏值存在 `opaque_research_values`（迁移 `0013`，有过项目才有一行）：`dims`（256 个数）、`steps`（各组越过的门槛数，派生，加成每次读它）、`version`（批准或完成一个项目都加一）。纯算法在 `src/plugins/opaque-research/logic.ts`（门槛、环上距离、规避、冲刺比例、点数范围、选目标与成功率、注水式填平、正态偏移），不读规则也不碰存储。
  - **申请书不存**：视图 `opaque-research.status` 对每名在提出申请书的职务上、没在主持项目的英雄现算一份，种子 = 英雄 + 级别 + 季序号 + 版本号；级别 = min(按英雄等级, 授予过的最高级 + 1, 已解锁)；驳回写进 `opaque_research_heroes.rejected`（"级别:季序号"）。没有已解锁的级别（没建双清观）时视图只返回各组加成，不读英雄、不算申请书。视图的戳 = 玩家版本 + UTC 日 + 到期项目数 + 规则版本。
  - `opaque-research.approve { hero, season, version }` 按同一种子重算申请书，季或版本对不上就报 `stale`（409）；检查同时进行数（stat `opaque-research.concurrent`，读首都的）后，从首都扣资源（`resources.spend`，不受减免）、扣元宝（新的 `shop.spend`），写一行 `opaque_research_projects`（批准时定下偏移和点数），版本加一，在**首都**上排时间线事件 `opaque-research.done`（首都下次被用到时结算，和科技完成一样）。`opaque-research.reject { hero, season }` 写一行驳回记录。
  - 完成事件：先结算玩家所有城池的资源，再按冲刺比例把点数分到执行中心，其余在两侧窗口里注水填平；重算 `steps`、版本加一、删项目行、英雄主持次数加一、`heroes.grantExp` 给经验。主持期间英雄的职务由新的 `heroes.addDutyLock` 锁住。
  - 系统插件不认识任何资源、建筑、职务、属性：`opaqueResearch.defineBonus({ id, name, direction, step, category, hook(percent) })` 让接线插件把每个加成接到它该去的地方（`percent(api, 玩家)` 是这名玩家这一项的合计，降低类用导出的 `reduction` 折成 1 ÷ (1 + 合计)）；`setProposers({ duty, points(api), sprint(api) })`（两组属性权重，按 `heroes.attributesOf` 含装备的属性算加权和）、`setDefaultGroups(groups)`、`setCosts((api, 级别) => { cost, seconds, yuanbao })`、`setTexts({ sentences, codes, reviewers })`。GM 规则：`opaque-research.tuning / offset / levels / seasons / exp / groups`。`groups` = `{ count, groups: [[{ bonus, step }…]…] }`（`count` 1–256，第 i 维属于第 ⌊i × count ÷ 256⌋ 组，`logic.ts` 的 `groupOf`）：每组任意几个加成项，各带每级百分比；按规则值对象用 `WeakMap` 建"加成项 → [组, 每级]"的索引。分组布局随静态视图 `opaque-research.texts` 下发（读了规则，GM 改了就重烘焙），玩家视图只发各组越过的门槛数 `steps`。GM 规则页里这条规则用前端插件的圆环编辑器 `opaque-research.gm-groups`（插槽 `gm-rule-editors`）。
  - `starter-opaque-research`：首都建筑双清观（`shuangqing-temple`，研究所 20 级、宫殿 15 级以上才能建，`buildings.addGate` + 城池页卡片上的条件）。每级给 `opaque-research.concurrent` 和自己的 `starter-opaque-research.level` 各加 1，按规则 `unlocks`（1 / 5 / 10 / 15 级）把等级折成 `opaque-research.tier`。加成项写在 `data/bonuses.csv`：每行一个总项，`by` 列出细分（resource / tier / tier-resource / family），按内容（资源、兵的等级、兵种）生成 `<id>:<细分>` 的变体（如 `troop-upkeep:t3-food`），名称用 `i18n.derive` 拼。接到：产量 stat `resources.productionFactor` / `resources.output.<资源>`、`resources.capacity`；军队维持费 `troops.addUpkeepModifier`（全部）和新的 `troops.addUnitUpkeepModifier`（按兵种和资源，细分项共用一个修饰器，只读符合的）；城防维持费 `starter-siege` 新服务 `starterSiege.addUpkeepModifier`（按资源）；建造 / 训练时间、研究时间 `research.addCostModifier`；部队攻防血、相克 `battle.addModifier`（带 family / tier）。默认分组在 `data/groups.csv`。提出申请书的是驻守研究所（`scholar`），点数和冲刺各看一组属性权重（规则 `attributes`）。各级花费是规则 `costs`，申请书句子在 `data/texts.csv`，维度代号由 `data/hexagrams.csv` 生成（64 卦 × 初二三四）。
  - 前端插件 `opaque-research`：`opaque-research.temple`（双清观入口：申请书列表、点开看全文和函评、批准 / 驳回、在研项目，到点刷新）和 `opaque-research.bonuses`（科技页左栏，各组加成）。句子由浏览器按申请书的标签筛、用种子按权重挑（`web/plugins/opaque-research/texts.ts`，`seededRandom` 挪进了 `src/shared/random.ts`），服务端只发参数。
- **英雄的直接授予**：`heroes.grant(api, playerId, settlementId, { venue, level?, gender?, attrs? }, random)` 按招募场所的规则抽一名英雄（指定性别时重抽到符合为止），直接加给玩家；英雄已满时拒绝。
- **道具页的其他分组**：`items.addCards(来源, api => 数据 | null)` 让别的插件往道具页（前端视图 `items.cards`）加一组卡片（例如拼图）：服务端只发数据（视图 `items.extra`，按来源），浏览器用 `defineItemCards(来源, 数据 => { group, cards } | null)`（`src/shared/items.ts`，由显示那个系统的前端插件登记，测试在 `test/helpers.ts` 登记同一个）拼出分组和卡片。
- **奖励**（`rewards` + `starter-rewards`，1.4.1）：GM 可配置的奖励类型的登记处，拼图和邮件附件共用。`rewards.addKind({ id, name, fields, parse, describe, chooseSettlement?, give })`、`check`（校验 GM 写的 `{ kind, config }`）、`describe`、`give(api, 玩家, 奖励, random, { inLoot?, settlement? })`、`choosesSettlement`、`kinds`；自带"随机奖励池" `pool`；`GET /api/gm/rewards` 给 GM 界面列类型和字段，前端控件 `ui.reward-editor`。`give` 兑换时可以拒绝（GameError），掉落里从不拒绝、放不下的标 `lost`。`starter-rewards` 登记资源（发到首都）、道具、元宝、军队、装备（`starterEquipment.make`）、随机女英雄、指定英雄、永久防御（选城池，`starterDefense.addPermanent`）。
- **GM 后台的页签**：后端插件 `ui.slot({ slot: 'gm-tabs', widget, props: { label } })` 声明，`gm-panel` 排在自带页签后面。
- **官方小助手**（`assistant` + 前端插件 `assistant`，1.5.1，gameplay.md 第 15 节）：服务端只有 GM 规则 `assistant.enabled`（默认 0）、`assistant.commandsPerScan`，静态视图 `assistant.settings`，以及带条件的页面声明（`ui.page({ …, when: { static: 'assistant.settings', field: 'enabled' } })`，前端 `App.vue` 只在字段为真时显示页签）。其余全在浏览器：`web/plugins/assistant/store.ts`（按玩家存在 localStorage：队列、规则、开关、日志，可导出 / 导入）、`engine.ts`（每次同步后按条件扫描：一个 `/api/state?views=…&instances=[…]` 请求取齐所需，命令直接 `POST /api/command` 不带视图，发完整页同步一次；失败只记日志、不弹提示）、各面板与通用的选英雄控件。为它补的通用能力：`UiProps.views`（组件多取的视图）、`settlements.addNearbyInfo`（附近列表的补充信息，营寨插件填等级）、营寨插件的静态视图 `npc-camps.garrisons`（各类、各级每路守军）、共享的 `nameKey`（`src/shared/heroes.ts`）。
- **个性化**（`personalization`，1.4.1）：站点级外观由 GM 运行时选择（图标、站点标题，可扩展）。每个字段是登记它的插件自己的规则（`ctx.config.define`，校验用 `personalization.parser`），再经 `personalization.add` 列进 GM 的"个性化"页签。值经静态视图 `personalization.site` 下发（按规则版本，不进同步），前端插件 `personalization` 设置标签页图标和标题并存进 localStorage（登录页也用上）。内置图标是静态文件 `public/icons/<id>.svg`（清单 `data/icons.csv`，第一行为默认，即 `public/favicon.svg` / `favicon.ico`），不经过 Worker，永不 404。上传经 `POST /api/gm/personalization/image`（≤256 KB，PNG/SVG/WebP/ICO，按文件头识别；含脚本、事件、外链、实体的 SVG 一律拒绝），存进 R2 `personalization/<哈希>.<扩展名>`，公开路由 `/api/files/personalization/:name` 下发，SVG 带 CSP sandbox。GM 上传图片统一用 `src/runtime/files.ts` 的 `sniffImage` / `unsafeSvg` / `putImage` / `imageName` / `imageResponse`（拼图和个性化共用）。
- **规则的专用编辑器**：见上面"不透明科技"；插槽 `gm-rule-editors`。
- **规则的专用编辑器**：后端插件 `ui.slot({ slot: 'gm-rule-editors', widget, props: { rule: '<规则键>' } })`，规则页里这条规则就用那个控件代替通用编辑器（拿到 `value`、发出 `update`；保存、撤销、恢复默认照旧）。
- **地形**（`terrain`）：整张地图是对象存储里的**一个文件**（`terrain/<内容哈希>.txt`，1024×1024 个单字母代码，按 32×32 的块依次排列、块内按行），任一格就是已知偏移上的一个字符，读取不用解析；D1 的 `terrain_version` 只记当前是哪个文件（迁移 `0010`）。每个 isolate 每个文件只从 R2 读一次（模块级缓存，文件名不变内容就不变），浏览器同样只取一次（`GridGround.file`，地址用 `game.fileUrl`：配了公开域名直接取 R2，否则 `/api/files/terrain/<名>`）。地形代码必须是可打印的 ASCII 字符。按城区所在格给建筑产出加成（`buildings.addDistrictBonus`）。GM 改格子（`terrain.paint`）、导入整张地图（`terrain.importMap`，`pnpm map:import` 用）都会先结算受影响的城池，再生成新文件（`api.putFile`）、在同一个提交里切换过去；改地图的命令锁住 `terrain:map`，两个 GM 同时改会重试而不是互相覆盖。1.4 以前的世界（每块一行 `terrain_chunks`）照常读旧表，GM 命令 `terrain.exportToFile`（GM 后台“把地图移进文件”）把它移进文件。为什么这样做（changelog 247、用户 2026-10-17）：铺满全图的营寨和地形逐行写库，导入一张地图约 15 万行写入，超过免费计划每天 10 万行；现在导入时地形只写 `terrain_version` 一行、营寨不写。取舍：GM 改一格也要重新生成整个文件，浏览器下次同步重新下载约 150 KB（地形只有 GM 和导入会改，用户确认）。**按城池存的地形**（1.5.1，用户 2026-10-20："仅入表已经建城的格子。然后index不要存坐标，还是城池的主键"）：`terrain.ofSettlement(api, 城池 id, 格子)` 读表 `terrain_settlements`（迁移 `0028`，一座城一行：这座城自己的城区和周边可建外城的格子的代码，JSON，带地图版本），只有行里没有、或版本旧了才读地图文件，由命令在提交时重写这一行（视图只读）；城池被移除时删行。产量的城区加成、城池页的地形、营寨战利品的地形偏向都走它，新实例不必为这些读整张地图（线上平均每个实例只处理约 8 个请求）。地图页、流寇看目标周围的地形分布仍读文件。
- **声望与流寇**（`prestige` + `starter-prestige`、`bandits` + `starter-bandits`）：声望监听 `resources.onSpent / onRefunded`（只算 `spend`），官职按最高声望、只升不降，官职的 stat 加成（分城上限）由 CSV 声明；流寇每个玩家一条时间线 `bandits:<玩家>`，按近期声望增速定间隔、按 `terrain.mix` 抽类型、按当前声望定等级、按 `armies.scouting` 定到达时间，经 `armies.addIncoming` 出现在来袭警报，到达时走 `pvp.raid`（守军、掠夺、战报），胜负改声望并抽掉落池（`bandits.addDrop`，如 `starter-levies` 的招募令）。
- **邮箱**（`mail`）：列表视图 `mail.inbox` 只发列表头（含附件状态 `gift`），按 `(at, id)` 走索引 `mail_messages_page` 分页，个人邮件和群发合成一条语句；整封邮件是视图 `mail.message`（参数 `mail`），打开时才取，前端按 id 缓存（1.4.1：每页 4 条语句 → 2 条，30 封战报约 29 KB → 4.7 KB）。GM 群发是 `mail_broadcasts` 的一行（迁移 `0014`），只送达发送前创建的账号（`accounts.joinedAt`）；玩家读过、删除、领取后才在 `mail_broadcast_marks` 写一行。附件是 `rewards` 的奖励（不能是需要选城池的），命令 `mail.claim` 在玩家锁下只能领一次，附件没领的不能删。`mail.send` 随当前命令一起提交；`war-reports` 监听 `armies.onArrive`、`pvp.onDefense`、`troops.onShortage`，把它们写成邮件。前端按邮件的 `kind` 选择显示组件（后端 `ui.mail(kind, 组件名)` 声明）；一般用通用的 `ui.report`：发信的插件用 `mail.present(kind, fn)` 把数据整形成报告，读信时生成（战报就是这样）。

### 2.6 前后端：界面由后端声明

前端只通过 `/api/*` 与 Worker 通信，请求 / 响应类型统一定义在 `src/shared/api.ts`。界面布局是"顶部页面标签 + 中间左 1/3、右 2/3 两栏（各自滚动）+ 底部状态栏"，窄屏时变为单栏（见 `docs/design/ui.md`）。**显示什么、放在哪都由后端声明**：后端插件用 `ui` 服务（`ui.page / block / entry / band / slot / mail / dynamic`）声明页面、栏里的内容块、建筑入口里的内容块、窄带、插槽和邮件的显示方式，经 `/api/meta` 的 `ui` 下发；声明带 `props.view` 时，前端自动订阅这个视图并交给控件。官方界面几乎全部由**通用控件**画出（`web/widgets/`，由前端插件 `widgets` 注册；数据形状在 `src/shared/ui.ts`，前后端共用的文字格式化在 `src/shared/format.ts`）：后端插件的视图返回控件认得的形状（例如 `buildings.slots` 返回 `CardsData`），不用写前端。控件一览与用法见 `docs/design/ui.md` 第 3 节和 [插件开发指南](plugin-guide.md) 第 7 节。邮件由发信的插件用 `mail.present(kind, fn)` 在读信时整形成通用报告。剩下的前端插件只有外壳（`auth`、`settlement`、`resource-bar`、`forms`）、`widgets`、邮箱 `mail` 和 GM 后台 `gm-panel`；第三方需要通用控件表达不了的界面时，写自己的前端插件（`game.widget` 注册），放进 `extensions/`。另外 `game.gate(Component)` 接管整个界面（如登录页），被接管的启动可以用 `game.restart(data?)` 原地重新启动（沿用已取到的 meta，不重载页面；`data` 交给本插件下一次 `setup` 的 `game.handoff()`，例如登录接口返回的用户，这样不用再问一次 `/api/auth/me`；完整启动之后调用则是重载页面），`game.showPage(id)` 切换页面，插件之间用 `game.provide / use` 共享服务。**文案跟插件走**，各插件只管自己的键（见 2.8 节）。**扩展**：`src/plugins.ts`、`web/plugins.ts` 在构建时收集 `extensions/*/server.ts`、`extensions/*/client.ts`（`import.meta.glob`），第三方不用改官方清单。组件内通过 `useGame('<所属前端插件 id>')` 拿到 `state`、`view()`、`command()`、`request()` 等。前端每 60 秒与服务器同步一次（页面在后台时暂停），期间数值按产率在本地插值。

### 2.6.1 数据与显示分离：前端大对象与前端视图（1.5.1）

硬原则见 AGENTS.md"数据与显示彻底分离"。实现：

- **服务端只有数据视图**：`ctx.views.add` 返回玩家的实体和规则算出的派生数值（加成后的倍率、上限、产量……），类型写在 `src/shared/api.ts` 并登记进 `ViewMap`；带戳（`settlements.stamp` / `playerStamp` 等），没变就不发。其他插件经钩子给的说明短句（`addEffectLines`、`stats.describe` / `stats.factors` 的来源明细）以 `UiText`（键 + 变量）作为数据随带；**卡片、行、分组、标题、按钮、计时条这些排版一律不在服务端拼**。
- **前端大对象**（`web/core/game.ts`）：每个数据视图按请求它的参数存（`<视图>|<参数 JSON>`），另一座城的不覆盖；`game.data(视图, 参数?)` 读，`game.ensure(需要的数据, 最长缓存毫秒?)` 按需取（一次请求，以实例的形式带参数）。
- **前端视图**：原来的显示视图（`buildings.slots` 等）改成浏览器里的纯函数，定义写在 `web/plugins/<前端插件>/views.ts`（`defineClientView({ id, needs, compute })`，类型在 `src/shared/client-views.ts`；`compute` 经 `get.data` / `get.static` / `get.meta` 读数据视图、静态视图和 meta 里的名称与图标），汇总在 `web/views.ts`；前端插件用 `game.clientView(v.id, v)` 注册。`game.view(id)` 遇到前端视图就返回它的计算结果，同步时自动改取它 `needs` 里的数据视图，所以服务端的界面声明（`props.view`）和通用控件都不用改。拼接用的文案键沿用拥有它的服务端插件的键（`uiTexts('<服务端插件 id>')`），i18n CSV 不动。
- **已迁到浏览器的显示视图**（前端视图 ← 数据视图）：`buildings.slots` ← `buildings.state` + 静态 `buildings.catalog`；`resources.production` ← `resources.sources` + `resources.pool`；`settlements.districts` ← `settlements.outline`（轻量详情）；`starter-heroes.posts-city` / `-entry` ← `starter-heroes.posts`；`starter-siege.queue` / `.rows` ← `starter-siege.wall`；`troops.training` ← `troops.garrison`；`prestige.badge` ← `prestige.status`；`mail.announcement` ← `mail.notice`。
- **地图格子**：`world-map.grid`（`ui.grid` 页面的 `gridView`）← `world-map.window`（窗口里谁占哪格 `held`、各图层的数据 `layers[图层 id]`、旁边列表的数据 `sides[id]`、`now`、地面）+ 静态 `npc-camps.levels` + meta `settlementKinds`（名称、图标）/ `map`（大小）。服务端的 `worldMap.addLayer(id, (api, tiles, held) => 数据)` / `addSide(id, …)` 只返回数据；前端插件 `world-map`（`web/plugins/world-map`）拼格子，扩展点 `world-map.layer`（`MapLayer`）：各插件用 `defineClientPart({ point: 'world-map.layer', id: 服务端插件 id, part })` 按同一个 id 画自己的数据（`web/plugins/settlement/map.ts`：城池的图标、边框、说明、"打开"和周边 NPC 列表；`web/plugins/npc-camps/map.ts`：营寨的等级、守军、寨栅、战利品、恢复时间；标记层 `markers` 在 world-map 自己），按 `order` 合并（与原来服务端的合并规则相同），world-map 不认识城池和营寨。地图窗口是同步的 instance：`game.instance` 遇到前端视图，把它的数据视图按同样的参数作为子 instance（`<键>|<视图>`）去取，`game.instanceData(键)` 在浏览器里算出结果（`ui.grid` 用它）。地形的 `ground.info`（每种地形一行、按玩家的加成）仍由服务端给，没有迁。名称、图标、地图大小等不变的对照从 meta 取（`get.meta('resources')`）。
- **科技、道具、商城的前端视图**：科技的 `research.tree / queue / current / options / graph` 由 `research.state` + 静态 `research.techs` 的 `data`；道具的 `items.cards / shortcuts` 由 `items.owned`、`items.extra` + 静态 `items.catalog` / `items.shortcut-cards`；`shop.cards` 由 `shop.wallet` 等）改成浏览器里的纯函数，定义写在 `web/plugins/<前端插件>/views.ts`（`defineClientView({ id, needs, compute })`，类型在 `src/shared/client-views.ts`），汇总在 `web/views.ts`；前端插件用 `game.clientView(v.id, v)` 注册。`game.view(id)` 遇到前端视图就返回它的计算结果，同步时自动改取它 `needs` 里的数据视图，所以服务端的界面声明（`props.view`）和通用控件都不用改。拼接用的文案键沿用拥有它的服务端插件的键（`uiTexts('<服务端插件 id>')`），i18n CSV 不动。
- **前端扩展点**（一个插件只管一个系统）：别的插件要往某个前端视图里加内容时，服务端钩子只给**数据**（数字、id），各自的前端插件把它画成自己的文字：拥有者在共享类型里声明扩展点（例如 `heroes.card` 的 `HeroCardPart = (data) => UiText[]`），前端插件用 `defineClientPart({ point, id: <服务端插件 id>, part })` 定义、`game.clientPart(def)` 注册，并登记进 `web/views.ts` 的 `clientParts`（测试同样跑它）；拥有者的 `compute` 用 `get.parts(point)` 按 id 取。英雄卡片：`heroes.addCardData(pluginId, fn)` 的结果放在 `heroes.state` 每位英雄的 `parts[pluginId]`，前端按服务端的顺序交给同 id 的部件（`realms`：冒险属性 `AdventureStats`；`starter-heroes`：各职务的效果百分比 `HeroRoleEffects`，统兵和守城相同时合成"军事加成"一行）。属性和职务的名称取 meta `heroes`（视图只发职务 id `duty`）。
- **兵种的建筑门槛是数据**：`troops.requireBuilding((api, unit) => { building, level } | null)`（`starter-army` 的兵营等级、`starter-auxiliary` 的辎重营），`troops.garrison` / `troops.overview` 里未满足的写成 `requires: { building, level }`，建筑名取 meta `buildings`，句子"需要{0} {1}级"由前端插件 `troops` 拼（键 `troops.Requires {0} Lv {1}`；命令被拒时服务端用同一个键）。不能驻军的城池（`allowed: false`）不逐个兵种写原因，前端按 `kind` 和 meta `settlementKinds` 说一次。其他插件的门槛（`addTrainingGate`，返回 `UiText`）仍写在 `blocked`。
- **测试**：`test/helpers.ts` 的 `p.views` / `p.shown` 遇到前端视图，先让引擎算它的数据视图和静态视图，再调用同一个纯函数，所以引擎测试照常断言卡片和行。
- **迁移一个显示视图的步骤**：① 在拥有它的服务端插件里加数据视图（戳与原视图相同），返回原 `compute` 用到的全部输入；② 把拼接代码原样搬进前端纯函数（同样的键、同样的结构）；③ 注册前端视图、加进 `web/views.ts`；④ 删掉服务端的显示视图和因此不用的代码；⑤ 改直接请求旧视图的 HTTP 测试；⑥ `pnpm check`。

### 2.7 账号与 GM

- **GM 是用户名等于 `GM_USERNAME` 的账号**（每次请求与密钥重新比对，改名后旧 GM 会话随之失效），登录和普通账号一样校验库里的密码哈希。`GM_PASSWORD` 只是**初始密码**：GM 账号不存在或还没有密码时，用它登录会存下哈希并标记 `must_change`；之后与环境变量无关。镜像因此可以带默认 GM 账号。
- **登录失败保护**（用户 2026-10-20："做一下登录界面的最大重试保护"）：`accounts_login_failures` 按三种键计数，"同一用户名 + 同一 IP""同一用户名""同一 IP"（IP 取 Cloudflare 的 `CF-Connecting-IP`，没有时都算一个地址）；在规则 `accounts.loginLimits` 的 `window` 分钟内分别到 5 / 20 / 30 次，就在 `lock` 分钟内拒绝登录（429 `too_many_attempts`，"请 N 分钟后再试"），**先查锁、再验密码**，被锁时不做哈希。不存在的用户名同样计数，不泄露账号是否存在。登录成功只清"用户名 + IP"那一项。注册时守卫拒绝（邀请码不对等）按 IP 计数（`registerPerIp`，默认 10）。任一项近期失败满 `captchaAfter`（默认 3）次后，要先过 **Cloudflare Turnstile 人机验证**：请求体带 `turnstile`（前端在服务端回 `captcha_required` / `captcha_failed` 后显示验证框），服务端向 `siteverify` 校验；只有同时设了变量 `TURNSTILE_SITE_KEY` 和密钥 `TURNSTILE_SECRET` 才启用（本地、Docker、测试默认不启用），公开的站点密钥经 `/api/auth/me` 的 `captcha` 给前端。过期记录由 `accounts.sessions` 任务顺带清掉。测试 `test/api.spec.ts`、`test/login-guard.spec.ts`。
- **改密码**：每个账号用 `POST /api/auth/password` { oldPassword, newPassword }（类型 `ChangePasswordRequest`）改自己的密码（8–128 个字符，不能与当前相同），该账号的其他会话随即失效。标记了 `must_change` 的账号（`User.mustChangePassword`）不能玩：`session.resolve`（所有游戏接口）返回 403 `password_change_required`，前端此时只显示改密码页；GM 接口（`requireGM`）照常可用，首次运行的地图导入（`scripts/map/import.mjs`，以 GM 身份）因此不受影响。
- **注册仅限邀请码。** `accounts` 本身不决定谁能注册，而是询问所有已注册的"注册守卫"，全部通过才放行；没有任何守卫时注册关闭（安全默认）。`invites` 插件就是一个守卫：原子地占用一次使用次数，注册失败时自动归还。
- **密码**使用 PBKDF2-SHA256（100k 次迭代）加盐哈希；会话令牌只存 SHA-256 摘要；cookie 为 `HttpOnly; SameSite=Lax`（HTTPS 下加 `Secure`）。会话 30 天过期：读取时过期即失效，后台任务 `accounts.sessions` 每分钟再删掉最多 200 条过期会话（按 `expires_at` 的索引，迁移 `0008`），表不会因为弃用的会话越积越多。
- **GM 能力**：邀请码管理、实时规则、查看玩家、对任意玩家执行任意命令（包括 `privileged` 命令）、以玩家身份游玩（本浏览器换成该玩家的普通会话，GM 会话结束），全部写入 `gm_audit`。
- **GM 看到更多**：引擎上下文的 `gmViewer`（GM 用自己的账号玩、或在 GM 后台查看）只用于多显示信息（例如随机道具的成功率），不授予任何权限；权限只看 `privileged`。`session.resolve` 同时返回 `gm`。

### 2.8 多语言（i18n）

每个插件只管自己的键，前缀由框架统一加上，不同插件之间不会冲突。

- **服务端插件**：`data/i18n.csv` 的列为 `key,en,zh-CN`，后面可以加任意语言列（各插件自己决定支持哪些语言）。用 `ctx.services.get('i18n').addCsv(csv, ctx.pluginId)` 登记，每个键成为 `<插件id>.<key>`。同一插件里键重复、缺英文、没有 `en` 列，都会拒绝加载。键通常就是英文原文，可带占位符 `{0}`、`{name}`，由文字的变量填入。`rule:<规则名>` 是 GM 规则说明，`plugin:<id>` 是插件名（GM 后台用）。经 `/api/meta` 的 `i18n` 下发：`{ 语言: { "<插件id>.<key>": 译文 } }`。
- **翻译插槽**：`i18n.inject(csv)`（列 `key,<语言>…`，`key` 是完整键 `starter-content.Farm`）让任何插件增改任何插件的译文、或加一种新语言，社区翻译不用改官方代码。注入的优先于插件自带的；两个注入对同一键给出不同译文时拒绝加载。
- **结构化文字**：服务端发给前端、要显示的文字一律是 `UiText`（`src/shared/ui.ts`）：`{ text: '<插件id>.<key>', vars? }`。`vars` 里的值要么是**值**（数字、格式化好的数量、玩家输入的名字、英雄名字键），原样显示；要么本身是 `UiText`（或它的数组，按语言用顿号 / 逗号连接），先翻译再填入。所以句子永远是"本插件的模式键 + 变量"，前端不用猜一段文字是不是键。产出用 `src/shared/i18n.ts`：
  - 文件顶上 `const text = uiTexts('<插件id>')`，之后 `text('Requires {0} Lv {1}', { 0: keyText(def.name), 1: n })`；
  - `keyText(key)`：已经是完整键的文字（内容名称，如 `starter-content.Farm`）；
  - `literal(s)`：原样显示、不翻译的文字（玩家输入的名字、GM 群发）；
  - `settlements.nameText(s)`：城池名（默认名是键，玩家改过的名字原样显示）；英雄名用 `heroes.nameKey`（名字键，作为值传，前端按语言拼写）。
- **谁的文字**：
  - 系统插件的 `define*`（资源、建筑、兵种、道具、科技、秘境、城池类型、属性、英雄属性 / 场所 / 职务、装备部位 / 底材 / 品质、兵系、流寇、地形、页面标签）用 `i18n.own(text)` 把名称变成**调用方**（正在 setup 的插件，内核 `ctx.caller()`）的键；已经是登记过的键（精确匹配）的保持不变。名称在服务之间以键字符串传递。
  - 由别的名称拼出来的内容名（"某秘境钥匙"、"某兵种招募令"、"某色某套装宝箱"）用 `i18n.derive(key, uiText)` 登记为调用方的键（如 `starter-realms.item:realm-key-misty-marsh`）：服务端在下发 meta 时按各语言的译文拼好，之后它和别的名称一样只是一个键。
  - 钩子返回的文字（拦截原因、战斗加成来源、行军报告备注、英雄卡片行、邮件呈现……）都是登记者自己用 `text()` 产出的 `UiText`。
  - 邮件：`mail.send` 的 `title` 是 `UiText`，存为键 + 变量；GM 群发的标题以 `literal` 显示。
  - 报错：插件文件顶上 `const fail = gameErrors('<插件id>')`，`throw fail(code, 'Unknown tech')` 或带变量的 `throw fail(code, text('Not enough {0}', { 0: keyText(unit.name) }))`；`GameError.text` 随错误响应下发（`error.text`）。内核的报错归 `kernel`，译文在 `src/kernel/i18n.csv`。包一层别的报错时用内核的 `errorText(err)` 取它的文字。
- **前端插件**：`game.messages(语言, { 英文: 译文 })` 登记为 `@<前端插件id>.<英文>`（`@`：前端插件 id 可能与服务端相同）。框架自己的词在 `web/core/messages.ts`（`@core.`）。组件用 `useGame('<插件id>')` 声明归属，`game.t` 依次查本插件、框架、服务端的键。`scripts/check.mjs` 检查每个组件写的 id 与所在目录一致。
- **查找**（`web/core/i18n.ts`）：只按键精确查找：当前语言，再英文，再显示去掉插件 id 的键。不按模式反查句子，也没有"去掉前缀再试"之类的回退；只有布局的键（`{0} · {1}`、`—`）不必写进 CSV，按这个兜底原样显示。
- **检查**：`pnpm check` 的 `scripts/check.mjs` 检查：每条报错和每个 `text('…')` 的键都在所属插件的 CSV 里（只有布局的键除外；``text(`mission:${id}`)`` 这类按 id 取的键要求插件有这一类键）；每个组件 `useGame` 写的插件 id 与所在目录一致；插件和组件不自己格式化数字、日期（一律用 `src/shared/format.ts` / `web/core/format.ts`），不手拼英雄名（用 `heroes.nameKey`）；`.vue` 模板里没有直接写的英文。测试 "translations (i18n)" 用一个什么都有的账号遍历全部视图、各处表单（含建筑入口和 GM 表单）和 meta：每个文字的键都要登记过且有中文（布局键除外），变量里不能是键、不能有英文（应改成 `keyText` / `text`），`literal` 里不能是键。测试里比对文字按结构（键和变量）；需要看整句时用 `test/helpers.ts` 的 `en(ui)` 按英文渲染。

## 3. 开发步骤

> 第三方开发者请先读 [docs/plugin-guide.md](plugin-guide.md)（上手、扩展点、菜谱、测试、提交前检查，配可运行的示例 `examples/`）和插件清单 [docs/plugin_architecture_reference.md](plugin_architecture_reference.md)。本节是更细的分步说明。

### 3.1 新增一个服务端插件

完整、可运行的例子在 `examples/`（讲解见 [docs/plugin-guide.md](plugin-guide.md)）。官方插件：目录 `src/plugins/<id>/index.ts`（`definePlugin`）+ `data/*.csv`，在 `src/plugins.ts` 的数组里加上它；第三方扩展：放进 `extensions/<id>/server.ts`，不用改清单；新 view 的类型登记到 `src/shared/api.ts` 的 `ViewMap`；写测试，`pnpm check`。

- **只写不改**：`api.write()` 只是排队，命令结束后才原子提交；中途抛 `GameError` 什么都不会写入。
- **跨插件的数据只走服务**：例如扣资源用 `resources.spend()`，不要直接写 `resources_balances` 表。
- **纯内容**（新资源、新建筑）请写成类似 `starter-content` 的内容插件，调用 `resources.define` / `buildings.define` / `settlements.defineKind`，不要修改系统插件。
- **平衡相关的数字**尽量用 `ctx.config.define` 暴露出来，GM 就能在不发版的情况下调整。
- **GM 专用操作**写成 `privileged: true` 的命令，放在拥有该数据的插件里；GM 后台会自动列出。
- **GM 需要统计或筛选**时，用 `ctx.reports.add` 写一个只读报表；返回的行里带 `playerId` 列时，GM 后台会自动附上用户名。

### 3.2 界面：先用通用控件，不够再写前端插件

1. 先看通用控件能不能表达（`docs/design/ui.md` 第 3 节）：后端视图返回 `src/shared/ui.ts` 里对应的形状，用 `ui.block / entry / page …` 声明位置，`props.view` 指向视图。简单操作用命令的 `form`。
2. 控件缺一点功能（多一种布局、多一个字段）时，优先**扩展通用控件**（改 `src/shared/ui.ts` 与 `web/widgets/`），让别的插件也能用。
3. 真的需要专门的可视化时，写前端插件：`web/plugins/<id>/index.ts`（官方，在 `web/plugins.ts` 注册）或 `extensions/<id>/client.ts`（第三方，自动发现）+ `.vue` 组件，在 `setup` 里 `game.widget('<id>.<名字>', 组件)` 注册，位置仍由服务端插件声明。组件用 `game.view('<view>')` 读数据、`game.command()` 执行命令，界面文字用 `game.messages('zh-CN', {...})`。参考 `examples/clock/`。

### 3.3 修改表结构

1. 新增一个迁移文件 `migrations/NNNN_<pluginId>_<说明>.sql`（从 `0002` 起编号；如 `ALTER TABLE … ADD COLUMN …`）。**不要修改已发布的迁移文件**，包括基线 `0001_init.sql`（当前版本的全部表结构）。
2. 本地执行 `pnpm db:migrate:local`（`pnpm dev` 也会自动执行）；测试会自动应用全部迁移。
3. 上线时先 `pnpm db:migrate` 再 `pnpm run deploy`，新代码要能兼容迁移前后两种数据。

### 3.4 测试

- `pnpm check`：类型、格式、i18n 静态检查与全部 vitest 测试。
- `pnpm smoke`：浏览器冒烟（`scripts/smoke/run.mjs`，`@playwright/test`；第一次运行前 `pnpm exec playwright install chromium`）：临时库 + 生产构建，逐页、逐个建筑入口、首都旁一座 NPC 要塞的地图格子、GM 后台各页检查控制台错误和未翻译的文字。
- `pnpm profile <地址> [次数] [--bulk]`：按页面剖析 Worker 的 CPU（`scripts/profile.mjs`）。先 `pnpm smoke --keep` 起一个临时库的服务，再对它打出的地址运行：逐页记下前端发的状态请求，在 V8 采样器下重放（经 Cloudflare Vite 插件在 9229 端口开的调试器），打印每页每次请求的 CPU、耗时、响应大小和最耗 CPU 的模块。Worker 里代码运行时时间不走，所以不能靠代码里计时。
- `pnpm requests <地址> [闲置秒数]`：数浏览器发到 Worker 的请求（免费计划按它计费，`scripts/requests.mjs`）。同样对 `pnpm smoke --keep` 的服务运行：登录、在首页闲置（默认 65 秒，含一次定时同步）、逐个打开标签页、回首页、重新加载，每一步列出到达 Worker 的请求和浏览器缓存命中的次数。拆视图、加静态数据后用它确认请求数没有变多。

- `test/kernel.spec.ts`：内核装配（依赖排序、冲突、配置）。
- `test/engine.spec.ts`：引擎语义（原子提交、乐观锁冲突重试）。
- `test/game/*.spec.ts`：真实插件 + 本地 D1 + 假时钟直接测引擎（`engineContext(kernel, id, now, overrides)`），按系统分文件（city、map、research、items、army、battle、mail、heroes、rules、i18n），公共工具在 `test/helpers.ts`；**游戏规则优先写在这里**。每个测试用新的随机玩家 id，互不干扰。断言比对 id、数值和结构，文字比对键和变量（`{ text: 'buildings.Level cap {0} reached', vars: { 0: 1 } }`）；要看整句时用 `en(ui)` 按英文渲染。
- `test/api.spec.ts`：通过 `SELF.fetch` 走完整 Worker → D1 链路（登录、邀请、GM）。测试环境的 GM 账号为 `gm / gm-test-password`，见 `vitest.config.mts`。
