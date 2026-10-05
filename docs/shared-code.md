# 共享代码与复用登记

> 写给要写代码的人（包括 AI 代理）。**写一个新函数之前，先查第 1 节**：已经有的直接用。**写完一个可能被别处用到的函数，在第 2 节登记一行**。后来的人需要同样的东西时先看第 2 节：用得上，就把它挪进共享模块，并把那一行移到第 3 节，不要各写一套。

## 1. 已有的共享模块（先查这里）

| 要做的事                                         | 用什么                                                                                                                                                                                     | 位置                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 校验命令 / 报表的输入                            | `shape({ 字段: fields.xxx() }, refine?)`：`id`、`text`、`int`、`number`、`bool`、`oneOf`、`list`、`record`、`object`、`optional`、`orElse`、`raw`                                          | `src/kernel/fields.ts`                          |
| 报玩家看得到的错                                 | 文件顶上 `const fail = gameErrors('<插件id>')`，`throw fail(code, message \| text(key, vars), status?)`；包一层别的报错用 `errorText(err)`                                                 | `src/kernel/errors.ts`                          |
| 校验 GM 改的规则                                 | `numberInRange`、`numberRecord`、`recordOf`、`numberFields`                                                                                                                                | `src/kernel/config.ts`                          |
| 读 CSV 数据表；随等级先线性后加速增长的数        | `csvRows`、`csvNumber`、`csvMap`、`csvRules`、`csvLevels`；`planRow`、`stagedGrowth`（前后端共用，在 `src/shared/levels.ts`，内核转出口）                                                  | `src/kernel/data.ts`、`src/shared/levels.ts`    |
| 可重现的随机数；有下限、上限和最常见值的随机整数 | `seededRandom(seed)`、`triangularInt(min, mode, max, random)`                                                                                                                              | `src/kernel/random.ts`                          |
| 数字、费用、时长、带符号的变化量                 | `amount`、`whole`、`signed`、`amounts`、`costParts`、`duration`                                                                                                                            | `src/shared/format.ts`                          |
| 前端显示时间、大数字                             | `formatTime`（按游戏语言）、`formatNumber`                                                                                                                                                 | `web/core/format.ts`                            |
| 要显示的文字（`UiText`）                         | 文件顶上 `const text = uiTexts('<插件id>')`，`text(key, vars)`；`keyText`（完整键）、`literal`（原样显示）；拼出来的内容名用 `i18n.derive`                                                 | `src/shared/i18n.ts`、i18n 服务                 |
| 界面数据形状（卡片、行、计时、树、格子……）       | `CardsData`、`RowsData`、`TimersData`… 与通用控件 `ui.*`                                                                                                                                   | `src/shared/ui.ts`、`web/widgets/`              |
| 玩家视图叠在静态视图上（合并、计数判断）         | `mergeCards` / `mergeRows` / `mergeTree`、`expandChoices`（卡片的选项）、`resolveCell`（表格单元的计数）、`defineTemplates`（按名字登记的模板生成器）；前端控件和测试辅助 `p.shown()` 共用 | `src/shared/statics.ts`                         |
| 建筑任意等级的费用、工期、效果、卡片             | `levelCost`、`levelEffects`、`statAt`、`effectTexts`、`buildingCard`、`buildChoice`（服务端报价和浏览器建卡片同一份）                                                                      | `src/shared/buildings.ts`                       |
| 视图的戳：只随玩家命令、规则、本城事件变的数据   | `settlements.stamp(api, params)`（城池页、英雄页的视图都用它；请求参数由内核自动并入戳）                                                                                                   | settlements 服务                                |
| 城池的名字（发给前端）                           | `settlements.nameText(s)`（默认名是键，玩家改的名字原样显示）                                                                                                                              | settlements 服务                                |
| 掉落（奖励池、按权重抽、预览分组）               | `loot` 服务：`definePool`、`addDrop`、`roll`、`give`、`preview`、`empty`；不要自己写加权抽取                                                                                               | loot 服务                                       |
| 某个数从哪来（悬停说明、"速度：研究所 +20%"）    | `stats.breakdown`（基础值 + 各来源）、`stats.describe`（变成一行行文字）、`stats.factors` / `stats.factorParts`（时间、费用等倍率按来源合并）；按钮和状态行的 `hint`                       | stats 服务、`web/widgets/text.ts` 的 `hintText` |
| 排队的活（付费排队、依次开工、取消返还、加速）   | `queues` 服务：`define`、`add`、`cancel`、`speedUp`、`jobs`；不要自己写队列表和开工逻辑                                                                                                    | queues 服务                                     |
| 有概率成功、带保底的道具                         | `items.odds` / `items.attempt` / `items.describeOdds`（失败累计、保底必成、过期清零；成功率只给 GM 看）                                                                                    | items 服务                                      |
| 英雄的名字（发给前端）                           | `heroes.nameKey(hero)`                                                                                                                                                                     | heroes 服务                                     |
| "这个英雄 / 城池是不是这个玩家的"                | `heroes.requireOwned`、`heroes.requireFree`、`settlements.requireOwned`、`settlements.resolve`                                                                                             | heroes / settlements 服务                       |
| 新的装备放进存放处（满了报错）                   | `equipment.createOrRefuse`                                                                                                                                                                 | equipment 服务                                  |
| 用户名                                           | `accounts.usernames(db, ids)`                                                                                                                                                              | accounts 服务                                   |
| 测试里看整句英文                                 | `en(ui)`（按 meta 的英文渲染 `UiText`；能按结构比对时优先按结构）                                                                                                                          | `test/helpers.ts`                               |

