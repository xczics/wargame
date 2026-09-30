# Wargame

一款运行在 Cloudflare Workers 上的放置类（idle）网页游戏。架构原则是 **"一切皆插件"**：内核只负责装配，资源、建筑、账号、邀请码、GM 后台乃至前端界面都由插件提供。

- 后端：Cloudflare Workers + D1（全部数据：账号、邀请码、GM 配置、玩家存档；按行读写、原子提交、乐观锁）
- 前端：Vue 3 单文件组件 + TypeScript，Vite 构建，由 Workers Static Assets 托管；前后端只通过 JSON API 通信，接口类型定义在 `src/shared/api.ts`，两端共用
- 语言 / 工具：TypeScript、pnpm、Vite + `@cloudflare/vite-plugin`（一个开发服务器同时跑前端和 Worker）、Vitest（`@cloudflare/vitest-plugin`，测试直接跑在 workerd 里）

**玩法与权限模型**：部署时通过 Worker 密钥指定一个超级用户（GM）。GM 登录后可生成邀请码并分享链接，玩家只能凭邀请码注册；GM 还能在后台实时调整游戏规则（产率、成本、初始资源、离线上限…）、查看和修改任意玩家的数据，所有操作记入审计日志。

---

## 1. 环境要求

| 工具            | 版本                                          | 安装方式                                                         |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Node.js         | ≥ 22（`.node-version` 写的是 26）             | `brew install node`（务必**显式安装**，见下方说明）或 mise / fnm |
| pnpm            | 12.x（见 `package.json` 的 `packageManager`） | `brew install pnpm`                                              |
| Cloudflare 账号 | —                                             | 仅部署时需要                                                     |

> ⚠️ **不要让 Node 以"依赖"身份存在于 Homebrew 中。** 如果 node 是被别的 formula 顺带装上的，
> 一旦那个 formula 不再依赖它，下一次任意 `brew install` 触发的自动清理（autoremove）会把 node 静默删掉。
> 用 `brew install node` 显式安装一次即可（或 `brew tab --installed-on-request node`）。

## 2. 快速开始

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 本地 GM 账号：GM_USERNAME / GM_PASSWORD，按需修改
pnpm dev                          # 应用本地 D1 迁移，再启动 http://localhost:5173（前端热更新 + Worker）
```

1. 用 `.dev.vars` 里的 GM 账号登录（首次登录会自动创建该账号），页面下方出现 **GM console**。
2. 在 _Invites_ 里生成邀请码（可设最大使用次数、有效期、备注），链接会自动复制到剪贴板。
3. 在另一个浏览器 / 无痕窗口打开链接 `http://localhost:5173/?invite=XXXXX-XXXXX` 注册玩家。
4. 新玩家自动获得一座首都（地图上随机空地，1 个内城 + 1 个外城）。在 **City** 页的外城栏位建农田 / 伐木场等资源建筑，在内城建仓库、宫殿；建造需要时间，完成后自动刷新。关掉页面再回来，离线产出自动结算（库存上限内）。
5. 用 City 页下方的表单扩建外城；在 **Map** 页选空地建分城或要塞。
6. GM 在 _Rules_ 里修改规则（例如把 `buildings.productionMultiplier` 改成 `10`），玩家刷新即生效。

## 3. 本地测试数据（持久化）

本地运行产生的所有数据（账号、会话、邀请码、GM 规则、审计日志、玩家存档）都保存在 **`.data/local/`**（已被 git 忽略）。**重启 `pnpm dev` / `pnpm preview` 后数据仍在**，只有显式执行下列命令才会改变：

| 命令                       | 作用                                                |
| -------------------------- | --------------------------------------------------- |
| `pnpm data:reset`          | 删除全部本地数据，并重新建好空表                    |
| `pnpm data:backup [名称]`  | 快照到 `.data/backups/<名称>`（不写名称则用时间戳） |
| `pnpm data:restore <名称>` | 用快照替换当前数据（之后自动补跑新的迁移）          |
| `pnpm data:list`           | 列出已有快照                                        |

