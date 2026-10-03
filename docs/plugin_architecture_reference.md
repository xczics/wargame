# 插件清单

> 2026-10-02 按 `src/plugins/*/index.ts` 整理（id、依赖、提供的服务以代码为准）。怎么写插件见 [plugin-guide.md](plugin-guide.md)；扩展点的详细说明在各插件 `index.ts` 开头的注释和导出的接口里。

共 45 个后端插件，都在 `src/plugins.ts` 里注册；内核按 `dependsOn` 排序装配。

## 平台

| 插件       | 作用                                                                                                                         | 依赖     | 提供的服务            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `accounts` | 登录、会话、注册守卫、GM（由密钥决定）                                                                                       | —        | `accounts`、`session` |
| `invites`  | 邀请码（注册守卫）                                                                                                           | accounts | —                     |
| `gm`       | GM 后台：实时规则、玩家工具、以其身份游玩、报表、审计                                                                        | accounts | `configStore`         |
| `http-api` | /api/meta、/api/state、/api/command                                                                                          | accounts | —                     |
| `forms`    | 把命令的 form 列给前端（视图 ui.forms）                                                                                      | —        | —                     |
| `ui`       | 服务端声明界面布局：页面、栏、入口、窄带、插槽、邮件组件（meta `ui`）                                                        | —        | `ui`                  |
| `i18n`     | 各插件的 `data/i18n.csv`（`key,en,zh-CN…`）登记为 `<插件id>.<key>`、拼出来的内容名 `derive`、翻译插槽 `inject`，随 meta 下发 | —        | `i18n`                |

## 系统插件（机制与扩展点，不含具体内容）

| 插件          | 作用                                                                                 | 依赖                                                                                            | 提供的服务    |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------- |
| `stats`       | 数值 =（基础 + 固定）×（1 + 百分比），上限 / 容量 / 队列都是 stat                    | —                                                                                               | `stats`       |
| `timeline`    | 按实体的定时事件，读取前按顺序处理；每分钟清扫                                       | —                                                                                               | `timeline`    |
| `world-map`   | 1024×1024 环面地图、格子占用                                                         | —                                                                                               | `worldMap`    |
| `resources`   | 按城池的资源池：产出、维持、库存上限、欠债、耗尽；花费 / 返还通知                    | stats、timeline                                                                                 | `resources`   |
| `settlements` | 城池类型注册、内城 / 外城 / 栏位、建城、外城扩建、移除、数量上限、改名（及改名拦截） | accounts、world-map、stats、resources、timeline                                                 | `settlements` |
| `buildings`   | 建筑类型、策划表、上限与突破、拦截、建造队列、同城区内移位 / 换位                    | settlements、resources、stats、timeline                                                         | `buildings`   |
| `terrain`     | 地形分片、城区产出加成、地形比例（mix）                                              | world-map、settlements、buildings、resources                                                    | `terrain`     |
| `research`    | 科技：按玩家等级、研究所队列、前置、按等级段拦截建筑、效果描述                       | buildings、settlements、resources、stats、timeline                                              | `research`    |
| `items`       | 背包；可用道具自动变成命令 items.use.<id>；有概率成功的道具的保底（odds / attempt）  | —                                                                                               | `items`       |
| `queues`      | 城池里排队的活：付费排队、每条队列一项一项做、未开工全额返还、加速、旧数据接管       | settlements、resources、stats、timeline                                                         | `queues`      |
| `troops`      | 兵种、训练（每座兵营一条队列）、驻军、维持、短缺                                     | settlements、resources、stats、timeline、queues                                                 | `troops`      |
| `armies`      | 行军、行军目的、遭遇、召回、来袭警报（含其他来源）                                   | troops、settlements、world-map、timeline、resources、accounts、stats                            | `armies`      |
| `settling`    | 筑城（行军目的 settle）                                                              | armies、settlements、stats、world-map                                                           | —             |
| `battle`      | 五路战斗：阵列、相克、修改器、伤亡钩子、晋升                                         | troops、settlements、armies、stats                                                              | `battle`      |
| `pvp`         | 攻打玩家城池（pvp.raid：守军、掠夺、守方战报）                                       | armies、troops、settlements、resources、accounts、stats、battle                                 | `pvp`         |
| `heroes`      | 英雄：属性 / 招募地点 / 职务注册、招募（加候选、刷新候选）、成长、名字（改名）       | settlements、buildings、resources、stats                                                        | `heroes`      |
| `mail`        | 邮箱：其他插件发消息                                                                 | —                                                                                               | `mail`        |
| `loot`        | 奖励池与掉落算法：按权重抽到最低总价值为止、预览分组、GM 改权重                      | —                                                                                               | `loot`        |
| `realms`      | 秘境：冒险、掉落池、钥匙                                                             | heroes、settlements、resources、stats、timeline、world-map、mail                                | `realms`      |
| `equipment`   | 装备：部位、稀有度、穿戴、存放、拆解                                                 | heroes、settlements、resources、stats、timeline、buildings                                      | `equipment`   |
| `shop`        | 元宝商城：钱包、商品、每日限购                                                       | items                                                                                           | `shop`        |
| `prestige`    | 声望与官职（只升不降），官职的 stat 加成                                             | resources、settlements、stats                                                                   | `prestige`    |
| `bandits`     | 流寇：调度、类型 / 等级、来袭、战斗、掉落池                                          | timeline、settlements、resources、troops、battle、pvp、armies、prestige、terrain、heroes、stats | `bandits`     |
| `npc-camps`   | NPC 据点与要塞（1–10 级），被攻打时的战斗与掠夺，拔除（行军目的 uproot）             | settlements、world-map、armies、resources、troops、battle、terrain、heroes                      | —             |
| `war-reports` | 把战斗、被攻击、短缺写成邮件                                                         | mail、armies、pvp、troops、settlements、resources、accounts                                     | —             |

