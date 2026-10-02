# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Local Explorer (Debugging & Inspection)

When running `npx wrangler dev`, a Local Explorer API is available for inspecting and debugging local Workers, bindings, and storage state. The API base URL is printed in the terminal when the dev server starts.

Key endpoints (relative to the dev server URL):

| Endpoint | Description |
|----------|-------------|
| `GET /cdn-cgi/local/explorer/api/local/workers` | List local Workers and their bindings |
| `GET /cdn-cgi/local/explorer/api/storage/kv/namespaces` | List KV namespaces |
| `GET /cdn-cgi/local/explorer/api/d1/database` | List D1 databases |
| `GET /cdn-cgi/local/explorer/api/r2/buckets` | List R2 buckets |
| `GET /cdn-cgi/local/explorer/api/workers/durable_objects/namespaces` | List Durable Object namespaces |
| `GET /cdn-cgi/local/explorer/api/workflows` | List Workflows |
| `POST /cdn-cgi/local/explorer/api/local/observability/query` | Run a read-only SQL query (SELECT/WITH only) over captured request traces and console logs. Tables: `spans`, `logs` (read attributes via `json(attributes)`). Example: `curl -X POST <base>/cdn-cgi/local/explorer/api/local/observability/query -H 'Content-Type: application/json' -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'` |
| `POST /cdn-cgi/local/explorer/api/local/observability/clear` | Clear all captured traces and logs |

If the routes above don't cover what you need, fetch the full OpenAPI schema (large - use only as a last resort): `GET /cdn-cgi/local/explorer/api`

Use the Local Explorer to debug issues by inspecting storage state (KV keys, D1 rows, R2 objects, DO storage), viewing Worker bindings, and querying request traces and logs captured during the dev session.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

---

# Project conventions (wargame)

以上是 create-cloudflare 生成的通用 Workers 约定；以下是本项目的约定，二者冲突时以本节为准。人类向文档见 [README.md](README.md)（项目简介，链接到部署、玩法、开发文档）。

## 文档分工

| 文档                          | 内容                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `docs/HANDOFF.md`             | **唯一的状态文档**：当前状态、待办、怎么验证。只保留最新版，不写历史                 |
| `docs/changelogs/<日期>-*.md` | 已完成的改动（做了什么、接口变化、暂按的取舍、测试），按日期分文件                   |
| `docs/design/gameplay.md`     | 玩法设计（已实现和规划中的都在这里，以它为目标）                                     |
| `docs/design/ui.md`           | 界面布局                                                                             |
| `docs/design/architecture.md` | **规划中的**架构：以后的系统、预留接口的用法、已知限制；实现后移进 `docs/development.md` 并从这里删 |
| `docs/development.md`         | **已实现的**架构、目录结构、开发步骤与测试                                           |
| `docs/deployment.md`          | 环境、本地运行与数据、命令、上线部署、常见问题                                       |
| `docs/plugin-guide.md`        | 写给第三方的插件开发指南（示例在 `examples/`，第三方扩展放 `extensions/<id>/`，两端自动发现）；插件清单在 `docs/plugin_architecture_reference.md` |
| `README.md`                   | 只有五块：项目是什么、简要部署、简要玩法、简要开发与贡献、免责声明（各链接到上面的详细文档） |

- **每完成一个小任务就立即落盘**（不要攒到最后）：改动记进当天的 changelog，`HANDOFF.md` 的状态和待办同步更新，保证会话随时中断，下一位接手者都能从文档继续。
- 用户在 `humannotes.md` 里给 AI 留言。**先处理完全部留言，再开始写代码**：整体读一遍、排好顺序，把每一条转进交接文档的待办（保留用户原话，附处理计划），或直接改设计文档；处理完一条就直接从 `humannotes.md` 删掉那一条（不是划掉或标注）。之后按交接文档的待办逐项实现。

## 设计文档