服务的完整清单见 [插件清单](plugin_architecture_reference.md)，内核扩展点见 [开发文档](development.md) 2.2 节。

## 2. 候选：可能被复用、还没放进共享模块的函数

登记格式：函数（或写法）、在哪、可能的用途、登记日期。用到它的第二个地方出现时，把它挪进合适的共享模块（内核、`src/shared/`、或拥有该数据的插件的服务），然后把这一行移到第 3 节。

| 函数 / 写法                                                                   | 在哪                                                                                                     | 可能的用途                                                                         | 登记       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| D1 的 `IN (…)` 按 100 个一批查询                                              | `settlements`（3 处）、`accounts.usernames`                                                              | 任何按一批 id 查表的地方（D1 每条语句最多 100 个绑定参数）；可做成内核的 `chunked` | 2026-10-02 |
| 下拉框把几个值编成一个（`"a\|b\|c"`、`"a@x,y"`、`"a:b"`），在 `refine` 里拆开 | `buildings`（`targetSlot`）、`heroes`（放置候选）、`settlements`（GM 建外城）、`starter-items`（土地契） | 可做成 `fields.parts(separator, [fields…])`，表单与校验同源                        | 2026-10-02 |
| "城池名 (x, y)" 的选项文字                                                    | `resources`、`troops` 的 GM 表单                                                                         | 任何列出城池的下拉框；可做成 settlements 服务的 `label(s)`                         | 2026-10-02 |
| 地图生成脚本里的种子随机数（与 `seededRandom` 同一算法）                      | `scripts/map/generate.mjs`                                                                               | 脚本不能导入 TS 内核；以后脚本改成 TS 时直接用 `seededRandom`                      | 2026-10-02 |

## 3. 已经收进共享模块的（记录去向）

| 原来的写法                                                                                | 现在用什么                                                              | 日期       |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| 各插件手写的命令参数检查                                                                  | `shape` / `fields`（`src/kernel/fields.ts`）                            | 2026-10-02 |
| `new GameError(…, '<插件id>')`                                                            | `gameErrors` / `fail`                                                   | 2026-10-02 |
| prestige / shop 的 `whole`、research 的 `signed`                                          | `src/shared/format.ts` 的 `whole`、`signed`                             | 2026-10-02 |
| 手拼的 `${surname} ${given}`                                                              | `heroes.nameKey`                                                        | 2026-10-02 |
| 各插件自写的"没有这位英雄"、"本城放不下了"                                                | `heroes.requireOwned`、`equipment.createOrRefuse`                       | 2026-10-02 |
| 前端猜"是不是键"、按模式反查句子（`keyMatcher`、`ownViews`、`createCatalog`）、拼接字符串 | 结构化文字 `UiText`（`uiTexts` / `keyText` / `literal`）、`i18n.derive` | 2026-10-02 |
| war-reports 的 `nameOf` 与 `settlementName`                                               | 合成一个 `settlementName`（返回 `UiText`）                              | 2026-10-02 |