- 执行 `data:reset` / `data:restore` 前请先停掉 `pnpm dev` / `pnpm preview`（它们会占用数据库文件）。
- `pnpm dev`（开发，热更新）与 `pnpm preview`（生产构建后本地运行，最接近线上）**共用同一份数据**。
- 自动化测试（`pnpm test`）使用独立的临时存储，不会读写 `.data/`。
- 查看或手动修改数据：`pnpm exec wrangler d1 execute DB --local --persist-to .data/local --command "SELECT * FROM accounts_users"`。

## 4. 常用命令

| 命令                    | 作用                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`              | 应用本地 D1 迁移 + Vite 开发服务器（Vue 热更新 + Worker + D1）                                                     |
| `pnpm preview`          | 生产构建后在本地运行（本地部署测试），数据同样保存在 `.data/local`                                                 |
| `pnpm build`            | 构建前端和 Worker 到 `dist/`                                                                                       |
| `pnpm test`             | Vitest 监听模式                                                                                                    |
| `pnpm check`            | **提交前必跑**：类型检查（Worker、测试、Vue）+ 格式检查 + 全部测试                                                 |
| `pnpm typecheck`        | 仅类型检查（`tsc` 两套配置 + `vue-tsc`）                                                                           |
| `pnpm format`           | Prettier 格式化                                                                                                    |
| `pnpm data:*`           | 本地测试数据的清除 / 备份 / 恢复，见第 3 节                                                                        |
| `pnpm map:generate`     | 生成地图（`--seed`，输出 `.data/maps/<seed>/` 的 map.csv、preview.png、stats.json），见 `scripts/map/generate.mjs` |
| `pnpm map:import <csv>` | 把地图导入正在运行的游戏（默认 `http://localhost:5173`，`--url` 指定；用 GM 账号，整张覆盖，要求确认）             |
| `pnpm db:migrate:local` | 把 `migrations/` 应用到本地 D1（`pnpm dev` 会自动执行）                                                            |
| `pnpm db:migrate`       | 把 `migrations/` 应用到**线上** D1                                                                                 |
| `pnpm cf-typegen`       | 修改 `wrangler.jsonc` 的 binding 后重新生成 `worker-configuration.d.ts`                                            |
| `pnpm run deploy`       | 构建并部署到 Cloudflare                                                                                            |

