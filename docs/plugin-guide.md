# 插件开发指南

写给想给这个游戏加新玩法、新内容的开发者（包括第三方）。读完这一篇，再照着 `examples/` 里的示例改，就能写出第一个插件；**不用改官方代码**：放进 `extensions/<id>/` 就会被前后端自动装上（第 8 节）。项目约定的完整版在 [AGENTS.md](../AGENTS.md)，已实现的架构在 [development.md](development.md) 第 2 节，所有插件的清单在 [plugin_architecture_reference.md](plugin_architecture_reference.md)。

## 1. 五分钟上手

1. 读示例（都在 [`examples/`](../examples/)，每个都是一个完整的扩展）：
   - [`watchtower/`](../examples/watchtower/)：**新内容**。一座"箭楼"建筑，每级给所在城池守军的每一路加防御：`server.ts`（插件本身，40 行）、`data/buildings.csv` 与 `data/levels.csv`（建筑与 1–7 级造价）、`data/rules.csv`（设计数值，GM 可在后台实时改）、`data/i18n.csv`（译文）。
   - [`otherworld/`](../examples/otherworld/)：**新玩法、只写后端**。一个 5×5 的"异世界"小地图，有自己的页面，由通用格子控件 `ui.grid` 画出；格子上的按钮执行命令，命令发的邮件由通用报告 `ui.report` 显示。
   - [`clock/`](../examples/clock/)：**自带前端控件**。底部窄带里走动的服务器时间：`server.ts` 存时区（GM 规则 `clock.utcOffset`）并声明控件放在底部窄带，`client.ts` + `Clock.vue` 注册并画出这个控件（用 `game.serverNow()` 计时）。
2. 跑它们的测试：`pnpm exec vitest run -t "example"`（`test/game/battle.spec.ts`、`test/game/map.spec.ts` 把示例装进内核：建箭楼后派流寇来打、看战报里的加成；异世界的格子、按钮与邮件；时钟的规则与视图）。
3. 想让它进游戏：把示例目录复制到 `extensions/`（如 `cp -R examples/watchtower extensions/`），`pnpm dev` 打开浏览器就能在内城里建箭楼。官方清单 `src/plugins.ts`、`web/plugins.ts` 不用动。
4. 改完跑 `pnpm check`（类型检查 + 格式 + 全部测试），通过才算完成。

## 2. 基本概念

- **一切皆插件**：内核（`src/kernel/`）只负责装配和执行，不含任何玩法。资源、建筑、兵种、战斗、账号、GM 后台……都是插件。
- **系统插件**提供一种机制和扩展点，不知道具体内容（例如 `buildings` 知道"建筑有等级、造价、上限"，但不知道有"农田"）。**内容插件**调用系统插件的服务，填进具体内容（`starter-content` 定义了五种资源和农田、仓库……）。大部分新玩法 = 一个新的内容插件；只有缺少机制时才写系统插件。
- **插件之间只通过服务（service）和钩子通信**：`ctx.services.get('buildings')` 拿到别的插件的接口；可以 `import type` 别人导出的类型，但**不能** import 别人的运行时代码。用到谁就写进 `dependsOn`。
- **数据都在一个 D1 库里**：每个插件只读写以自己 id 开头的表（`watchtower_*`）；别人的数据一律走服务。
- **一次玩家操作 = 一个命令**：引擎给命令一个 `api`，命令里的所有写入排队，结束时连同乐观锁一起原子提交；冲突时整个命令重试。所以命令要能安全地重复执行（只读数据库、只用 `api.write`，不调外部接口）。
- **时间靠时间线**：建造完成、行军到达、流寇来袭……都是时间线事件，"下次用到这个实体时"按顺序处理（离线也一样，另有每分钟的清扫任务）。产出这类连续变化的量按"结算值 + 结算时间"闭式计算，不逐秒循环。

## 3. 插件骨架