- 玩法设计以 `docs/design/gameplay.md` 为准，界面布局以 `docs/design/ui.md` 为准。实现与它冲突时，先和用户确认，不要自行改设计；标 **【待确认】** 的条目可以先按猜测或游戏的常见做法实现，但要在文档里注明"暂按……实现"，保持文档与代码同步。

## 包管理与命令

- **只用 pnpm**，不要用 npm / yarn，不要提交 `package-lock.json`。上文表格中的 `npx wrangler …` 一律改为 `pnpm exec wrangler …`。
- 依赖只装在项目内（`pnpm add -D`），不要全局安装 wrangler 等工具。
- 新依赖若需要 build scripts，须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式允许，并说明理由。
- **完成标准：`pnpm check` 必须通过**（tsc + vue-tsc + prettier + vitest）。改了 `wrangler.jsonc` 的 binding 后先跑 `pnpm cf-typegen`。
- 本地运行用 `pnpm dev`（Vite + `@cloudflare/vite-plugin`，前端与 Worker 同一个服务器），**不要直接用 `wrangler dev`**：它不会构建 Vue 前端，也不会使用 `.data/local` 里的数据。生产形态的本地验证用 `pnpm preview`。
- 本地测试数据在 `.data/local`，重启后保留。**不要擅自执行 `pnpm data:reset` / `data:restore` 或删除 `.data/`**，那是用户的测试数据；需要干净环境时先征得同意，并建议先 `pnpm data:backup`。本地 wrangler 命令访问数据时必须带 `--local --persist-to .data/local`。

## 架构铁律："一切皆插件"

1. **内核（`src/kernel/`）不含任何游戏逻辑。** 只有在确实缺少一个*通用*扩展点时才改内核，并同步更新 `docs/development.md` 2.2 节的扩展点表，以及 `test/kernel.spec.ts` / `test/engine.spec.ts`。
2. **每个功能都是一个插件**：`src/plugins/<id>/index.ts`，默认导出 `definePlugin({...})`，并在 `src/plugins.ts` 注册。前端同理：`web/plugins/<id>/index.ts`（`defineClientPlugin`）+ `web/plugins.ts`。
3. **一个插件只管一个系统，并假设完全不知道其他玩法。** 例如建筑插件不知道某座建筑是用来练兵的，兵种插件不知道具体有哪些资源；系统插件里不要写死其他系统的内容 id（资源、建筑、兵种…）。把系统之间的关联接起来（"兵营训练步兵""钱庄产货币"）是内容插件或使用方插件的事，通过对方的 service / hook 注册。
4. **插件之间只通过 service / hook 通信。** 可以 `import type` 其他插件导出的类型；**禁止**导入其他插件的运行时代码或内部变量。需要的依赖写进 `dependsOn`。
5. **新内容 = 新的内容插件**（参考 `starter-content`），调用 `resources.define` / `generators.define` 等 service，不要去改系统插件里的数据。
6. **命名空间**：插件 id 为 kebab-case；command type、view id、report id 均以 `<pluginId>.` 开头；D1 表名以 `<pluginId>_` 开头（连字符换成下划线）。
7. 服务 / 钩子的类型通过声明合并扩展：
   ```ts
   declare module '../../kernel' {
   	interface ServiceMap { myService: MyService }
   }
   ```

## 账号、权限与 GM