## 5. 目录结构

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
  plugins/
    accounts/              用户名密码登录、会话、注册守卫、GM 超级用户
    invites/               GM 生成的邀请码，作为注册守卫
    gm/                    GM 后台：实时规则、玩家工具、审计日志；提供 configStore
    http-api/              /api/meta、/api/state、/api/command
    forms/                 服务端驱动的表单：列出当前可用的命令表单（view ui.forms）
    stats/                 数值 = (基础 + 固定加成) × (1 + 百分比加成)，供上限 / 容量 / 队列等使用
    timeline/              实体的定时事件（建造完成…），读取前按时间顺序处理
    world-map/             1024×1024 环绕地图（-511..512）、格子占用
    resources/             按城池划分的资源池：产出 × 系数 − 维持消耗、库存上限、欠债下限、耗尽事件
    settlements/           城池类型注册表（含 NPC 接口）、内城 / 外城 / 栏位、建城、扩建、地图窗口
    buildings/             建筑类型、策划表 + 递增公式、常规上限 + 突破上限、科技拦截接口、建造队列
    research/              科技：按玩家等级、研究耗时、前置科技、按等级段拦截建筑升级、数值加成
    items/                 背包；可使用的道具自动变成带表单的命令 items.use.<id>
    troops/                兵种系统：兵种注册（数值可随规则变化）、训练（时间线，训练限制 / 时间修正由其他插件注册）、驻军、维持费（资源消耗方）
    armies/                行军：出发（预付往返维持、最短时间、附加选项如阵列）、按最慢兵种速度在环面地图上移动、到达时的遭遇（由其他插件处理）、召回、返回
    battle/                战斗：5 路阵列（防守阵列、进攻阵列）、兵种系列与相克注册、数值修改器、按路计算的战斗公式
    pvp/                   攻打其他玩家：锁定双方、调用 battle 结算、按载量掠夺
    terrain/               地形：按区块存储、城区产出加成（按资源）、GM 修改 / 导入、迷雾插槽
    heroes/                英雄：属性 / 招募地点 / 职务的注册、候选刷新与招募、职务、守城顺序
    npc-camps/             NPC 要塞（抢兵）、NPC 据点（抢粮）：随机阵列 + 营寨防御，GM 命令生成
    player-settlements/    内容：首都、分城、资源要塞、军事要塞，以及内置基础产出
    starter-items/         内容：外城许可、突破石、土地契
    starter-research/      内容：农业 / 林业 / 石工 / 采矿（解锁 6–20 级）、行政（外城上限）、经济（产出加成）
    starter-content/       内容：石头、木头、粮食、金属、货币；资源建筑（钱庄每城区一座）、仓库、宫殿、市政厅
    starter-army/          内容：步兵 / 弓兵 / 骑兵 × 6 级（数值按可调公式计算）、三座兵营、相克、短缺降级规则
    starter-heroes/        内容：酒馆 / 书院 / 听曲楼、六维属性、姓名字库、职务及其加成（产出、建造、训练、维持、科研、战斗）
    starter-defense/       内容：城墙（建城自带 1 级，按级提供防御）
  lib/http.ts              JSON 响应与错误映射
  shared/api.ts            ★ 前后端接口契约（纯类型，无依赖；两端都从这里 import）
migrations/                D1 表结构（每个插件的表以插件 id 为前缀）
index.html                 前端 HTML 外壳（只有一个 #app）
web/                       Vue 前端
  main.ts                  启动：加载插件 → 挂载 App
  plugins.ts               ★ 前端插件清单
  core/                    前端插件宿主（game.ts）、API 客户端、布局 App.vue、数字格式化
  plugins/<id>/            前端插件：auth、forms（通用表单）、settlement（切换城池）、resource-bar、
                           city（城市页）、research（科技页）、troops（部队页）、inventory（道具页）、armies（行军页）、world-map（地图页）、gm-panel
  styles.css               设计 token 与基础元素样式