```ts
import { definePlugin } from '../../src/kernel'; // 在 src/plugins/<id>/ 里是 '../../kernel'

export default definePlugin({
	id: 'my-plugin', // kebab-case；也是表名、命令、视图、规则的前缀
	version: '0.1.0',
	description: 'One line for the GM console',
	dependsOn: ['buildings', 'battle'], // 要用到的服务的提供者
	setup(ctx) {
		// 只在这里注册：拿服务、定义规则、加命令 / 视图 / 钩子……不要做 I/O
	},
});
```

`setup` 里能用的扩展点（`ctx`）：

| 扩展点                               | 用途                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ctx.services.get(name)` / `provide` | 用别人的服务 / 提供自己的服务（类型用声明合并登记到 `ServiceMap`，见下）                                              |
| `ctx.config.define(name, def)`       | GM 可实时修改的规则，键名自动成为 `<插件id>.<name>`；用 `handle.get(api)` 读取                                        |
| `ctx.commands.add(command)`          | 玩家命令（`type` 以插件 id 开头）；加 `form` 就自动出现在界面上；`privileged: true` 是 GM 专用命令（GM 后台自动列出） |
| `ctx.views.add(view)`                | 玩家本人能看到的数据（只读；不能因为"还没有数据"而抛错，返回 `null` 即可）                                            |
| `ctx.reports.add(report)`            | GM 用的跨玩家只读报表（返回行里带 `playerId` 列会自动附上用户名）                                                     |
| `ctx.tasks.add(task)`                | 每分钟由 cron 触发的后台任务（要改游戏状态时用 `executeCommand` 以玩家身份执行）                                      |
| `ctx.routes.add(route)`              | 额外的 HTTP 路由（GM 路由第一行必须 `await accounts.requireGM(request, env)`）                                        |
| `ctx.meta.add(key, provider)`        | 随 `/api/meta` 下发给前端的静态信息                                                                                   |

提供服务时，用声明合并登记类型，这样别的插件 `ctx.services.get('myService')` 就有完整类型：

```ts
export interface MyService {
	doThing(api: EngineApi, playerId: string): Promise<void>;
}
declare module '../../kernel' {
	interface ServiceMap {
		myService: MyService;
	}
}
```

## 4. 引擎 api

命令、视图、事件处理函数都会拿到 `api`：

| 成员                        | 说明                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api.playerId`、`api.now`   | 当前玩家与当前时间。**不要用 `Date.now()`**（测试用假时钟）。时间线处理函数里事件时刻是 `event.dueAt` |
| `api.db`                    | D1，只用来读                                                                                          |
| `api.write(...statements)`  | 排队写入，命令结束时原子提交；抛 `GameError` 时一行都不写                                             |
| `api.memo(key, load)`       | 本次调用内的缓存：几个插件读同样的行时只查一次（返回的对象可以就地修改，配合 `beforeCommit` 落盘）    |
| `api.beforeCommit(key, fn)` | 提交前统一落盘一次（例如累积了好几次的改动）                                                          |
| `api.lock(entity)`          | 修改**其他玩家**的数据前先锁住对方（`player:<id>`），否则可能覆盖别人的修改                           |
| `api.privileged`            | GM 执行的命令；`api.gmViewer`：GM 在看（只用来多显示信息，例如成功率，不授予任何权限）                |

命令的输入用内核的 `shape` 声明，不要手写判断：

```ts
parse: shape({ settlement: fields.id(), count: fields.int(1, 10_000), note: fields.optional(fields.text({ max: 200 })) }),
```

缺字段、类型或范围不对，内核统一报错（已有中文）；字段之间有关联时，加第二个参数 `refine`（`(p) => …`，可以抛本插件的错误）。表单里的 `a.b` 字段会自动展开成嵌套对象。

失败分两种：玩家能看到的失败用本插件的报错工厂：文件顶上 `const fail = gameErrors('<你的插件id>')`，然后 `throw fail(code, message)`（例如资源不够；`message` 是你 CSV 里的键）；装配错误、编程错误抛 `PluginError`。

## 5. 数据与规则

