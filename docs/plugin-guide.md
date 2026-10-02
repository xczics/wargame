# 插件开发指南

写给想给这个游戏加新玩法、新内容的开发者（包括第三方）。读完这一篇，再照着 `examples/watchtower/` 改，就能写出第一个插件。项目约定的完整版在 [AGENTS.md](../AGENTS.md)，已实现的架构在 [development.md](development.md) 第 2 节，所有插件的清单在 [plugin_architecture_reference.md](plugin_architecture_reference.md)。

## 1. 五分钟上手

1. 读示例插件 [`examples/watchtower/`](../examples/watchtower/)：一座"箭楼"建筑，每级给所在城池守军的每一路加防御。一共四个文件：
   - `index.ts`：插件本身（40 行）；
   - `data/buildings.csv`、`data/levels.csv`：建筑与 1–7 级的造价；
   - `data/rules.csv`：设计数值（GM 可以在后台实时改）。
2. 跑它的测试：`pnpm exec vitest run -t "example plugin"`（在 `test/game.spec.ts` 末尾：把插件装进内核、建箭楼、派一股流寇来打，检查战报里有箭楼的防御加成）。
3. 想让它进游戏：在 `src/plugins.ts` 里 `import` 并加进 `plugins` 数组（顺序无所谓，内核按 `dependsOn` 排序），`pnpm dev` 打开浏览器就能在城池的内城里建箭楼。
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

失败分两种：玩家能看到的失败抛 `GameError(code, message)`（例如资源不够）；装配错误、编程错误抛 `PluginError`。

## 5. 数据与规则

- **内容和数值放在插件目录的 `data/*.csv`**，用 `import x from './data/x.csv?raw'` 导入（构建时打进 Worker），代码只负责读取、校验和使用。首行是表头，`#` 开头是注释，含逗号的单元格加引号。
- 解析工具在内核：`csvRows`、`csvNumber`、`csvMap`（`"key:n; key:n"`）、`csvRules`（`key,value` 两列，点号表示嵌套）、`csvLevels` / `planRow`（策划表）。
- **格式归系统插件**：建筑表用 `buildings.defineFromCsv`、资源用 `resources.defineFromCsv`、科技用 `research.defineFromCsv`、流寇用 `bandits.defineKindsFromCsv`……内容插件只提供文件。
- **影响平衡的数字用规则暴露**（`ctx.config.define`），在 `default` 里读 CSV；`parse` 要严格校验 GM 的输入（`numberInRange` / `numberFields` / `numberRecord`），对象型规则支持部分覆盖。顺序：GM 指定 > 插件 CSV > 代码兜底。规则对所有玩家立即生效（包括离线时间）。
- **文案跟插件走**：插件目录下的 `data/i18n.csv`（两列 `key,zh-CN`，`key` 是界面上或服务端消息里的英文原文，可以带占位符 `{0}`），在 `setup` 里 `ctx.services.get('i18n').addCsv(i18nCsv)`（`dependsOn` 加 `'i18n'`），随 `/api/meta` 下发。内容名称、表单文字、服务端消息、规则说明（`rule:<插件>.<规则名>`）、插件名（`plugin:<插件id>`）都放这里；新内容不用改前端。规则里通用的字段名中文在前端 `web/plugins/gm-panel/rules-zh.ts` 的 `fieldsZh`。

## 6. 常见做法（菜谱）

