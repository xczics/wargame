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

| 扩展点                     | 用途                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.services.provide/get` | 插件间 API（类型通过 `ServiceMap` 声明合并）；插件的表只能通过它的服务读写                                                                                    |
| `ctx.hooks.on/emit`        | 事件（类型通过 `HookMap` 声明合并），如 `engine:command`                                                                                                      |
| `ctx.config.define`        | 声明一条 GM 可实时调整的规则（默认值 + 校验），读取用 `handle.get(api)`                                                                                       |
| `ctx.commands.add`         | 玩家操作：`parse` 校验输入（内核 `shape` + `fields`，`src/kernel/fields.ts`）+ 异步 `execute`；`privileged: true` 表示仅 GM 可用；可附 `form`，由前端通用渲染 |
| `ctx.views.add`            | 发给客户端的只读数据（资源、产率、商店价格…），前端可用 `?views=` 只取需要的                                                                                  |
| `ctx.reports.add`          | GM 用的跨玩家只读查询（排行、统计、筛选），在 GM 后台 _Reports_ 里运行                                                                                        |
| `ctx.tasks.add`            | 后台任务（每分钟由 cron 触发；要改游戏状态时以玩家身份 `executeCommand`）                                                                                     |
| `ctx.routes.add`           | HTTP 路由                                                                                                                                                     |
| `ctx.meta.add`             | 静态游戏数据（名称、图标），经 `/api/meta` 下发                                                                                                               |

内核还导出与游戏无关的工具：命令输入的 `shape` / `fields`、报错的 `gameErrors` / `errorText`、CSV 解析、规则校验、`seededRandom` / `triangularInt`（一览见 [共享代码登记](shared-code.md) 第 1 节）。

内核还约定了一个"知名服务" `configStore`：哪个插件提供它，GM 覆盖值就从哪里读取（目前是 `gm` 插件，存在 D1）。没有插件提供时一律使用默认值。读取时发现没有任何插件定义的键（规则改名或删除后留下的），会通过它的可选方法 `prune` 自动删除并记入审计日志；已知键的非法值保留，由 GM 在后台修正，日志里每种问题只警告一次。

### 2.3 数据存储与并发

**所有数据都在一个 D1 库里**（账号、邀请码、GM 配置、玩家存档）。每个插件拥有以自己 id 为前缀的表（`resources_balances`、`buildings_slots`…），表结构在 `migrations/`。

- **按需读写。** 命令和 view 只查询需要的行（例如某个玩家的资源），不存在"整份存档"。同一次调用内，多个插件读同一批数据时用 `api.memo()` 共享，只查一次。
- **命令 = 原子的工作单元。** `execute` 期间的所有写入只是排队，命令结束后由引擎用**一个 `db.batch()`** 提交：要么全部成功，要么全部不生效。抛出 `GameError` 时什么也不写。
- **乐观锁。** 每条命令自动锁定 `player:<id>`；跨玩家的命令（攻打、流寇）再 `api.lock('player:<对方>')`。提交时在同一个 batch 里把这些锁的版本号 +1，数据库触发器（`engine_locks_cas`）发现版本已被别人改过就中止整个 batch，引擎用新数据重试（最多 5 次）。因此玩家连点、多个标签页同时操作都不会重复扣款。
- **数据库兜底约束。** 例如资源 `CHECK (amount >= 0)`、建筑数量 `CHECK (count >= 0)`：即使代码有 bug，也写不进非法数据。
- **离线产出按需结算。** 资源行存"结算时的数量 + 结算时间"。读取时按**当前规则**现算：`数量 + 产率 × 经过时间`（经过时间上限为规则 `engine.maxOfflineSeconds`，默认 12 小时）。只有命令会把结算结果写回。任何改变产率的操作（买建筑、GM 改数量）都会先把旧产率下的收益结算落盘。
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
- **科技（透明科技树）**：在建有**研究所**的城池里研究；每座城池一个队列，同一科技不能在两座城同时研究；研究所等级提升研究速度。科技在定义上声明 `unlocks`（按等级段拦截建筑，例如农业 1/2/3 分别解锁农田 6–10 / 11–15 / 16–20 级）、`stats` 和 `percent`（给该玩家所有城池加成）。费用由进行研究的城池支付。运行时可以用 `research.registerNode` 注册科技树之外的新节点（给将来的不透明科技 / 基金委插件用），并用 `research.grantLevel` 直接授予等级；`research.addCostModifier` 预留给英雄的研究加成。
- **NPC 城池**：`npc-camps` 用 `settlements.defineKind({ npc: true })` 注册 NPC 类型（据点、要塞），每座 1–10 级（表 `npc_camps_levels`），每级的名称、每路守军（按兵种系列 + 等级从 `troops.list()` 找兵种）、寨栅、抢资源（按地形偏置，用 `terrain.bonus`）/ 抢兵、守将加成都在 `levels.csv`（GM 规则 `npc-camps.levels`）；GM 命令 `npc-camps.spawn` / `spawnAt` 生成，后台任务按目标数量和等级权重补充。行军任务 `uproot`（命令 `npc-camps.uproot`，地图格子上的表单）：目标须在玩家某座城池的外城范围（`settlements.outerArea`）内，到达时照常交战，五路全胜就用 `settlements.remove` 把营寨删掉（先 `api.lock` 这座营寨；`onRemoved` 里删掉自己的等级行）。
- **上限与加成**：都做成 stat（例如外城科技上限、建造队列、库存上限），科技、道具、建筑只需往里加加成。
- **服务端驱动的表单**：命令附带 `form`，`prepare()` 决定当前是否可用并填好选项；前端 `forms` 插件用 `<FormOutlet placement="...">` 通用渲染。建外城、出兵、训练、改名都是这样实现的，没有专门的前端代码。表单还可以声明三种前端即时规则（服务端照样再校验）：`budgets`（若干字段之和不超过其他字段 × 权重之和，例如辎重不超过载重）、下拉的 `distinct` 互斥组、选项的 `when` 条件（只在另一个字段取某值时出现）。需要专门编辑器的字段用 `type: 'widget'`（`widget` 名 + 服务端给的 `data`），前端插件用 `forms.widget(name, { component, payload(value, field) })` 注册。通用的有 `ui.lanes-input`（`LanesInputData`：几路，每路选一组并分配数量，共用一个按另一字段取值的"池子"，另有一个不分组的格子；输出的键名由 `data.output` 指定）——攻打的阵列编辑器就是它。

### 2.5 游戏系统

玩法细节见 `docs/design/gameplay.md`；这里只讲系统之间怎么接。

- **时间线**（`timeline`）：需要时间的事（建造完成、训练完成、军队到达 / 回城、短缺的每一轮）都是实体（`settlement:<id>`、`army:<id>`、`player:<id>`）上的定时事件，在"下次用到这个实体"时按时间顺序处理（只读视图里也处理，但写入被丢弃）；处理前先把资源结算到事件时刻。每分钟的清扫任务 `timeline.sweep` 以拥有者身份处理没人看的实体，所以离线玩家的事也按时落库。只读视图里处理的结果不落库，所以需要立即提交的地方要用命令（例如前端在军队到点时调用 `armies.sync`）。本地 `pnpm dev` / `pnpm preview` 由 `vite.config.ts` 的 `localCron` 每分钟触发一次定时任务，与线上一致。
- **资源池**（`resources`）：只有登记过的持有者种类（`addHolderKind`，目前是 `settlement`）有资源池；时间线推进其他实体（如军队）时不结算资源。
- **数值（stat）**（`stats`）：`(基础 + Σ固定值) × (1 + Σ百分比)`。上限、容量、队列、加成都做成 stat，拥有者 `define`，给加成的 `contribute`。
- **部队**（`troops`）：兵种注册（数值可以是当前规则的函数）、训练（每座兵营一条队列：一批在训、其余为训练计划，加入时付费、开始前可取消全额返还；`trainedAt` 决定在哪个建筑训练）、驻军、维持开销（资源消耗方）、短缺时分轮溃逃 / 降级（`addShortageRule`、`onShortage`）。训练需求 `addTrainingRequirement`（例如 `starter-levies` 的招募令额度：2–4 级兵每个 1 点，下达训练时扣除）。
- **行军**（`armies`）：每次出兵有一个**任务**（`defineMission`）：`attack`（到达时交给遭遇处理函数 `addEncounter`，如 `pvp`、`npc-camps`）、`transfer`（派遣到自己的城池）、`transport`（运往 / 运回自己的另一座城池，部队都返回）、`settle`（`settling` 插件：筑城）、`uproot`（`npc-camps`：拔除外城范围内的营寨）。任务名是定义它的插件的键（`mission:<id>`），`missionName(id)` 给战报等处使用。出发时一次扣清往返粮饷、辎重和任务费用；任务的到达结果决定卸货、驻扎还是返回。附加选项（`addSendOption`，如阵列、带兵英雄）可限定任务：`missions` 列出任务，`forBattle` 表示用于所有要交战的任务（任务上标 `battle: true`，如攻打、拔除），阵列就是这样。整支军队的速度可以由 `addPaceModifier` 改写（军车载最慢的兵，见 `starter-auxiliary`：辎重营训练的军医 / 辎重队 / 军车，军医是战斗的伤亡钩子）。事件：`onArrive`、`onReturn`。
- **战斗**（`battle`）：五路阵列、兵种系列与相克、`fight()` 按路计算；所有加成走修改器 `addModifier`（固定值 + 百分比，可限定兵种 / 等级），伤亡每一步可由 `addCasualtyHook` 修改（辅助兵种）。`pvp` 锁定双方后调用它，同一次提交里完成战斗、损失和掠夺（`onDefense`）。
- **科技**（`research` + `starter-research`）：research 管研究队列、等级、建筑等级段拦截、树上的位置（门类 / 阶 / 题注 / 前置）和卡片上的效果展示（`addEffectDescriber`）；科技的具体效果由 `starter-research` 按 `effects.csv`（GM 规则 `starter-research.effects`）接到各系统现有的接口：stat（固定 / 百分比、每种资源自己的产出 stat `resources.output.<id>`、建筑等级上限 `buildings.cap.<id>`、辎重 `armies.cargo`、斥候 `armies.scouting`、招募候选 `heroes.candidates`、晋升额度 `battle.promotionCost`、城墙 `starter-defense.wallStrength / wallBreach`）、战斗修改器、建造 / 训练 / 维持 / 研究时间修正、行军速度（`armies.addSpeedModifier`）、地形加成（`terrain.addBonus`）。
- **英雄**（`heroes` + `starter-heroes`）：属性、招募地点、职务都是注册的；职务带来的加成通过其他系统已有的接口接入（产出 stat、建造 / 训练时间修正、维持修正、科研费用修正、战斗修改器），其他系统不知道英雄的存在。等级与成长也在 heroes：`grantExp` 升级（天赋点按天生属性自动分配、自由点由玩家 `heroes.allocate`），`addAttributeBonus` 让其他插件（如装备）加属性，效果一律按 `attributesOf`（自身 + 加成）计算；属性变化前 `onAttributesChange` 通知内容插件先结算。
- **秘境**（`realms` + `starter-realms`）：英雄单独冒险，不经过战斗系统。realms 管地图占格（`world-map.addMarkers` 让它显示在地图上）、解锁、冒险结算（`src/shared/realms.ts` 的 `fightGroups`，前后端共用）、奖励池（`addDrop` / `addClearReward`）、重伤与疗伤、战报邮件；秘境、怪物、冒险属性公式（`addHeroStats`）、掉落和钥匙由 starter-realms 按 CSV 注册。冒险在开始时就决定结果，结束事件挂在英雄挂靠城池的时间线上，到点一次发放。`realms.speedUp` 缩短冒险或疗伤（GM 命令 `realms.hasten`）。
- **装备**（`equipment` + `starter-equipment`）：equipment 只管装备实例（随机出的数值存 JSON）、部位与部位组（饰品，每名英雄的组上限由内容给出）、最低等级、穿戴、按城池存放（stat `equipment.storage`，同城英雄共用）和拆解，数值键自由，只认 `attr.<属性>`（经 `heroes.addAttributeBonus` 生效）；starter-equipment 定义七套常规装备、四套饰品、五色稀有度、武库和秘境商店，并把装备接到秘境（奖励池按套装 × 颜色成项、`adv.*` 冒险属性）和战斗（`battle.*` 每路固定值）。
- **商城与道具**（`shop` + `starter-shop`，道具效果在 `starter-items`）：shop 管元宝钱包（属于玩家、不能为负）、商品、每日限购、购买记录和 GM 发放；商品表在 starter-shop 的 CSV。道具效果都走各系统的通用接口：资源 `resources.add`、加速 `buildings / troops / research.speedUp`、增产 stat `resources.productionFactor`（到期由时间线事件移除）、英雄 `heroes.grantExp / resetFree`、疗伤 `realms.healNow`。
- **守城器械**（`starter-siege`）：城墙入口的两张表单（城防工事、守城器械）、每城一个建造队列（时间线事件完成）、维持开销（`resources.addConsumer`）、战斗修改器（工事按攻守方给百分比，器械给守方每路固定值）；费用 / 维持 / 时间按数值的幂次公式。
- **地形**（`terrain`）：32×32 一块存储，按城区所在格给建筑产出加成（`buildings.addDistrictBonus`）；GM 可改格子、导入整张地图（先结算受影响的城池）。
- **声望与流寇**（`prestige` + `starter-prestige`、`bandits` + `starter-bandits`）：声望监听 `resources.onSpent / onRefunded`（只算 `spend`），官职按最高声望、只升不降，官职的 stat 加成（分城上限）由 CSV 声明；流寇每个玩家一条时间线 `bandits:<玩家>`，按近期声望增速定间隔、按 `terrain.mix` 抽类型、按当前声望定等级、按 `armies.scouting` 定到达时间，经 `armies.addIncoming` 出现在来袭警报，到达时走 `pvp.raid`（守军、掠夺、战报），胜负改声望并抽掉落池（`bandits.addDrop`，如 `starter-levies` 的招募令）。
- **邮箱**（`mail`）：`mail.send` 随当前命令一起提交；`war-reports` 监听 `armies.onArrive`、`pvp.onDefense`、`troops.onShortage`，把它们写成邮件。前端按邮件的 `kind` 选择显示组件（后端 `ui.mail(kind, 组件名)` 声明）；一般用通用的 `ui.report`：发信的插件用 `mail.present(kind, fn)` 把数据整形成报告，读信时生成（战报就是这样）。

### 2.6 前后端：界面由后端声明

前端只通过 `/api/*` 与 Worker 通信，请求 / 响应类型统一定义在 `src/shared/api.ts`。界面布局是"顶部页面标签 + 中间左 1/3、右 2/3 两栏（各自滚动）+ 底部状态栏"，窄屏时变为单栏（见 `docs/design/ui.md`）。**显示什么、放在哪都由后端声明**：后端插件用 `ui` 服务（`ui.page / block / entry / band / slot / mail / dynamic`）声明页面、栏里的内容块、建筑入口里的内容块、窄带、插槽和邮件的显示方式，经 `/api/meta` 的 `ui` 下发；声明带 `props.view` 时，前端自动订阅这个视图并交给控件。官方界面几乎全部由**通用控件**画出（`web/widgets/`，由前端插件 `widgets` 注册；数据形状在 `src/shared/ui.ts`，前后端共用的文字格式化在 `src/shared/format.ts`）：后端插件的视图返回控件认得的形状（例如 `buildings.slots` 返回 `CardsData`），不用写前端。控件一览与用法见 `docs/design/ui.md` 第 3 节和 [插件开发指南](plugin-guide.md) 第 7 节。邮件由发信的插件用 `mail.present(kind, fn)` 在读信时整形成通用报告。剩下的前端插件只有外壳（`auth`、`settlement`、`resource-bar`、`forms`）、`widgets`、邮箱 `mail` 和 GM 后台 `gm-panel`；第三方需要通用控件表达不了的界面时，写自己的前端插件（`game.widget` 注册），放进 `extensions/`。另外 `game.gate(Component)` 接管整个界面（如登录页），`game.showPage(id)` 切换页面，插件之间用 `game.provide / use` 共享服务。**文案跟插件走**，各插件只管自己的键（见 2.8 节）。**扩展**：`src/plugins.ts`、`web/plugins.ts` 在构建时收集 `extensions/*/server.ts`、`extensions/*/client.ts`（`import.meta.glob`），第三方不用改官方清单。组件内通过 `useGame('<所属前端插件 id>')` 拿到 `state`、`view()`、`command()`、`request()` 等。前端每 60 秒与服务器同步一次（页面在后台时暂停），期间数值按产率在本地插值。

### 2.7 账号与 GM

- **GM 是用户名等于 `GM_USERNAME` 的账号**（每次请求与密钥重新比对，改名后旧 GM 会话随之失效），登录和普通账号一样校验库里的密码哈希。`GM_PASSWORD` 只是**初始密码**：GM 账号不存在或还没有密码时，用它登录会存下哈希并标记 `must_change`；之后与环境变量无关。镜像因此可以带默认 GM 账号。
- **改密码**：每个账号用 `POST /api/auth/password` { oldPassword, newPassword }（类型 `ChangePasswordRequest`）改自己的密码（8–128 个字符，不能与当前相同），该账号的其他会话随即失效。标记了 `must_change` 的账号（`User.mustChangePassword`）不能玩：`session.resolve`（所有游戏接口）返回 403 `password_change_required`，前端此时只显示改密码页；GM 接口（`requireGM`）照常可用，首次运行的地图导入（`scripts/map/import.mjs`，以 GM 身份）因此不受影响。
- **注册仅限邀请码。** `accounts` 本身不决定谁能注册，而是询问所有已注册的"注册守卫"，全部通过才放行；没有任何守卫时注册关闭（安全默认）。`invites` 插件就是一个守卫：原子地占用一次使用次数，注册失败时自动归还。
- **密码**使用 PBKDF2-SHA256（100k 次迭代）加盐哈希；会话令牌只存 SHA-256 摘要；cookie 为 `HttpOnly; SameSite=Lax`（HTTPS 下加 `Secure`）。
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

- `test/kernel.spec.ts`：内核装配（依赖排序、冲突、配置）。
- `test/engine.spec.ts`：引擎语义（原子提交、乐观锁冲突重试）。
- `test/game/*.spec.ts`：真实插件 + 本地 D1 + 假时钟直接测引擎（`engineContext(kernel, id, now, overrides)`），按系统分文件（city、map、research、items、army、battle、mail、heroes、rules、i18n），公共工具在 `test/helpers.ts`；**游戏规则优先写在这里**。每个测试用新的随机玩家 id，互不干扰。断言比对 id、数值和结构，文字比对键和变量（`{ text: 'buildings.Level cap {0} reached', vars: { 0: 1 } }`）；要看整句时用 `en(ui)` 按英文渲染。
- `test/api.spec.ts`：通过 `SELF.fetch` 走完整 Worker → D1 链路（登录、邀请、GM）。测试环境的 GM 账号为 `gm / gm-test-password`，见 `vitest.config.mts`。