- **内容和数值放在插件目录的 `data/*.csv`**，用 `import x from './data/x.csv?raw'` 导入（构建时打进 Worker），代码只负责读取、校验和使用。首行是表头，`#` 开头是注释，含逗号的单元格加引号。
- 解析工具在内核：`csvRows`、`csvNumber`、`csvMap`（`"key:n; key:n"`）、`csvRules`（`key,value` 两列，点号表示嵌套）、`csvLevels` / `planRow`（策划表）。
- **格式归系统插件**：建筑表用 `buildings.defineFromCsv`、资源用 `resources.defineFromCsv`、科技用 `research.defineFromCsv`、流寇用 `bandits.defineKindsFromCsv`……内容插件只提供文件。
- **影响平衡的数字用规则暴露**（`ctx.config.define`），在 `default` 里读 CSV；`parse` 要严格校验 GM 的输入（`numberInRange` / `numberFields` / `numberRecord`），对象型规则支持部分覆盖。顺序：GM 指定 > 插件 CSV > 代码兜底。规则对所有玩家立即生效（包括离线时间）。
- **文案跟插件走，各插件只管自己的键**：插件目录下的 `data/i18n.csv`，列为 `key,en,zh-CN`，后面可以加你支持的其他语言。`key` 通常就是英文原文，可以带占位符 `{0}`。在 `setup` 里 `ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId)`（`dependsOn` 加 `'i18n'`），每个键成为 `<你的插件id>.<key>`，所以和别的插件同名也不冲突；同一个表里键重复、缺英文会拒绝加载。内容名称（交给 `resources.define` 等的 `name`）、表单文字、钩子返回的文字、视图里的文字、报错、规则说明（`rule:<插件>.<规则名>`）、插件名（`plugin:<插件id>`）都写在这里。要显示的文字一律是 `UiText`：文件顶上 `const text = uiTexts('<你的插件id>')`（`src/shared/i18n.ts`），句子写成 `text('{0} ×{1}', { 0: keyText(unit.name), 1: n })`，别的插件的名称用 `keyText`、玩家输入的文字用 `literal` 放进变量；报错用 `const fail = gameErrors('<你的插件id>')`，`throw fail(code, text('…', vars))`。想给别的插件补译文或加一种语言，用 `i18n.inject(csv)`（列 `key,<语言>…`，key 写完整键如 `starter-content.Farm`），不用改它的文件。细则见 [开发文档](development.md) 2.8 节。规则里通用的字段名中文在前端 `web/plugins/gm-panel/rules-zh.ts` 的 `fieldsZh`。

## 6. 常见做法（菜谱）