- **身份只从 `accounts` 服务取得**：玩家路由用 `services.get('session').resolve(request, env)` 拿 `playerId`；任何 GM 路由第一行必须是 `await accounts.requireGM(request, env)`。不要自己解析 cookie 或信任客户端传来的用户 id。
- **GM 是用户名等于密钥 `GM_USERNAME` 的账号**（每次请求重新比对）；登录与普通账号完全一致，校验库里的密码哈希。`GM_PASSWORD` 只是初始密码：GM 账号还没有密码时用它登录，登录后必须先改密码：改之前不能玩（游戏接口返回 403，网页只显示改密码页），GM 接口照常可用，以便首次运行时以 GM 身份导入地图（用户选定"改密码前放行 GM 接口"；用户 2026-10-02："GM在登录的待遇上要和普通用户保持一致哦。系统变量仅制定初始密码。"）。不要在 D1 里加 "role" 列或任何别的成为 GM 的途径；能写数据库的人可以改 GM 的密码哈希，这对自托管是可接受的。
- **注册只能通过注册守卫放行**（`accounts.addRegistrationGuard`）。没有守卫 = 注册关闭，这是有意的安全默认，不要改成"默认开放"。
- **GM 专用的游戏操作**写成 `privileged: true` 的命令，放在拥有该数据的插件里（例如 `resources.grant`），并写 `description`（说明 payload 形状），GM 后台会自动列出。不要在 `gm` 插件里直接改其他插件的状态。
- GM 的写操作要写审计日志（`gm` 插件已对规则修改和玩家命令做了记录；新增 GM 路由时照做）。

## 可调规则（GM 实时修改）

- 影响平衡的数字（产率、成本、奖励、上限…）用 `ctx.config.define(name, { description, default, parse })` 暴露（并在本插件的 `data/i18n.csv` 补说明：键 `rule:<插件id>.<规则名>`，写英文和中文），在 engine 回调中用 `handle.get(api)` 读取，**不要硬编码**。
- `default` 是函数（可依赖之后才定义的内容）；`parse` 必须严格校验不可信输入并抛 `GameError('bad_config', …)`，可复用 `numberInRange` / `numberRecord` / `recordOf`。
- 对象型规则要支持**部分覆盖**：`parse` 把 GM 写的部分值与内容默认值合并后返回完整对象（参考 `resources.initial`、`generators.rules`）。
- 规则对所有玩家**立即生效**（包括未结算的离线时间），设计规则时要接受这一点。
- **数值来源的覆盖顺序**（前者覆盖后者，逐项覆盖而不是整表替换）：
  1. **GM 指定**：通过 `ctx.config.define` 的规则（初始值、倍率等）；
  2. **插件自带的数值表**：放在插件目录下单独的 `.csv` 文件里，不要把策划表写在 TS 代码中（具体做法见下一条）；
  3. **默认初始值 + 倍率公式**：插件代码里的兜底。
- **数据与代码分离**（用户要求）：
  - 内容（资源、建筑、兵种、科技、道具的名称与数值）和设计数值（系数、比例、上限、时长…）放在插件目录的 `data/*.csv`，用 `import x from './data/x.csv?raw'` 导入（构建时打包进 Worker）；代码只负责读取、校验和使用。
  - 解析用内核的 `csvRows` / `csvNumber` / `csvMap`（`"key:n; key:n"`）/ `csvRules`（`key,value` 两列，点号表示嵌套，如 `casualty.crushing`）/ `csvLevels`（策划表）/ `planRow`（按"最近的较低等级"查表）。CSV 首行是表头，`#` 开头为注释，含逗号的单元格加引号。
  - **格式归拥有它的系统插件**：例如 `resources.defineFromCsv`、`buildings.defineFromCsv`、`research.defineFromCsv`；内容插件只提供文件，不要自己解析别的系统的格式。
  - 设计数值统一放 `data/rules.csv`，在 `ctx.config.define` 的 `default` 里读取（对象型用 `numberFields` 支持部分覆盖）。
  - 纯技术参数（速度倍率 1、批量上限、清扫批次等）可以留在代码里。
- **建筑的数值表**：1–7 级**必须有值**；更高等级可以有值也可以没有，没有的按倍率从**最近的有值的较低等级**推算（例如只写到 7 级，10 级 = 7 级 × 倍率³）。GM 只改倍率时，表里已有的等级仍用表中的值。

## 数据与引擎（D1）

所有数据（包括玩家存档）都在一个 D1 库里。引擎语义见 `docs/development.md` 2.3 节，代码在 `src/kernel/engine.ts`。