## 内容插件（调用系统插件的服务填内容）

| 插件                 | 作用                                                               | 依赖                                                                                              | 提供的服务 |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------- |
| `player-settlements` | 内容：首都、分城、资源要塞、军事要塞                               | settlements、resources                                                                            | —          |
| `starter-content`    | 内容：五种资源、资源建筑、仓库、宫殿、市政厅                       | resources、buildings、settlements                                                                 | —          |
| `starter-army`       | 内容：步 / 弓 / 骑 × 6 级、三座兵营、相克                          | troops、buildings、resources、battle                                                              | —          |
| `starter-auxiliary`  | 内容：军医、辎重、车（辎重营）                                     | troops、battle、armies、buildings                                                                 | —          |
| `starter-defense`    | 内容：城墙、隐藏仓库                                               | buildings、settlements、battle、player-settlements、stats、pvp                                    | —          |
| `starter-siege`      | 内容：城防工事与守城器械                                           | starter-defense、buildings、settlements、resources、battle、timeline                              | —          |
| `starter-heroes`     | 内容：酒馆 / 书院 / 听曲楼、六维、名字库、职务加成、天赋           | heroes、buildings、settlements、resources、stats、troops、research、armies、battle                | —          |
| `starter-research`   | 内容：科技树（内政 / 军事、四阶）、研究所                          | research、buildings、settlements、resources、stats、troops、battle、armies、terrain               | —          |
| `starter-items`      | 内容：外城许可、突破石、土地契、筑城诏书、要塞许可、加速、资源券…… | items、settlements、buildings、mail、resources、stats、timeline、troops、research、heroes、realms | —          |
| `starter-levies`     | 内容：招募令（2–4 级兵的训练额度）                                 | troops、items、shop、realms、bandits、starter-army                                                | —          |
| `starter-realms`     | 内容：十个秘境、怪物、冒险属性、掉落、钥匙                         | realms、heroes、items、starter-items、settlements、resources                                      | —          |
| `starter-equipment`  | 内容：七套装备 + 四套饰品、五色、秘境商店                          | equipment、heroes、realms、battle、stats、settlements、buildings、resources                       | —          |
| `starter-shop`       | 内容：商城默认商品                                                 | shop、starter-items                                                                               | —          |
| `starter-prestige`   | 内容：30 个官职、五个分城节点                                      | prestige、player-settlements                                                                      | —          |
| `starter-bandits`    | 内容：六种流寇、1–10 级、默认掉落                                  | bandits、resources、settlements                                                                   | —          |

## 前端插件

`web/plugins/` 下 7 个（外壳：auth、settlement、resource-bar、forms；框架自己的文字在 `web/core/messages.ts`；通用控件：widgets（`web/widgets/` 里的 `ui.*`）；邮箱：mail；GM 后台：gm-panel），在 `web/plugins.ts` 里注册。整合计划见 [architecture.md](design/architecture.md) 第 3 节。