| 想做的事                               | 用什么                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新资源                                 | `resources.define` / `defineFromCsv`；产出 `resources.addProducer`，维持 `addConsumer`；花费 `resources.spend(api, holder, cost)`，返还 `refund`                                                                                                                                                                                                  |
| 新建筑                                 | `buildings.defineFromCsv(buildings, levels)`（1–7 级必须有造价）；拦截升级 `buildings.addGate`（返回原因 `UiText` 或 null）；突破上限 `buildings.raiseCap`；查等级 `buildings.level`                                                                                                                                                              |
| 上限、容量、加成                       | 拥有者 `stats.define`，给加成的 `stats.contribute`（第三个参数写来源文字，玩家在悬停说明里看到）；不要在消费方写死"几级加几"                                                                                                                                                                                                                      |
| 新兵种                                 | `troops.define`（`trainedAt` 写训练它的建筑）；训练门槛 `addTrainingGate`；额外消耗 `addTrainingRequirement`；时间 `addTrainingTimeModifier`                                                                                                                                                                                                      |
| 科技                                   | `research.defineFromCsv`；效果多半是 stat 加成或战斗修改器                                                                                                                                                                                                                                                                                        |
| 战斗加成                               | `battle.addModifier(async (api, side) => [{ source: text('…'), stat, flat?, percent?, family? }])`；伤亡 `battle.addCasualtyHook`；战后 `battle.onFought`（如英雄重伤 `realms.injure`）                                                                                                                                                           |
| 定时发生的事                           | `timeline.schedule(api, entity, dueAt, type, payload)` + `timeline.on(type, handler)`；新的实体前缀要 `timeline.addOwnerResolver`                                                                                                                                                                                                                 |
| 道具                                   | `items.define({ id, name, use: { parse: shape({...}), apply, form } })`；发放 `items.grant`；告诉玩家去哪拿 `items.addSource`                                                                                                                                                                                                                     |
| 商城商品                               | `shop.defineOffer({ id, item, count, price, category, dailyLimit })`（价格是整数元宝）                                                                                                                                                                                                                                                            |
| 掉落（秘境、流寇、NPC 城池、攻打玩家） | `loot.addDrop(pool, { id, weight, value?, where?, preview?, give })`，`pool` 为 `bandits` / `npc-camps` / `pvp`；秘境每个任务一个池（`realms.<秘境>.<任务>`），往秘境里加用 `realms.addDrop`（`where` 限定秘境和任务，启动时分进各任务的池；新秘境的定义要写 `taskCount`）；`give(api, ctx)` 返回战报里的奖励行。价值不写就按权重算，越稀有越值钱 |
| 城池类型、行军目的、遭遇战             | `settlements.defineKind`、`armies.defineMission`（`name` 写本插件的键，如 `mission:<id>`；到达后要交战的标 `battle: true`，就有阵列等战斗选项）、`armies.addEncounter`；去掉一座城池用 `settlements.remove`；攻打玩家城池用 `pvp.raid`                                                                                                            |
| 英雄                                   | `heroes.defineAttribute` / `defineVenue` / `defineDuty`、`heroes.addAttributeBonus`                                                                                                                                                                                                                                                               |
| 给玩家发消息                           | `mail.send(api, playerId, { kind, title: text('…', vars), data })`（和命令同一次提交）；`mail.present(kind, fn)` 把数据整形成通用报告（`ReportData`），再 `ui.mail(kind, 'ui.report')`；需要专门的样子时才写自己的组件                                                                                                                            |
| 声望                                   | `prestige.add(api, playerId, amount)`；花费自动计入                                                                                                                                                                                                                                                                                               |
| 简单的操作界面                         | 命令上加 `form`（字段、`prepare` 决定是否显示并填选项），不用写前端                                                                                                                                                                                                                                                                               |
| 存自己的数据                           | 新增迁移 `migrations/NNNN_<插件id>_<说明>.sql`，表名以插件 id 开头；数量字段加 `CHECK (x >= 0)`。只能新增迁移，不能改已发布的                                                                                                                                                                                                                     |

## 7. 界面：多数时候只写后端

前端是 Vue 3，只通过 `/api/*` 和后端通信。**显示什么、放在哪都由后端声明**：后端插件依赖 `ui`，用 `ui.page / block / entry / band / slot / mail` 声明页面、左右栏的内容块、建筑入口里的内容块、顶部 / 底部窄带、插槽、邮件的显示方式，声明里的 `props.view` 指定控件读哪个视图（前端自动订阅）。视图返回**通用控件**认得的数据形状（`src/shared/ui.ts`），前端就会画出来，不用写一行前端代码：