- **表归属**：每个插件只读写以自己 id 为前缀的表（如 `invites_codes`、`resources_balances`）。跨插件的数据一律走 service（例如扣资源用 `resources.spend()`），**禁止直接查询或写入别的插件的表**。
- **只读所需**：按玩家（以后按城池）查询需要的行，不要一次拉取整个玩家的全部数据；同一次调用内可能被多个插件用到的数据用 `api.memo(key, load)` 缓存。
- **写入只能通过 `api.write()`**：命令里不要直接 `db.prepare(...).run()` / `db.batch()`。引擎会把排队的写入连同乐观锁放进一个原子 batch 提交，失败或抛 `GameError` 时一行都不写。插件在内存里累积的改动用 `api.beforeCommit(key, fn)` 在提交前统一落盘（参考 `resources` 的结算）。
- **乐观锁**：命令自动锁定 `player:<playerId>`。**修改其他玩家（或其他共享实体）的命令，必须在读取对方数据之前调用 `api.lock('player:<对方id>')`**，否则可能基于过期数据覆盖别人的修改。锁的表和触发器是 `engine_locks` / `engine_locks_cas`，不要绕开。
- **命令可能被重试**：`execute` 必须可以安全地重复执行，只做读取和 `api.write`，不要有外部副作用（fetch、发消息等）。
- **离线产出按需结算**：随时间变化的数值存"结算时的值 + 结算时间"，读取时按 `api.now` 和**当前规则**用闭式公式（`rate × elapsed`）计算，禁止逐秒循环。**改变产率之前必须先 `resources.settle()`**，把旧产率下的收益落盘（`generators.setOwned` 已这样做）。
- **不要读取 `Date.now()`**：在引擎回调里使用 `api.now`，保证可用假时钟测试。
- 读取规则只能通过 `ctx.config.define` 返回的 handle（`handle.get(api)`），不要从 env 或存储直接读。
- command 的 `parse` 负责校验**不可信的客户端输入**；`execute` 只处理已校验的数据。玩家可见的失败抛 `GameError(code, message)`；装配 / 编程错误抛 `PluginError`。
- **用数据库约束兜底**：数量类字段加 `CHECK (x >= 0)` 等约束，让代码里的 bug 也写不进非法数据。
- **views 是给玩家本人的**：只返回该玩家可以看到的数据。跨玩家的统计、筛选写成 `ctx.reports.add` 的报表（仅 GM 可用），返回行里带 `playerId` 列即可自动附上用户名。
- 需要"占用 + 失败回滚"的场景用条件 `UPDATE … RETURNING` 做原子占用，并提供撤销函数（参考 `invites` 的注册守卫）。

## 游戏系统约定（城池、建筑、资源、时间线）