scripts/data.mjs           本地测试数据的清除 / 备份 / 恢复
vite.config.ts             Vite + Cloudflare 插件（本地数据目录在这里配置）
test/                      kernel / 游戏规则 / HTTP 端到端 测试
```

### 数据文件

内容和设计数值不写在代码里：每个插件目录下的 `data/*.csv` 是它的数据（建筑策划表、兵种公式参数、分摊比例、城墙、科技、道具、各系统的设计数值…），构建时以文本打包进 Worker。GM 在后台的修改覆盖在这些默认值之上。表格格式见 `src/kernel/data.ts` 和各系统插件的 `defineFromCsv` 说明。

## 6. 架构

### 6.1 请求流程

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

### 6.2 内核扩展点

插件在 `setup(ctx)` 中通过 `ctx` 注册一切。所有注册项在内核启动时做冲突检测，重名直接报错。

| 扩展点                     | 用途                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ctx.services.provide/get` | 插件间 API（类型通过 `ServiceMap` 声明合并）；插件的表只能通过它的服务读写                                  |
| `ctx.hooks.on/emit`        | 事件（类型通过 `HookMap` 声明合并），如 `engine:command`                                                    |
| `ctx.config.define`        | 声明一条 GM 可实时调整的规则（默认值 + 校验），读取用 `handle.get(api)`                                     |
| `ctx.commands.add`         | 玩家操作：`parse` 校验输入 + 异步 `execute`；`privileged: true` 表示仅 GM 可用；可附 `form`，由前端通用渲染 |
| `ctx.views.add`            | 发给客户端的只读数据（资源、产率、商店价格…），前端可用 `?views=` 只取需要的                                |
| `ctx.reports.add`          | GM 用的跨玩家只读查询（排行、统计、筛选），在 GM 后台 _Reports_ 里运行                                      |
| `ctx.routes.add`           | HTTP 路由                                                                                                   |
| `ctx.meta.add`             | 静态游戏数据（名称、图标），经 `/api/meta` 下发                                                             |

内核还约定了一个"知名服务" `configStore`：哪个插件提供它，GM 覆盖值就从哪里读取（目前是 `gm` 插件，存在 D1）。没有插件提供时一律使用默认值。读取时发现没有任何插件定义的键（规则改名或删除后留下的），会通过它的可选方法 `prune` 自动删除并记入审计日志；已知键的非法值保留，由 GM 在后台修正，日志里每种问题只警告一次。

### 6.3 数据存储与并发

**所有数据都在一个 D1 库里**（账号、邀请码、GM 配置、玩家存档）。每个插件拥有以自己 id 为前缀的表（`resources_balances`、`buildings_slots`…），表结构在 `migrations/`。

- **按需读写。** 命令和 view 只查询需要的行（例如某个玩家的资源），不存在"整份存档"。同一次调用内，多个插件读同一批数据时用 `api.memo()` 共享，只查一次。
- **命令 = 原子的工作单元。** `execute` 期间的所有写入只是排队，命令结束后由引擎用**一个 `db.batch()`** 提交：要么全部成功，要么全部不生效。抛出 `GameError` 时什么也不写。
- **乐观锁。** 每条命令自动锁定 `player:<id>`；跨玩家的命令（以后的攻打）再 `api.lock('player:<对方>')`。提交时在同一个 batch 里把这些锁的版本号 +1，数据库触发器（`engine_locks_cas`）发现版本已被别人改过就中止整个 batch，引擎用新数据重试（最多 5 次）。因此玩家连点、多个标签页同时操作都不会重复扣款。
- **数据库兜底约束。** 例如资源 `CHECK (amount >= 0)`、建筑数量 `CHECK (count >= 0)`：即使代码有 bug，也写不进非法数据。
- **离线产出按需结算。** 资源行存"结算时的数量 + 结算时间"。读取时按**当前规则**现算：`数量 + 产率 × 经过时间`（经过时间上限为规则 `engine.maxOfflineSeconds`，默认 12 小时）。只有命令会把结算结果写回。任何改变产率的操作（买建筑、GM 改数量）都会先把旧产率下的收益结算落盘。
- **规则改动立即生效。** 每个请求都重新读取配置，所以 GM 改完后，所有玩家的下一次请求（包括尚未结算的离线时间）都按新规则计算。非法的存量覆盖值会被忽略并回退默认值。例外是"初始资源"，它只影响还没有资源记录的新玩家。
- **部分覆盖。** GM 只写想改的字段（如 `{"gold-mine": {"produces": {"gold": 5}}}`），其余字段继续跟随内容插件的默认值。
- **扩展方式。** 单个 D1 库串行执行查询，一个库大约支撑几千人同时在线（取决于查询复杂度）。更大规模时按"区服"拆分：一个区服一个库。插件只通过 `api.db` 访问数据库，拆分时不用改插件。

### 6.4 城池系统

- **地图**：1024×1024，x、y ∈ [-511, 512]，两个方向首尾相接。只存储被占用的格子，主键保证一格只能有一个占用者。
- **城池类型**：由 `settlements.defineKind` 注册，默认有首都、分城、资源要塞、军事要塞；NPC 城池由独立插件以 `npc: true` 注册。
  - "ring" 布局：内城居中，外城逐个占相邻格。第 1–8 座外城在第一圈，更多（道具）在第二圈，最多 24 座。
  - "single" 布局：占 1 格（要塞）。
- **城区与栏位**：内城栏位固定，外城栏位数量随机（GM 可调）。每类城区接受哪些建筑类别由城池类型声明（外城只接受资源建筑，内城只接受非资源建筑）。一座城的所有城区共享一个资源池 `settlement:<id>`。
- **建筑**：前 7 级按策划表，之后按递增系数；常规上限默认 20，每个实例可以突破（没有最终上限）；每次升级前询问所有拦截器（将来的科技插件）；建造需要时间、有队列，完成由时间线在精确时刻处理，产出从那一刻起改变。
- **资源**：`净产率 = 产出 × 产出系数 − 维持消耗`。余额增长到库存上限为止，维持消耗最多压到欠债下限。资源归零时触发 `resources.depleted` 事件，将来的军队插件据此处理降级、溃逃。
- **科技（透明科技树）**：在建有**研究所**的城池里研究；每座城池一个队列，同一科技不能在两座城同时研究；研究所等级提升研究速度。科技在定义上声明 `unlocks`（按等级段拦截建筑，例如农业 1/2/3 分别解锁农田 6–10 / 11–15 / 16–20 级）、`stats` 和 `percent`（给该玩家所有城池加成）。费用由进行研究的城池支付。运行时可以用 `research.registerNode` 注册科技树之外的新节点（给将来的不透明科技 / 基金委插件用），并用 `research.grantLevel` 直接授予等级；`research.addCostModifier` 预留给英雄的研究加成。
- **NPC 城池**：`npc-camps` 用 `settlements.defineKind({ npc: true })` 注册 NPC 类型，`extra.loot` 留给将来的战斗插件；GM 命令 `npc-camps.spawn` 随机生成。
- **上限与加成**：都做成 stat（例如外城科技上限、建造队列、库存上限），科技、道具、建筑只需往里加加成。
- **服务端驱动的表单**：命令附带 `form`，`prepare()` 决定当前是否可用并填好选项；前端 `forms` 插件用 `<FormOutlet placement="...">` 通用渲染。建外城、建城、改名都是这样实现的，没有专门的前端代码。

### 6.5 前后端

前端只通过 `/api/*` 与 Worker 通信，请求 / 响应类型统一定义在 `src/shared/api.ts`。界面布局是"顶部页面标签 + 中间左 1/3、右 2/3 两栏（各自滚动）+ 底部状态栏"，窄屏时变为单栏（见 `docs/design/ui.md`）。前端插件在 `setup(game)` 里用 `game.page()` 注册页面，用 `game.block(page, 'left' | 'right', Component)` 往页面的栏里放内容块，用 `game.entryBlock('building', Component)` 往建筑入口（点击建筑后右栏显示的内容）放内容块，用 `game.band('top' | 'bottom', Component)` 放进顶部 / 底部窄带，用 `game.gate(Component)` 接管整个界面（如登录页），插件之间用 `game.provide / use` 共享服务。组件内通过 `useGame()` 拿到 `state`、`view()`、`command()`、`request()` 等。前端每 60 秒与服务器同步一次（页面在后台时暂停），期间数值按产率在本地插值。

### 6.6 账号与 GM

- **GM 身份完全由密钥决定。** 用 `GM_USERNAME` + `GM_PASSWORD` 登录即为 GM；首次登录自动建号。GM 权限在每次请求时都会与密钥重新比对，因此在控制台更换密钥后立即生效，旧 GM 会话随之失效。
- **注册仅限邀请码。** `accounts` 本身不决定谁能注册，而是询问所有已注册的"注册守卫"，全部通过才放行；没有任何守卫时注册关闭（安全默认）。`invites` 插件就是一个守卫：原子地占用一次使用次数，注册失败时自动归还。
- **密码**使用 PBKDF2-SHA256（100k 次迭代）加盐哈希；会话令牌只存 SHA-256 摘要；cookie 为 `HttpOnly; SameSite=Lax`（HTTPS 下加 `Secure`）。
- **GM 能力**：邀请码管理、实时规则、查看玩家、对任意玩家执行任意命令（包括 `privileged` 命令），全部写入 `gm_audit`。

## 7. 开发指南

### 7.1 新增一个服务端插件

以"声望"为例：一张自己的表、一个 GM 可调门槛、一条命令、一个 view。

```sql
-- migrations/0007_prestige.sql
CREATE TABLE prestige_levels (
	player_id TEXT PRIMARY KEY,
	level INTEGER NOT NULL CHECK (level >= 0)
);
```

```ts
// src/plugins/prestige/index.ts
import { definePlugin, GameError, numberInRange, type ReadApi } from '../../kernel';

export default definePlugin({
	id: 'prestige',
	version: '0.1.0',
	dependsOn: ['resources'],
	setup(ctx) {
		const resources = ctx.services.get('resources');
		// GM 可在后台实时修改这个门槛
		const threshold = ctx.config.define('threshold', {
			description: 'Gold needed to ascend.',
			default: () => 1e6,
			parse: numberInRange(1, 1e15),
		});
		const level = (api: ReadApi, playerId: string) =>
			api.memo(`prestige:${playerId}`, async () => {
				const row = await api.db.prepare('SELECT level FROM prestige_levels WHERE player_id = ?').bind(playerId).first<{ level: number }>();
				return row?.level ?? 0;
			});

		ctx.commands.add({
			type: 'prestige.ascend',
			parse: () => null,
			async execute(api) {
				const cost = { gold: threshold.get(api) };
				if (!(await resources.canAfford(api, api.playerId, cost))) throw new GameError('too_poor', 'Not enough gold');
				await resources.spend(api, api.playerId, cost);
				api.write(
					api.db
						.prepare(
							'INSERT INTO prestige_levels (player_id, level) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET level = excluded.level',
						)
						.bind(api.playerId, (await level(api, api.playerId)) + 1),
				);
			},
		});
		ctx.views.add({ id: 'prestige.level', compute: (api) => level(api, api.playerId) });
	},
});
```

然后在 `src/plugins.ts` 的数组里加上它，在 `src/shared/api.ts` 的 `ViewMap` 里登记 `'prestige.level': number`，写测试，`pnpm check`。

- **只写不改**：`api.write()` 只是排队，命令结束后才原子提交；中途抛 `GameError` 什么都不会写入。
- **跨插件的数据只走服务**：例如扣金币用 `resources.spend()`，不要直接写 `resources_balances` 表。
- **纯内容**（新资源、新建筑）请写成类似 `starter-content` 的内容插件，调用 `resources.define` / `buildings.define` / `settlements.defineKind`，不要修改系统插件。
- **平衡相关的数字**尽量用 `ctx.config.define` 暴露出来，GM 就能在不发版的情况下调整。
- **GM 专用操作**写成 `privileged: true` 的命令，放在拥有该数据的插件里；GM 后台会自动列出。
- **GM 需要统计或筛选**时，用 `ctx.reports.add` 写一个只读报表；返回的行里带 `playerId` 列时，GM 后台会自动附上用户名。

### 7.2 新增一个前端插件

```ts
// web/plugins/prestige-panel/index.ts
import { defineClientPlugin } from '../../core/game';
import PrestigePanel from './PrestigePanel.vue';

export default defineClientPlugin({
	id: 'prestige-panel',
	setup(game) {
		// A block at the bottom of the city page's left column.
		game.block('city', 'left', PrestigePanel, { order: 50 });
	},
});
```

```vue
<!-- web/plugins/prestige-panel/PrestigePanel.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';

const game = useGame();
const level = computed(() => game.view('prestige.level') ?? 0);
</script>

<template>
	<section class="card">
		<h2>Prestige (level {{ level }})</h2>
		<button type="button" @click="game.command('prestige.ascend')">Ascend</button>
	</section>
</template>
```

在 `web/plugins.ts` 中注册。新接口的请求 / 响应类型加到 `src/shared/api.ts`；新 view 的类型加到其中的 `ViewMap`，前端即可用 `game.view('<id>')` 拿到带类型的数据。

### 7.3 修改表结构

1. 新增一个迁移文件 `migrations/NNNN_<pluginId>_<说明>.sql`（如 `ALTER TABLE … ADD COLUMN …`）。**不要修改已发布的迁移文件。**
2. 本地执行 `pnpm db:migrate:local`（`pnpm dev` 也会自动执行）；测试会自动应用全部迁移。
3. 上线时先 `pnpm db:migrate` 再 `pnpm run deploy`，新代码要能兼容迁移前后两种数据。

### 7.4 测试

- `test/kernel.spec.ts`：内核装配（依赖排序、冲突、配置）。
- `test/engine.spec.ts`：引擎语义（原子提交、乐观锁冲突重试）。
- `test/game.spec.ts`：真实插件 + 本地 D1 + 假时钟直接测引擎（`engineContext(kernel, id, now, overrides)`），**游戏规则优先写在这里**。每个测试用新的随机玩家 id，互不干扰。
- `test/api.spec.ts`：通过 `SELF.fetch` 走完整 Worker → D1 链路（登录、邀请、GM）。测试环境的 GM 账号为 `gm / gm-test-password`，见 `vitest.config.mts`。

## 8. 部署

首次部署：

```sh
pnpm exec wrangler login                       # 浏览器授权 Cloudflare 账号
pnpm exec wrangler d1 create wargame-db        # 创建 D1，把输出的 database_id 填进 wrangler.jsonc 的 d1_databases
pnpm db:migrate                                # 在线上 D1 建表
pnpm exec wrangler secret put GM_USERNAME      # 超级用户名
pnpm exec wrangler secret put GM_PASSWORD      # 超级用户密码（请用强密码）
pnpm run deploy                                # vite build + wrangler deploy，输出 *.workers.dev 地址
```

之后：有新的 `migrations/*.sql` 时先 `pnpm db:migrate` 再 `pnpm run deploy`；否则直接 `pnpm run deploy`。建议上线前先用 `pnpm preview` 在本地跑一遍生产构建。

- GM 账号也可以在控制台修改：Workers & Pages → wargame → Settings → Variables and Secrets。修改后立即生效。
- 自定义域名：Cloudflare 控制台 → Workers & Pages → wargame → Settings → Domains & Routes。
- 线上日志：`pnpm exec wrangler tail`，或控制台 Observability（已在 `wrangler.jsonc` 中开启）。

## 9. 已知限制

- 免费版 D1 每天 10 万行写入、Workers 每天 10 万次请求，只够开发和小规模测试；正式开服建议付费版（$5/月，每月含 5000 万行写入、1000 万次请求）。一次购买大约写 5 行（锁 + 资源 + 建筑）。
- 登录接口暂无频率限制；上线公开前建议加上 Cloudflare Rate Limiting（可写成一个插件）。
- 过期会话不会主动清理，只在读取时失效；数据量大后可加一个定时清理（Cron Trigger）插件。
- 玩家暂不能修改密码；GM 以外没有其他管理员角色。

## 10. 常见问题

| 现象                                | 处理                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `command not found: node`           | 见第 1 节；`brew list node` 确认存在，`brew info node` 确认是 "Installed on request" |
| pnpm 提示 build scripts 被阻止      | 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式允许（当前允许 esbuild、workerd）    |
| 修改 binding 后类型报错             | `pnpm cf-typegen`                                                                    |
| 启动时报 `PluginError`              | 插件装配错误（缺依赖、循环依赖、重复注册），错误信息会指出具体插件                   |
| 报 `no such table: accounts_…`      | 迁移没跑：本地 `pnpm db:migrate:local`，线上 `pnpm db:migrate`                       |
| 想从干净的本地环境重新测试          | 停掉开发服务器，`pnpm data:backup` 留个快照（可选），再 `pnpm data:reset`            |
| GM 登录失败                         | 本地检查 `.dev.vars`；线上确认两个密钥都已设置（`pnpm exec wrangler secret list`）   |
| 后台某条规则显示 "override ignored" | 存量覆盖值已不合法（例如引用的建筑被删掉），重新保存或点 "Reset to default"          |