| 控件                      | 画什么（官方界面里的例子）                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ui.cards` / `ui.filters` | 卡片网格、方块网格、小按钮；分组与筛选、详情里的服务端表单（聚宝阁、道具、城池的建筑栏位、英雄、候选英雄） |
| `ui.rows`                 | 分节的行列表，可带分组按钮、下拉选参数、一排小格子（城墙、驻军、装备栏、秘境列表）                         |
| `ui.timers`               | 带倒计时与进度条的列表，到点自动刷新（训练、研究、行军、来袭）                                             |
| `ui.badge` / `ui.banner`  | 一行字；横幅（GM 公告，玩家可关闭当前这条）                                                                |
| `ui.cells`                | 一小块格子，可选中、可点（城区九宫格）                                                                     |
| `ui.grid`                 | 格子地图的一个窗口，带图例、选中格子的按钮与表单、旁边的列表（世界地图、示例里的异世界）                   |
| `ui.tree`                 | 分组分列的节点图与前置连线（科技树）                                                                       |
| `ui.report` / `ui.lanes`  | 报告与逐行对比表；邮件用 `mail.present(kind, fn)` 整形（战报、冒险报告）                                   |
| `ui.sync`                 | 不显示：到点刷新或执行命令（行军到达即提交）                                                               |
| 表单字段 `ui.lanes-input` | 几路分配一个池子（攻打的阵列）                                                                             |

文字用 `UiText`（`{ text, vars }`，`text` 是本插件 CSV 的键，即英文原文；前端按视图所属插件加前缀后翻译）。人名用名字键（"s:Zhao m:Zilong"），前端按语言拼写。简单的操作直接在命令上加 `form`（服务端表单），按 `placement` 出现在相应位置。

**通用控件不够用时**，写自己的前端插件：`client.ts` 默认导出 `defineClientPlugin({ id, setup(game) { game.widget('<id>.<名字>', 组件) } })`，组件里用 `useGame('<你的前端插件id>')`：`game.view('<view>')`（或 `game.state.value.views[...]`）读数据、`game.command()` 执行命令、`game.t()` 翻译、`game.messages('zh-CN', {...})` 加前端自己的文字（成为 `@<前端插件id>.<文字>`，与别的插件互不冲突）；位置照样由后端声明（参考 `examples/clock/`）。界面写在 `<template>` 里（禁止 `v-html`），颜色只用 `web/styles.css` 的变量。

## 8. 扩展：不改官方代码

把插件放进 `extensions/<id>/`，前后端在构建时自动收集（`import.meta.glob`），官方清单不用动：

```
extensions/<id>/
  server.ts      默认导出后端插件（definePlugin），从 '../../src/kernel' 引入内核
  client.ts      可选：默认导出前端插件（defineClientPlugin），从 '../../web/core/game' 引入
  *.vue          可选：client.ts 用到的组件
  data/          CSV（含 i18n.csv）
```

- 要存数据的扩展：迁移文件照样放进仓库根目录的 `migrations/`（`NNNN_<id>_<说明>.sql`，表名以 id 开头），部署前 `pnpm db:migrate`。
- 类型：`server.ts` 由根目录的 `tsconfig.json`、`client.ts` 和 `.vue` 由 `web/tsconfig.json` 检查，`pnpm check` 会一起把关。
- 测试：在 `test/` 里 `createKernel([...plugins, myExtension])`（`plugins` 已经包含 `extensions/` 里的全部）。
- 去掉一个扩展 = 删掉它的目录（已经建的表留着，代码不再用它）。

## 9. 测试

- 游戏规则写成引擎测试（`test/game/*.spec.ts` 的风格，工具在 `test/helpers.ts`）：`createKernel([...plugins, myPlugin])`，用 `player(overrides, kernel)` 建一个新玩家（每个测试一个新玩家），`p.run(时间, 命令, 参数, 是否 GM)`、`p.views(时间, [视图])`，时间用假时钟。
- 至少覆盖：正常路径、非法输入、资源不足等拒绝路径；跨玩家的命令要有并行测试；有权限的路由要测"无权限被拒"（`test/api.spec.ts`）。
- 断言比对 id、数值和结构；文字比对键和变量（`{ text: '<插件id>.<key>', vars }`），要看整句时用 `test/helpers.ts` 的 `en(ui)`。文字是否都有译文由 i18n 完整性测试统一把关。
- 界面或文案改动后跑 `pnpm smoke`（临时库 + 生产构建，逐页检查控制台错误和未翻译的文字，不碰 `.data/local`）。

## 10. 提交前检查

- [ ] `pnpm check` 通过。
- [ ] 插件 id、命令、视图、规则、表都以插件 id 为前缀；`dependsOn` 写全。
- [ ] 没有 import 别的插件的运行时代码；系统插件里没有写死别的插件的内容 id。
- [ ] 数字在 CSV 或规则里；规则的 `parse` 校验了输入；名称、消息、规则说明的中文在本插件的 `data/i18n.csv`。
- [ ] 命令可以安全重试；没有读 `Date.now()`；改别的玩家前 `api.lock`。
- [ ] 改变产率、消耗、库存上限之前先 `resources.settle`（时间线处理函数里不用）。
- [ ] 新表只通过新增迁移；视图在没有数据时返回空值而不是抛错。