- **需要时间的机制一律走时间线**（`timeline.schedule` / `timeline.on`）：建造完成、将来的行军到达等。事件会在"下次用到这个实体"时按时间顺序处理，包括只读视图（此时写入被丢弃），所以处理函数只能通过 `api.write` 改状态，不能有其他副作用，并且要用 `event.dueAt` 作为事件发生的时间（`api.now` 仍是真实的当前时间）。
- **改变产率、消耗或库存上限之前，先 `resources.settle(api, holder)`**，把旧规则下已经产出的部分落盘。在时间线处理函数里不用再做，引擎已经先结算到事件时刻。
- **资源**：生产方用 `resources.addProducer`，可叠加百分比加成（stat `resources.productionFactor`）；维持消耗用 `resources.addConsumer`，返回正数，不受加成影响。维持消耗可以把余额压到 `-resources.debtLimit`；玩家主动花费永远不能为负。资源耗尽时的后果（降级、溃逃）写在 `resources.onDepleted` 监听者里。
- **防卡死**：凡是"要花某种资源才能生产它"的循环，都必须有兜底来源（参考 `starter-content.baseProduction`）。
- **上限、容量、队列、加成**一律做成 stat：拥有者 `stats.define`，给加成的 `stats.contribute`。不要在消费方写死"科技几级就加几"。
- **城池类型**用 `settlements.defineKind` 注册（NPC 类型加 `npc: true`，由自己的插件实现）；新增建筑类别用 `settlements.allowCategory`。持有资源的实体标识统一为 `settlement:<id>`。
- **建筑**：新建筑用 `buildings.define`，写明策划表 `levels`（通常 7 行）、`cap`、`kinds`、`unique`；拦截升级用 `buildings.addGate`（返回原因字符串）；突破上限用 `buildings.raiseCap`；需要"先建某建筑"的功能用 `buildings.level` / `buildings.highestOwned` 判断。
- **view 不能因为"还没有数据"而抛错**（例如玩家还没有城池），要返回 `null` 或空值：一个 view 出错会让整个状态请求失败。只有权限问题（看别人的城）才抛 `GameError`。
- **简单操作优先用服务端表单**：在命令上加 `form`，用 `prepare()` 决定是否显示并填入动态选项。只有需要专门可视化的界面才写 Vue 插件。
- **前端到点刷新**：如果界面内容会在已知时间点变化（建造完成、行军到达），前端插件用 `game.refreshAt(serverTime)` 在那个时间点刷新，不能只依赖 60 秒的轮询。
- **后台任务**用 `ctx.tasks.add`（由每分钟的 cron 触发）。任务里要改游戏状态时，一律通过 `executeCommand` 以相应玩家的身份执行，不要直接写表。新增一类会带时间线事件的实体（前缀，如 `army:`）时，要调用 `timeline.addOwnerResolver`，否则清扫任务只能按 NPC 处理它。
- **冒烟测试不要用 `.data/local`**：用 `WARGAME_DATA_DIR=<临时目录>` 启动 `vite preview`（见 `docs/HANDOFF.md`）。

## 兼容性（线上已有玩家数据）

- **一个版本只有一个基线**：`migrations/0001_init.sql` 是当前版本的全部表结构（用户 2026-10-02："保持sql干净,这个版本只留一个sql。"）。版本发布之后，表结构改动只能**新增** `migrations/NNNN_<pluginId>_<说明>.sql`（从 `0002` 起编号），不可修改已发布的迁移文件；本地用 `pnpm db:migrate:local`，测试会自动应用。上线顺序是先 `pnpm db:migrate` 再部署，所以代码要能兼容迁移前后的数据。
- **不要删除或重命名线上已有的表和列**；需要时先新增、迁移数据、下个版本再清理。
- `/api/*` 的请求 / 响应类型统一定义在 `src/shared/api.ts`，服务端用它标注返回值（`satisfies` / 返回类型），前端用它标注请求结果。改接口先改这里，让两端的类型检查一起把关。

## 版本号与发布

- 版本号 `A.B.C`（`package.json` 的 `version`，发布时打标签 `vA.B.C`），用户 2026-10-02 约定："如果新版本只涉及默认的数值修改，递增C，如果涉及不影响兼容性的核心插件修改，递增B，影响兼容性的修改，递增A。"
  - **C**：只改默认数值（各插件 `data/*.csv` 的数值、规则默认值），不改代码逻辑；
  - **B**：改了插件代码（新玩法、新扩展点、界面），但不影响兼容性：已有存档、已有的 GM 覆盖值、第三方插件都照常可用；
  - **A**：影响兼容性：已有存档需要迁移以外的处理、删除或改名了服务 / 视图 / 命令 / 规则 / 扩展点、第三方插件需要修改。
- 一个版本含多种改动时取最高的一级。
- **只在用户要求时发布**，并且要等用户说的范围全部完成（"都完成之后再发布"）；发布前 `pnpm check` 通过、HANDOFF 待办里属于这次的条目都已完成。

## 测试约定