| 想做的事                   | 用什么                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新资源                     | `resources.define` / `defineFromCsv`；产出 `resources.addProducer`，维持 `addConsumer`；花费 `resources.spend(api, holder, cost)`，返还 `refund`        |
| 新建筑                     | `buildings.defineFromCsv(buildings, levels)`（1–7 级必须有造价）；拦截升级 `buildings.addGate`；突破上限 `buildings.raiseCap`；查等级 `buildings.level` |
| 上限、容量、加成           | 拥有者 `stats.define`，给加成的 `stats.contribute`；不要在消费方写死"几级加几"                                                                          |
| 新兵种                     | `troops.define`（`trainedAt` 写训练它的建筑）；训练门槛 `addTrainingGate`；额外消耗 `addTrainingRequirement`；时间 `addTrainingTimeModifier`            |
| 科技                       | `research.defineFromCsv`；效果多半是 stat 加成或战斗修改器                                                                                              |
| 战斗加成                   | `battle.addModifier(async (api, side) => [{ source, stat, flat?, percent?, family? }])`；伤亡 `battle.addCasualtyHook`                                  |
| 定时发生的事               | `timeline.schedule(api, entity, dueAt, type, payload)` + `timeline.on(type, handler)`；新的实体前缀要 `timeline.addOwnerResolver`                       |
| 道具                       | `items.define({ id, name, use: { parse, apply, form } })`；发放 `items.grant`；告诉玩家去哪拿 `items.addSource`                                         |
| 商城商品                   | `shop.defineOffer({ id, item, count, price, category, dailyLimit })`（价格是整数元宝）                                                                  |
| 秘境 / 流寇掉落            | `realms.addDrop(...)` / `bandits.addDrop(...)`：权重 + `give(api, ctx)` 返回战报里的奖励行                                                              |
| 城池类型、行军目的、遭遇战 | `settlements.defineKind`、`armies.defineMission`、`armies.addEncounter`；攻打玩家城池用 `pvp.raid`                                                      |
| 英雄                       | `heroes.defineAttribute` / `defineVenue` / `defineDuty`、`heroes.addAttributeBonus`                                                                     |
| 给玩家发消息               | `mail.send(api, playerId, { kind, title, vars, data })`（和命令同一次提交）；后端 `ui.mail(kind, 组件名)` 指定前端用哪个组件显示                        |
| 声望                       | `prestige.add(api, playerId, amount)`；花费自动计入                                                                                                     |
| 简单的操作界面             | 命令上加 `form`（字段、`prepare` 决定是否显示并填选项），不用写前端                                                                                     |
| 存自己的数据               | 新增迁移 `migrations/NNNN_<插件id>_<说明>.sql`，表名以插件 id 开头；数量字段加 `CHECK (x >= 0)`。只能新增迁移，不能改已发布的                           |

## 7. 前端

前端是 Vue 3，只通过 `/api/*` 和后端通信，类型在 `src/shared/api.ts`。**放在哪由后端声明**：后端插件依赖 `ui`，用 `ui.page / block / entry / band / slot / mail` 声明页面、左右栏的内容块、建筑入口里的内容块、窄带、插槽（`user-actions`、`hero-card`）、邮件的显示组件。前端插件 = `web/plugins/<id>/index.ts`（`defineClientPlugin`）+ `.vue` 组件，只用 `game.widget('<id>.<名字>', 组件)` 注册组件；`game.need('<view>')` 声明要读的视图、`game.view('<view>')` 读数据、`game.command()` 执行命令、`game.messages('zh-CN', {...})` 加中文。界面一律写在 `<template>` 里，颜色只用 `web/styles.css` 的变量。能用命令表单解决的，就不必写前端。

> 规划中：后端用 `ctx.ui` 声明"显示什么、放在哪"，前端只剩通用控件，文案也下沉到各后端插件（见 [architecture.md](design/architecture.md) 第 3 节）。实现后本节会改写。

## 8. 测试

- 游戏规则写成引擎测试（`test/game.spec.ts` 的风格）：`createKernel([...plugins, myPlugin])`，用 `player(overrides, kernel)` 建一个新玩家（每个测试一个新玩家），`p.run(时间, 命令, 参数, 是否 GM)`、`p.views(时间, [视图])`，时间用假时钟。
- 至少覆盖：正常路径、非法输入、资源不足等拒绝路径；跨玩家的命令要有并行测试；有权限的路由要测"无权限被拒"（`test/api.spec.ts`）。
- 前端改动至少用 `pnpm dev` 或 `pnpm preview` 在浏览器里看一遍（冒烟测试别用 `.data/local`，做法见 `docs/HANDOFF.md`）。

## 9. 提交前检查

- [ ] `pnpm check` 通过。
- [ ] 插件 id、命令、视图、规则、表都以插件 id 为前缀；`dependsOn` 写全。
- [ ] 没有 import 别的插件的运行时代码；系统插件里没有写死别的插件的内容 id。
- [ ] 数字在 CSV 或规则里；规则的 `parse` 校验了输入；名称、消息、规则说明的中文在本插件的 `data/i18n.csv`。
- [ ] 命令可以安全重试；没有读 `Date.now()`；改别的玩家前 `api.lock`。
- [ ] 改变产率、消耗、库存上限之前先 `resources.settle`（时间线处理函数里不用）。
- [ ] 新表只通过新增迁移；视图在没有数据时返回空值而不是抛错。