- 游戏规则写在 `test/game.spec.ts` 风格的引擎测试中（`createKernel(plugins)` + 本地 D1 + 假时钟），每个测试用 `crypto.randomUUID()` 生成新玩家，不依赖测试间的数据隔离。
- 内核装配改动配 `test/kernel.spec.ts`，引擎语义（提交、锁、重试）配 `test/engine.spec.ts`；HTTP 链路用 `SELF.fetch`（`test/api.spec.ts`）。
- 涉及并发的命令（尤其是跨玩家的）要有并行执行的测试，证明不会重复扣除或覆盖。
- 新插件至少覆盖：正常路径、非法输入、资源不足等拒绝路径。
- 有权限的路由必须测"无权限被拒"（401 / 403）；测试环境 GM 账号见 `vitest.config.mts`。
- 自动化测试不读写 `.data/`（vitest 每次使用独立的临时存储）。前端改动至少跑一次 `pnpm dev` 或 `pnpm preview`，在浏览器里确认。

## 代码风格

- Prettier 配置见 `.prettierrc`（tab 缩进、单引号、行宽 140）；不要手动对抗格式化结果。

## 前端（Vue 3 + Vite，前后端分离）

- 前端只通过 `/api/*` JSON 接口与 Worker 通信；`web/` 不得 import `src/` 下除 `src/shared/` 以外的任何代码，`src/` 也不得 import `web/`。
- **界面一律写在 `.vue` 单文件组件的 `<template>` 里**，不要在 TS/JS 里拼接 HTML 字符串或手工创建 DOM；禁止 `v-html` 和 `innerHTML`（用户名、邀请备注等都是不可信文本）。
- 前端插件 = `web/plugins/<id>/index.ts`（注册）+ 若干 `.vue` 组件：布局见 `docs/design/ui.md`，前端插件只用 `game.widget('<插件>.<名字>', 组件)` 注册组件，**放在哪由后端插件声明**（`ui` 服务：`ui.page / block / entry / band / slot / mail`，经 meta 下发），`game.gate()` 接管整个界面，插件间用 `game.provide/use` 共享服务（类型通过声明合并 `ClientServiceMap`）。不要直接 import 其他前端插件的组件或内部状态。
- 组件通过 `useGame('<所属前端插件id>')` 访问游戏：`game.view('<id>')` 读取带类型的 view（类型登记在 `src/shared/api.ts` 的 `ViewMap`），`game.command()` 执行玩家命令，`game.request<T>()` 调用其他接口。
- 需要随时间变化的数值（资源插值等）在 `computed` 里读取 `game.elapsed`，不要自己开 `setInterval`。
- **文案：各插件只管自己的键**（用户 2026-10-02："所有插件注册的i18n必须是key+英文+中文。key由插件管理，但统一前缀由内核或者i18n自动添加。使得不同插件之间不会key冲突，同一插件由key冲突的话拒绝加载"；细则见 `docs/development.md` 2.8 节）：
  - 后端插件的 `data/i18n.csv` 为 `key,en,zh-CN[,其他语言…]`，用 `ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId)` 登记为 `<插件id>.<key>`；新加的文字（含报错、表单、视图、规则说明 `rule:<规则名>`）都要在**拥有它的插件**的 CSV 里写英文和中文。社区翻译用 `i18n.inject`，不改官方 CSV。
  - `new GameError(code, message, status, '<本插件id>')` 必须带第 4 个参数，消息写成本插件 CSV 里的键（模板里的 `${…}` 对应 `{0}`、`{1}`）。
  - 拼接别的插件的名称时，整句加**本插件**的前缀并写模式键（`buildings.${name} Lv ${n}` 配 `"{0} Lv {1}"`）；不要指望别的插件的宽泛模式碰巧翻译它。
  - 前端插件只放自己界面上的文字（`game.messages`，自动成为 `@<前端插件id>.<文字>`），组件用 `useGame('<所属前端插件id>')`。
  - 不要写"查不到就去掉前缀再试"之类的通用回退（会掩盖缺译）；缺译要由 `pnpm check`（`scripts/check-i18n.mjs` 与 i18n 测试）发现并补上。
- 颜色、圆角等只用 `web/styles.css` 中的 CSS 变量（设计 token）；组件样式写在 `<style scoped>` 里，新增颜色须同时提供浅色和深色取值。
- 注释写"为什么"，不写"做了什么"；与周边代码保持一致的注释密度。
