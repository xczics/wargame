# 开发交接（2026-09-30）

> **玩法设计以 `docs/design/gameplay.md` 为准**，界面布局以 `docs/design/ui.md` 为准。

## 0. 当前任务：按 gameplay.md 分步实现（2026-09-30 起）

用户要求：按 `docs/design/gameplay.md` 依次实现玩法，**小步快走，每完成一小步更新一次本节**。不确定的地方先按猜测或游戏的常见做法实现，并在设计文档里注明"暂按……实现"，保持文档与代码同步。

**路线图**（✅ 完成，▶ 进行中）：

| 步骤   | 内容                                                                                   | 设计文档      |
| ------ | -------------------------------------------------------------------------------------- | ------------- |
| ✅ L   | 页面布局框架：顶部标签 / 底部状态 / 左右两栏；插件注册页面、内容块、建筑入口           | ui.md         |
| ✅ W1  | 五种资源（新增金属、货币改名）与对应生产建筑；钱庄"每个城区一座"                       | 1             |
| ✅ W2  | 兵种：步 / 弓 / 骑 × 6 级，生命属性，属性 / 速度 / 载重按公式（可调规则）              | 2.1–2.4、3.9  |
| ✅ W3  | 三座兵营：等级解锁、训练时间曲线、训练花销与维持开销公式、2–4 级训练额度接口           | 2.5           |
| ✅ W4  | 短缺后果：12 小时内逐步溃逃 / 降级                                                     | 2.5.3         |
| ✅ W5  | 行军：最短 3 分钟、维持开销预付与召回返还                                              | 2.4、2.5.3    |
| ✅ W6  | 城墙与防守阵列、进攻布阵（5 路）                                                       | 3.1–3.4       |
| ✅ W7  | 新战斗公式：按路、相克、胜出路数、伤亡系数、修改器                                     | 3.5–3.8、3.11 |
| ✅ W8  | 掠夺、隐藏仓库、载重                                                                   | 3.9           |
| ✅ W9  | 战斗晋升                                                                               | 2.6           |
| ✅ W10 | 辅助兵种接口                                                                           | 3.10          |
| ✅ D   | 数据与代码分离：内容插件的策划数据放进插件目录的 CSV，代码只负责读取和校验（用户要求） | AGENTS.md     |
| ✅ W11 | 地形插件、地图生成与导入                                                               | 4             |
| ✅ W12 | 英雄                                                                                   | 5             |

**进度记录**：

- **L 页面布局**（完成）：
  - 核心 `web/core/game.ts`：`game.page(id, label, { order, component? })`（无 component 为两栏页面，有则整页接管）、`game.block(page | EVERY_PAGE, 'left' | 'right', C)`、`game.band('top' | 'bottom', C)`、`game.entryBlock(kind, C, { order, types })`、`game.openEntry(entry)`、`game.entry`。旧的 `game.slot()` 已删除。
  - 布局组件：`web/core/App.vue`（框架，最大 1440px 居中，<744px 单栏）、`web/core/PageColumns.vue`（两栏、各自滚动、入口替换右栏）。
  - 建筑入口：`city` 插件在 SlotCard 标题上打开入口，`BuildingBlock` 是第一块（`order: -100`）；`forms` 插件的 `EntryForms` 把 `placement` 为入口类型（`building`）的服务端表单挂进来，上下文带 `settlement / district / slot / type`。
  - 地图、GM 为整页接管；其他页面内容暂时整块放在右栏，左栏是城池切换和全局表单。
  - 已在浏览器冒烟测试（1600 / 1100 / 390 宽）中验证，控制台无报错。
- **W1 五种资源**（完成）：
  - `starter-content`：资源顺序为石头、木头、粮食、金属、货币。新增金属 `metal`（初始 200）和冶铁坊 `ironworks`。**货币沿用 id `gold`、钱庄沿用 id `gold-mine`**，只改显示名（Currency / Counting House），这样已有存档不用迁移；已有玩家读取时，没有的金属按初始值补上。
  - `buildings`：`unique` 可取 `'district'`（每个城区最多一座，建造中的也算）。钱庄用它实现"每个外城 / 资源要塞一座"。
  - `starter-research` 新增科技"冶金"（冶铁坊 6–20 级）；`player-settlements.baseProduction` 默认值加入金属。
  - 插件隔离修正：`research.registerNode` 的 GM 表单原来写死了 `gold` 费用字段，改为按已注册的资源动态生成（`cost:<id>`）。
  - 中文：木头、石头、金属、货币、冶铁坊、钱庄。测试 +1（每城区一座钱庄），共 58 个。

- **W2 兵种**（完成）：
  - `troops`（系统）：`UnitDef` 改为 `{ id, name, icon, family?, tier?, trainable?, stats }`，`stats` 可以是函数（按当前规则计算，GM 改公式立即生效）；新增 `hp`。服务新增 `get` / `stats(api, id)` / `totals(api, units)`（攻、防、生命、载重之和与最慢速度）/ `addTrainingGate` / `addTrainingTimeModifier`。**去掉了对 `buildings` 的依赖**（原来的 `requires: { building }`）。meta `units` 只含静态信息，数值在新视图 `troops.units`（`UnitNumbers`）。
  - 新内容插件 `starter-army`：18 个兵种 `infantry|archer|cavalry-1..6`，按设计文档 2.2–2.5、3.9 的公式计算属性、速度（1024/36 格/小时，骑兵 ×1.15、每级 ×1.5）、载重（20 × 等级 × 兵种系数）、训练花销（100 × r^1.2 按兵种比例分摊）、训练时间（10 s × r^1.3）、维持（每小时 1 × r^0.8 按比例分摊，存为每秒）。可调规则：`starter-army.attributes / speed / carry / training / upkeep / costShares / upkeepShares / barracksLevels`。5–6 级 `trainable: false`。
  - 兵营从 `starter-content` 移到 `starter-army`，由它注册训练限制（兵营 1 / 5 / 10 / 15 级解锁 1–4 级）。**目前仍是一座兵营**，三座兵营在 W3。
  - `armies` 用 `troops.totals` 算速度、载重、攻击（`attackOf(api, units)`）。
  - 迁移 `0015`–`0017`：旧兵种 militia → infantry-1、spearman → infantry-2（驻军、训练、行军、时间线事件）。`npc-camps.defenders` 默认值同步改名。
  - 测试：战斗 / 行军测试改用测试文件内的 `test-units` 插件（固定数值的 militia / spearman），与公式解耦；新增 2 个 starter-army 测试（公式、GM 覆盖、兵营解锁、5–6 级不可训练）。共 60 个。
  - 前端：部队页显示攻 / 防 / 生命（来自 `troops.units`），维持费按每小时显示；兵种中文名"N级步兵"等。

- **W3 三座兵营**（完成）：
  - `starter-army`：步兵营（沿用 id `barracks`）、弓兵营 `archer-camp`、骑兵营 `cavalry-camp`，每城一座，造价暂用原兵营的策划表。各兵种由本兵种兵营的等级解锁（`starter-army.barracksLevels`）。
  - 训练时间随兵营等级缩短（`starter-army.barracksSpeed`：1–10 级每级 −5 个百分点，之后每级 ×0.95），通过 `troops.addTrainingTimeModifier` 接入。
  - `troops.addTrainingRequirement({ check, consume })`：训练时额外需要并消耗的东西（在同一次提交里），给"2–4 级训练额度"道具预留；没有插件注册时不限制。
  - `buildings.setLevel`（GM 命令，有表单）：直接设置已有建筑的等级，先结算资源。
  - 测试 +2（时间曲线、训练需求钩子），共 62 个。
  - 界面待办：训练表单目前在部队页（placement `troops`）。以后可以让兵营的建筑入口显示训练表单，但 `troops` 前端不能写死兵营 id，需要 `starter-army` 告诉前端"哪座建筑训练哪些兵种"（例如在 meta 或服务端表单里提供）。

- **W4 短缺后果**（完成）：
  - `resources`：耗尽事件 `resources.depleted` 改为在余额压到**负数上限**（`-debtLimit`）时触发（原来是到 0；默认上限为 0 时行为不变）。
  - `troops`：去掉 `desertionRate` / `deficitInterval`，新增 `shortageRounds`（12）/ `shortageInterval`（3600 s）。耗尽时开始短缺期，每轮削减的维持开销 = 当前缺口 ÷ 剩余轮数（每轮至少 1 个兵），每轮是一个时间线事件（沿用事件类型 `troops.deficit`，旧事件没有 `roundsLeft` 时从头开始）；最后一轮之后若仍短缺，每轮削减全部缺口。溃逃低级优先、降级高级优先（降到同系列下一级，1 级溃逃），同一等级按人数比例分摊。
  - `troops.addShortageRule(unit, resource) → 'rout' | 'downgrade' | null`；`starter-army` 注册"步兵缺金属、弓兵缺木头 → 降级"，其余默认溃逃。
  - 测试：溃逃分轮（4 轮到平衡）、降级（高级优先、1 级溃逃）；耗尽事件测试改为在负数上限触发。共 63 个。

- **W5 行军**（完成）：
  - `armies.minSeconds`（180）：单程最短时间。
  - 出征时按"每个兵每秒的维持开销 × 往返总秒数"一次扣清（`resources.spend`，不够则出征失败），存在新列 `armies_marches.provisions`（迁移 `0018`）；`ArmyInfo.provisions`。行军中的部队不在驻军里，不产生城池维持开销，也不参与短缺处理。
  - 新命令 `armies.recall { id }`：只能在去程中召回；回程时间 = 已走的时间；没用上的比例 = 1 − 2 × 已走时间 ÷ 往返总时长；这部分放进军队的 `loot`，**回城时才入库**（用户要求）。阵亡不返还（无需处理）。
  - 前端行军页：显示随军粮饷、召回按钮（确认后执行）。
  - 测试：原有行军 / NPC / PvP 测试加 `armies.minSeconds: 0`；新增"最短 3 分钟、预付、召回返还"测试。共 64 个。

- **修正 `resources.settle`**（W5 时发现）：原来只登记"提交前落盘"，到提交时才按**最终**产率从上次结算算到现在，所以"改变产率前先结算"并没有固定旧产率下的收支（例如部队回城后，城池被补扣了部队不在期间的维持费）。现在：不在该持有者自己的时间线事件中时，`settle` 立即同步时间线并按当前产率推进到 `api.now`；在其事件中时（时钟已在事件时刻）不推进。新增 `timeline.syncing(api, entity)`。已知近似：别的实体的事件（如军队回城）改动城池产率时，城池在事件**被处理时**结算，而不是事件时刻，误差最多一个清扫周期（约 1 分钟）。
- **W6 城墙与阵列**（完成）：
  - 新系统插件 `battle`：`defineFamily`（参战的兵种系列）/ `addCounter(strong, weak)` / `addModifier(provider)`（修改器：`{ source, stat: attack|defense|hp|counter|casualty, flat?, percent?, family?, tier? }`，flat 每路全额）/ `formation` / `fixFormation` / `familyOf`。防守阵列存 `battle_formations`（迁移 `0020`），没有保存时用城池 id 做种子生成默认阵列（每个系列至少一路，读多少次都一样），`fixFormation` 在战斗结算前落盘。命令 `battle.setFormation`（表单在城池页，校验每个系列至少一路）；视图 `battle.formation`；meta `battleFamilies`。
  - 进攻阵列：`armies.addSendOption({ key, fields, parse })`（新列 `armies_marches.options`，迁移 `0019`；遭遇时 `encounter.army.options`）。`battle` 注册 `formation` 选项：API 传 `formation`（5 路 `{ family, units }`，必须正好等于出征兵力）；表单选 `lane1..5` 的兵种，每种兵平均分到同系列的各路（余数给前面的路）；都不传时按出征兵种轮流排。
  - `starter-army` 注册步 / 弓 / 骑三个系列和相克（骑 > 步 > 弓 > 骑）。
  - 新内容插件 `starter-defense`：城墙 `wall`（造价 2–7 级按设计文档，1 级行暂定），允许建在四类玩家城池的中心城区；**建城时自动多一个栏位放 1 级城墙**（新通用接口 `settlements.onFounded`、`buildings.place`）。城墙作为防守方修改器：每级每路基础防御 100（资源要塞 150），每 5 级 +5%、最多 25%（`starter-defense.wall`）。**已有城池没有城墙**：玩家可以在空栏位自己建（付 1 级费用）。
  - 测试：默认阵列 / 改阵校验、进攻阵列的均分与显式校验；首都内城栏位 12 → 13（含城墙）。共 66 个。城墙的防御效果在 W7 用战报测试。
  - 界面待办：防守阵列表单现在在城池页；以后可以放进城墙的建筑入口。

- **W7 新战斗公式**（完成）：
  - `battle.fight(api, { attacker: { side, lanes }, defender: { side, lanes } })`（只读，调用方应用损失）：按设计文档 3.8 逐路计算——攻方攻击 vs 守方防御定胜负（平局守方胜）；双方伤害 = 对方攻击 − 己方防御，截断到己方生命；按人数分摊到各等级，低级不够死时溢出给更高等级；按胜出路数定五档结果（`gradeOf`），各方损失 × 伤亡系数（`battle.casualtyFactors`，接受 `casualty` 修改器），四舍五入且不超过人数。相克 `battle.counterFactor`（3，接受 `counter` 修改器）只作用于攻方攻击 / 守方防御。空的一路没有攻击和生命，但守方的固定防御（城墙）照算。修改器：`flat` 每路全额；`percent` 同项相加后相乘；带 `tier` 的百分比只作用于该等级的部分。
  - 辅助：`defenderLanes(units, formation)`（按阵列均分）、`attackerLanes(options, units)`（出征时的阵列或默认）、`randomFormation(seed)`。
  - `pvp`、`npc-camps` 改用 `battle.fight`；pvp 在结算前 `fixFormation` 落盘守方默认阵列。NPC：每场随机阵列（种子 `npc:<armyId>`，重试一致），`npc-camps.defenders.defense` 改为"营寨"：每路固定防御（修改器），默认据点 30、要塞 150；NPC 部队不损耗（沿用）。
  - 删除旧接口：`armies.battle / attack / attackOf / addAttackModifier`、`troops.addPowerModifier / deficitPenalty`（英雄等加成改走 `battle.addModifier`；缺金属改为降级）。`troops.power` 只返回攻 / 防 / 生命合计，供显示。
  - `BattleReport.battle`（`BattleDetail`）：每路双方的兵种、兵力、攻 / 防 / 生命、是否克制、分路损失（乘系数前），胜出路数、结果档次、伤亡系数、双方修改器；前端 `armies/BattleLanes.vue` 在行军报告和防守报告里显示（可折叠）。
  - 测试：按设计文档 3.8 示例（100 对 100 个 1 级骑兵，1 级城墙）逐项核对；PvP 大胜与掠夺；英雄修改器；NPC 据点 / 要塞。共 66 个。
  - 冒烟：本地预览里军队的到达 / 回城要靠每分钟的清扫任务，`vite preview` 不会触发 cron；手动测试时用 GM 命令 `timeline.sync { entity: "army:<id>" }` 推进。

- **W8 掠夺**（完成）：
  - `pvp.lootShares`（大胜 0.5 / 胜 0.35 / 险胜 0.2，其余不掠夺；替换旧的 `pvp.lootShare`）。每种资源：库存 × 比例 → 不超过"库存 − `pvp.protected`" → 各资源之和超过载重时按同一比例缩减，超出部分留在守方。载重 = 幸存部队载重之和。战斗修改器新增 `loot`（比例的百分比加成）、`carry`（载重的固定 / 百分比加成），由 pvp 从战报的攻方修改器读取。
  - `starter-defense` 新增隐藏仓库 `hidden-store`（每城一座，四类玩家城池都能建，造价按设计文档），通过 `stats.contribute('pvp.protected')` 每级保护每种资源 500（`starter-defense.hiddenStore`）。普通仓库不再带防掠夺效果。
  - NPC 据点的掠夺未改（幸存部队能带多少粮食就带多少）。
  - 测试：按设计文档 3.9 示例（粮 10,000 / 木 2,000、隐藏仓库 2 级、大胜、120 个 1 级骑兵）得到粮 2,500、木 500。共 67 个。

- **W9 战斗晋升**（完成）：
  - `battle.promotions(units, lost)`（纯计算，按 `family` / `tier`）：从 1 级逐级，本级额度 = 本级阵亡 + 下一级剩余 ÷ 本级；每晋升 1 个"开战时就是本级的幸存者"耗 N 份，先同兵种、再跨兵种 1:1；剩余 ÷ (N+1) 按兵种分别进位（暂按此实现）；最高级没有更高等级，额度作废。
  - `fight` 结果新增 `promotions`（溃败方、NPC 为空）；`BattleReport.promoted`。armies 在军队返程前把进攻方的晋升应用到幸存部队上；pvp 把守方的晋升应用到驻军上。前端报告显示"晋升"。
  - 测试：设计文档示例、跨兵种、最高级；3.8 示例战斗里守方 3 个阵亡额度晋升 3 个 1 级骑兵。共 68 个。

- **W10 辅助兵种接口**（完成）：
  - 不参战的兵种 = 没有在 `battle` 注册系列的兵种：照常训练、维持、行军、驻守，不进阵列、不计攻防生命；载重计入幸存部队的载重（另有 `carry` 修改器）。
  - `battle.addCasualtyHook({ source, damage?, spread?, total?, final? })`：覆盖 3.8 的第 2–5 步（每路伤害、每路按兵种的阵亡、汇总与伤亡系数、最终阵亡），钩子能看到这一方的全部部队（含辅助兵种），`final` 可以给辅助兵种记伤亡；每次修改记入 `BattleDetail.adjustments`。`fight` 的输入新增可选 `units`（这一方的全部部队），pvp / npc-camps 已传入。
  - 测试："军医"插件（辅助兵种 + final 钩子）减少阵亡并记入战报。共 69 个。

- **D 数据与代码分离**（完成，用户要求）：
  - 内核 `src/kernel/data.ts`：`csvRows` / `csvNumber` / `csvMap` / `csvRules` / `csvLevels` / `planRow`；CSV 用 `?raw` 导入（`src/types/raw.d.ts`），vite 构建和 vitest 都支持。
  - 系统插件提供读取自己格式的入口：`resources.defineFromCsv`、`buildings.defineFromCsv`、`research.defineFromCsv`。
  - 数据文件：`starter-content/data`（资源、建筑、策划表、城池自带产出）、`starter-army/data`（兵种系列、相克、公式参数、分摊比例、兵营）、`starter-defense/data`（城墙 / 隐藏仓库、各类城池的城墙防御、加成）、`starter-research/data`（研究所、科技、科技策划表）、`starter-items/data`（道具名称、突破范围）、`player-settlements/data`（栏位、上限、建城与外城费用）、`npc-camps/data`（营地防守、俘获、数量）、`battle` / `pvp` / `troops` / `armies` / `buildings` / `resources` / `settlements` 的 `data/rules.csv`（设计数值）。
  - 顺带修正的隔离问题：城池自带产出从 `player-settlements.baseProduction` 移到 `starter-content.baseProduction`（数据在 CSV）；`settlements.outerCost` 移到 `player-settlements.outerCost`（外城模板的 `cost` 函数），settlements 不再写死资源 id；兵种速度的"骑兵"判断改为 `families.csv` 的 `mounted` 列。
  - 策划表支持稀疏（按 AGENTS.md 的新约定）：1–7 级必须有值，更高等级可以留空（`null`），按倍率从最近的较低等级推算；科技同样支持。GM 规则编辑器显示空缺的等级并可"填写"或"加空行"。
  - 可调规则的键名变化：`starter-defense.wall`（只剩加成三项）+ 新 `starter-defense.wallDefense`（按城池类型）；`starter-content.baseProduction`、`player-settlements.outerCost`、`starter-items.breakthrough` 为新键；旧键若有 GM 覆盖会被忽略（后台显示为未知键）。
  - 测试 +4（CSV 工具、稀疏策划表），共 73 个。

- **W11a 地形插件**（完成）：
  - 新系统插件 `terrain`：地形种类与加成在 `terrain/data/terrains.csv`、`bonus.csv`（可用 `define` 注册新地形，单字符编码，永不改编码）。存储 `terrain_chunks`（迁移 `0021`，32×32 一块、每块一行 1024 个编码；没写过的块全是第一种地形 = 草地）。服务：`of` / `at` / `bonus` / `set`（先结算格子上的城池，锁定其他玩家）/ `addVisibility`（迷雾插槽）。
  - 产出加成：`resources` 的生产方可以返回"带自己百分比的片段"（`Production`），最终 = 数量 ×（1 + 全局加成 + 片段百分比），至少 0；资源池视图新增 `extra`。`buildings.addDistrictBonus` 让其他插件按城区给建筑产出加成；`terrain` 用它按城区所在格子的地形加成（`terrain.bonus` 可调，部分覆盖）。
  - `settlements.addTileLabel` / `tileLabel`：候选格显示标签；建外城、外城许可的候选格显示地形和加成。
  - 视图 `terrain.window`（x, y, radius ≤ 32）；meta `terrains`。GM：命令 `terrain.paint`（矩形，最多 64×64，有表单）、`terrain.importChunks`（导入脚本用，每次最多 8 块，逐块先结算再覆盖）；报表 `terrain.shares`（各地形占比与目标占比）。
  - 测试：默认规则里地形加成清零（`NO_TERRAIN_BONUS`），另有地形测试 2 个（加成与结算、窗口、候选标签；迷雾、导入、报表）。共 75 个。
- **W11b 地图着色**（完成）：地图页同一请求取 `terrain.window`，每格底色为地形颜色（`web/styles.css` 的 `--terrain-<id>`，浅色 / 深色各一套，未知地形 `--terrain-unknown`），城池改用边框标记（自己的金色、NPC 红色），下方有图例，选中格子显示地形名。已在浏览器（浅色、深色）验证。
- **W11c 地图生成**（完成）：`pnpm map:generate [--seed s] [--out dir] [--tries n] [--scale --warp --ridges --lakeMax --townSpacing --extraRoads --minPatch --tolerance]`（`scripts/map/generate.mjs`，新开发依赖 `simplex-noise`、`d3-delaunay`）。四维噪声采样环面（边缘无缝）→ fBm + 域扭曲 + 脊状噪声（山脉）→ Priority-Flood 填洼（湖泊，单体上限，阈值逐步放宽到目标占比）并得到汇水树 → 汇水量取分位数成河 → 湿度（噪声 + 离水距离）→ 按高度 / 湿度分位数划分山地、丘陵、荒漠、森林、草地（占比贴近 terrains.csv 目标）→ 丘陵山地里的矿脉 → 泊松圆盘集镇 + Delaunay + 最小生成树 + 少量环路 + A* 修路（河上架桥，不穿湖）→ 合并小碎块 → 64×64 区块公平性（价值 = 各资源 1 + 加成之和；过低的区块把荒漠改草地，仍不达标则换种子重来）。输出 map.csv（约 6.8 MB）、preview.png、stats.json。默认参数下种子 wargame：草地 34.4 / 森林 19.5 / 丘陵 11.4 / 山地 7.6 / 荒漠 11.9 / 池塘 6.0 / 河流 4.7 / 道路 3.6 / 矿脉 1.0（%），区块最大偏差 9%，约 6 秒。
  - 暂按实现 / 与设计的差异：Delaunay 在平面上做（不跨地图接缝连路），A* 在环面上走；公平性只把"过低"的区块往上调。
- **W11d 地图导入**（完成）：`pnpm map:import <map.csv> [--url …] [--yes]`（`scripts/map/import.mjs`）：先校验整份文件（尺寸、地形 id），确认后用 GM 账号（环境变量或 `.dev.vars`）登录，分 128 次调用 `terrain.importChunks`（每次 8 块，逐块先结算再覆盖）。本地对 `pnpm dev` / `pnpm preview` 的服务器执行（它们用 `.data/local`）。已用临时数据目录实测：导入约 2 秒，地图页与 CSV 逐格一致。

- **W12a 英雄与招募**（完成）：
  - 新系统插件 `heroes`（迁移 `0022`：`heroes_heroes`、`heroes_taken`、`heroes_defense`）：`defineAttribute` / `defineVenue`（建筑、按等级的候选数与刷新间隔、`draft(random)` 掷候选、费用）/ `defineDuty`（`inTown`、`manual`、`check`）/ `list` / `get` / `onDuty` / `assign` / `onDutyChange`。候选由（城池、地点、刷新时段、位置）做种子确定性生成，只记录已招募的位置（主键防止重复招募）。英雄数量上限 stat `heroes.cap`（默认 5，`heroes/data/rules.csv`）。命令：`heroes.recruit`、`heroes.assign`（手动职务）、`heroes.setHome`、`heroes.dismiss`（仅空闲）。视图 `heroes.list`、`heroes.candidates`；meta `heroes`。
  - 新内容插件 `starter-heroes`（数据全在 `data/`）：六维属性、酒馆 / 书院 / 听曲楼（首都、分城内城，每城一座，造价暂按研究所的曲线）、属性范围、侧重属性（必有一项接近上限）、听曲楼 10% 出现、"绝技"最高 130（暂定）、费用（货币 500 / 800 / 3000，暂定）、候选数（每 5 级 +1，上限按地点）与刷新（8 小时起每级 −0.25、至少 1 小时，暂定）。姓名存为字库键（`s:` / `m:` / `f:` 前缀），各语言写法由 meta `heroNames` 提供，前端拼接（避免全局词典里同拼音不同字冲突）。
  - `seededRandom` 移到内核（`src/kernel/random.ts`），battle 也改用它。
  - 测试 +1（招募、候选稳定与刷新、上限、遣散）。共 76 个。

- **W12b 职务与加成**（完成）：
  - 新通用接口：`buildings.quote` / `addTimeModifier`（建造时间修改器，建造与界面都用）、`troops.addUpkeepModifier`（驻军维持倍率；短缺处理按倍率换算）。`heroes.onDutyChange` 改为在变更**之前**调用（便于先结算）；`heroes.onDuty` 对"谁有英雄在此职务"做 memo，并总包含当前玩家。
  - `starter-heroes`：职务 `governor`（内政）、`scholar`（驻守研究所，需研究所）在 `data/duties.csv`；人数上限 stat `heroes.governors / scholars / commanders / defenders`（`starter-heroes.limits`，默认 3 / 2 / 3 / 3）；属性作用在 `data/effects.csv`：政务 → 产出 +%（`resources.productionFactor`）、建造时间 −%；魅力 → 训练时间 −%、维持 −%；学识 → 科研时间 −%（`research.addCostModifier`）。每点 0.2%（`starter-heroes.effect.perPoint`）。职务变更前结算涉及的城池。时间类加成按"× (1 − 百分比)"与其他倍率相乘（暂按此实现）。
  - 测试 +1（内政：产出、维持、建造时间、人数上限、研究所前置、先结算）。共 77 个。

- **W12c 带兵与守城**（完成）：
  - `armies`：出征附加选项新增 `onSend(api, value, army)`（军队创建后、同一提交内执行副作用）；新增 `armies.onReturn(listener)`（回城时通知）。
  - `heroes`：守城顺序表 `heroes_defense`，命令 `heroes.setDefenseOrder`（只能排挂靠在本城的英雄；空列表 = 恢复默认），视图 `heroes.defense`；`defenders(api, 城池, n)`：按顺序表（没有则按 `setDefenseScore` 的评分从高到低）取前 n 名**在城**的英雄。
  - `starter-heroes`：职务 `command`（带兵，不在城，不能手动指派）；出征附加选项 `heroes`（API 传 `heroes: [id]`，表单是 `hero1..N` 下拉；上限 stat `heroes.commanders`；只能选挂靠在出发城池、在城的英雄），出发时派为 `command`（目标 = 军队 id），回城时恢复空闲。战斗修改器：攻方 = 带兵英雄，守方 = 前 `heroes.defenders` 名守城武将；属性作用在 `effects.csv` 的 `command` / `defend` 行（武力 → 攻击 +%，统率 → 防御、生命 +%，智谋 → 伤亡 −%）；默认守城评分 = `defend` 行涉及的属性之和。
  - 测试 +1（带兵英雄与守城武将的战斗加成、回城恢复空闲、守城顺序校验）。共 78 个。
- **W12d 前端英雄页**（完成）：`web/plugins/heroes`：英雄页（左栏"我的英雄"：属性、职务、改派、改挂靠、遣散；右栏：当前城池的候选与招募、守城顺序），候选块同时挂到招募建筑的入口上（建筑 id 来自 meta）；名字按语言拼接，并把玩家英雄的英文全名注册进词典，使服务端表单里的名字也能翻译。候选视图新增 `taken`（本轮已招募的位置，显示"已招募"而不是"本轮无人"）。已在浏览器冒烟测试：建酒馆、书院 → 英雄页显示候选、倒计时、费用 → 招募后左栏出现英雄、守城顺序列表出现，控制台无报错。

**用户留言处理（2026-10-01 起，来自 `humannotes.md`）**：处理顺序：① 失效配置键 → ② 行军速度 → ③ 资源建筑 1–3 级不耗自身资源 → ④ 45° 像素风（仅文档）→ ⑤ 重新生成本地存档的地图 → ⑥ GM 加速行军 → ⑦ 行军目的（攻打 / 派遣 / 筑城）→ ⑧ 战报 / 邮箱 → ⑨ 训练移到兵营入口、部队页与行军页合并 → ⑩ 城池页显示英雄、研究所显示驻守学者 → ⑪ 地图总览（周围 NPC）。

- ✅ ① **失效的 GM 覆盖值**：日志里反复出现 `Ignoring invalid config overrides { 'generators.productionMultiplier': 'Unknown config key' }`。`ConfigStore` 新增可选的 `prune(env, keys)`；`loadConfig` 发现没有任何插件定义的键（规则改名或删除后留下的）就调用它删除，`gm` 插件同时写审计日志 `config.prune`（actor `system`）。已知键的非法值保留，由 GM 修正；`requestContext` 对同样的问题只警告一次，不再每个请求都打印。测试：`kernel.spec.ts` 的 "prunes stored overrides…"。
- ✅ ② **行军速度**：步兵 / 弓兵基础速度 28.4 → 120 格 / 小时（`starter-army/data/rules.csv` 的 `speed.base`，GM 仍可调），10 格约 5 分钟；设计文档 2.4 已同步。已在路上的军队仍按出发时算好的时间到达。
- ✅ ③ **资源建筑 1–3 级不耗自身资源**：通用规则 `buildings.ownResourceFreeUntil`（默认 3，`buildings/data/rules.csv`）：不超过该等级时，`levelCost` 去掉建筑自己 `produces` 里的资源（报价、扣费、取消返还都一致），不写死建筑 id。设计文档新增 1.3。测试默认关闭（`player()` 里设为 0，数值断言不变），新增测试 "resource buildings cost none of their own resource…"。顺带：用户确认行军距离按欧几里得距离（代码本来就是 `Math.hypot`），已写进设计文档 2.4。
- ✅ ④ **美术方向**（仅文档，未实现）：45° 等距视角 + 像素风、不支持旋转；城池页画建筑、地图按同一视角画。写入 `ui.md` 第 5 节和 `gameplay.md` 第 0 节，作为以后的待办。
- ✅ ⑤ **本地存档换地图**：先 `pnpm data:backup`（`.data/backups/2026-09-30T23-06-38-834Z`），`pnpm map:generate --seed wargame` 生成到临时目录，再对 `.data/local` 起 `pnpm dev --port 5190` 执行 `pnpm map:import … --yes`（1024 块全部写入，已有城池先结算）。同时验证了 ① 的清理：启动后 `generators.productionMultiplier` 被自动删除，审计日志有 `config.prune`。

**插件隔离待清理**（用户要求"一个插件只管一个系统"，见 AGENTS.md 架构铁律 3；后续步骤顺带处理）：

- ~~`player-settlements.baseProduction` 写死资源 id~~ ✅ D 已移到 `starter-content`（CSV）。
- ~~`troops` 的兵种定义带 `requires: { building }`~~ ✅ W2 已改为 `addTrainingGate`，由 `starter-army` 接上兵营。
- 按资源 id 配置的规则（如 `troops.deficitPenalty`）可以保留：配置由 GM / 内容填写，代码不写死 id。

> 给接手的开发者或 AI：先读 `AGENTS.md`（约定）和 `README.md`（架构），再读本文件。本文件记录**城池系统**这一步的需求、设计决定、完成情况和下一步。完成后把相关内容并入 README / AGENTS，然后删除本文件。

## 1. 需求（来自用户，原意保留）

### 城池

- 类型：首都（主城）、城池（分城）、要塞。要塞分**资源要塞**（只能建仓库和资源建筑，不能驻军）和**军事要塞**（只能建仓库，可驻军）。
- 首都和分城 = 1 个内城 + N 个外城（N ≥ 1，玩家可动态扩建；上限由科技决定，道具可无视科技新建到另一个更高上限）。
- 外城：只能建资源建筑；栏位**数量随机**，可用道具提升。内城：只能建非资源建筑；栏位固定。内外城**共享同一个资源池和库存上限**。
- 有些建筑只能建在首都，有些只能建在分城。
- 地图网格：要塞占 1 格；首都 / 分城占格数随外城数量增加，默认上限 9 格（不用道具）。
- NPC 城池：要塞（抢兵）、据点（抢粮）等，以后由其他插件实现，城池插件只留接口。
- 地图"伪球形"：x、y ∈ [-511, 512]，两个方向都首尾相接（实际是环面）。

### 用户已拍板的决定

| 问题     | 决定                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 外城布局 | 内城居中，外城逐个占相邻格；第 1–8 座在第一圈（满 3×3），更多（道具）在第二圈（最多 5×5 = 24 座外城）；新外城必须与已有城区相邻 |
| 外城栏位 | **数量**随机（默认 3–6，GM 可调），不区分栏位类型                                                                               |
| 建筑     | 有等级，建造 / 升级**耗时**，有建造队列                                                                                         |
| 首都     | 注册时系统随机分配空地（要求 3×3 全空）                                                                                         |

### 建筑的补充要求

- 升级前先询问（未来的）科技插件是否拦截：`buildings.addGate()`。
- 蓝图：0–20 级之间有若干关键节点受科技控制；科技点满后最高 20 级（常规上限，GM 可按建筑调）；以后用道具**随机突破**，每个建筑实例的上限单独存储（`buildings_slots.cap`），最终无上限：`buildings.raiseCap()`。
- 前 7 级的消耗 / 时间由策划表逐级给出；第 8 级起按第 7 级乘递增系数（`costGrowth`、`timeGrowth`）。
- 其他插件能新增建筑类型（例如"挑战系统"需要先在首都建"擂台"）：`buildings.define()`，查询用 `buildings.level()` / `buildings.highestOwned()`；需要新类别时用 `settlements.allowCategory(kind, districtType, category)`。

### 前端：服务端驱动的表单

服务端插件在命令上声明 `form`（字段、位置 `placement`、`prepare()` 决定是否显示并填充动态选项和默认值）。前端核心插件 `forms` 通用渲染，简单功能不用再单独写前端插件；复杂可视化（地图、城池栏位）仍写 Vue 插件。

### 资源可为负值（**进行中，见第 3 节**）

驻军将来会消耗资源维持。资源可以为**少量负值**，之后触发"逃兵""降级"等事件，例如金属不足时战斗力下降、金币不足时军队溃逃。产出也不能只做加法（要支持百分比加成）。

## 2. 已完成（`pnpm test:run` 57 个测试全部通过；`pnpm typecheck` 通过，包括 Vue）

服务端插件（`src/plugins/`）：

| 插件                 | 内容                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world-map`          | 环面坐标 `wrap` / 距离 / 圈层、`world_map_tiles`（只存被占的格，主键防并发抢地）、跨接缝的窗口查询、随机找空地                                                                                                                                                                                                                                     |
| `stats`              | 数值 = (基础 + Σ固定值) × (1 + Σ百分比/100)；`define` / `contribute` / `get(api, stat, target)`                                                                                                                                                                                                                                                    |
| `timeline`           | 每个实体的定时事件（`timeline_events`），读取前按时间顺序处理；`onAdvance` 时钟监听（资源先结算到事件时刻）；带重入标记防止死锁；视图中只在内存里处理                                                                                                                                                                                              |
| `resources`          | 资源池按持有者（`settlement:<id>`）划分，库存上限为 stat `resources.capacity`，按需结算；`setHolderResolver`（由 settlements 提供：`?settlement=` 必须是自己的，默认首都）                                                                                                                                                                         |
| `settlements`        | 城池类型注册表 `defineKind`（NPC 类型用 `npc: true` 注册）、城区与栏位、`found` / `addOuter` / `outerCandidates`、视图 `settlements.mine` / `settlements.detail` / `settlements.map`、命令及表单（建首都、在地块上建城、建外城、改名，以及 GM 用的"越过科技上限建外城"）、报表 `settlements.list`、新账号自动建首都（`accounts.onAccountCreated`） |
| `buildings`          | 建筑类型、策划表 + 递增系数、常规上限 + 实例突破上限、拦截接口、唯一性、城区类别校验、建造队列（stat `buildings.queue`）、通过时间线完成、产出和 stat 加成、详情视图扩展、报表 `buildings.levels`                                                                                                                                                  |
| `player-settlements` | 四种玩家城池类型；栏位、数量上限、建城费用均 GM 可调                                                                                                                                                                                                                                                                                               |
| `starter-content`    | 资源：食物、木材、石头、金币；建筑：农田、伐木场、采石场、金矿、仓库、宫殿（仅首都，每级科技外城上限 +1）、市政厅（仅分城）、兵营（占位）                                                                                                                                                                                                          |
| `forms`              | 视图 `ui.forms`（参数 `placement` + 上下文），按条件列出可用表单                                                                                                                                                                                                                                                                                   |

内核改动：view 带参数并以"只读演练"方式运行（写入被丢弃）；命令可以带 `form`；`ctx.commands.all()`；共享契约 `src/shared/api.ts` 已加入城池、地图、表单等类型。

前端（`web/`）：核心新增页面（`game.page`）、按需请求视图（`game.need`）、共享参数（`game.setParam`）、`serverNow()`；插件：`forms`（FormOutlet + DynamicForm）、`settlement`（城池切换）、`resource-bar`（按城显示，考虑上限）、`city`（城区标签页 + 栏位卡片 + 建造倒计时）、`world-map`（15×15 窗口、跨接缝、选中空地后显示建城表单）、`gm-panel`（已适配）。已删除 `generators` 和 `forage`。

迁移：`migrations/0007_settlements.sql`（删除旧的 `generators_owned`，重建 `resources_balances`，新建时间线、地图、城池、建筑相关表）。**尚未在本地 `.data/local` 执行**。执行 `pnpm dev`（会自动迁移）即可；旧的测试玩家资源会被清空，建议直接 `pnpm data:reset`。

### 已修复：老账号没有城池导致前端无法启动

- 现象：`Failed to start: You have no settlement yet.`。城池系统上线前创建的账号（包括本地已经存在的 GM 账号）没有首都，`resources.pool` 视图报错，一个视图出错会让整个 `/api/state` 失败。
- 修复：没有城池时，`resources.pool` 返回 `null`（共享契约已改成 `ResourcePool | null`）。页面正常加载，全局表单"Found your capital"出现，点击即可建立首都。
- 回归测试：`test/api.spec.ts` 中的 "loads the state for an account without a settlement…"。
- **约定（待写入 AGENTS）**：view 不能因为"数据还没有"而抛错，要返回 `null` 或空值，因为一个 view 出错会拖垮整个状态请求。只有权限问题（比如看别人的城）才抛 `GameError`。

### 已修复：队列满过一次后前端无法再建造

- 现象：试玩时，建造队列满过一次后，所有建造按钮都变灰。
- 原因：服务端正确（完成后队列会释放），是**前端数据过期**。建造完成时前端没有重新获取数据，旧数据里所有栏位都标着"队列已满"，要等 60 秒一次的轮询才恢复。
- 修复：
  - 前端核心新增 `game.refreshAt(serverTime)`，城市插件在最早完成的建造到点时自动刷新；
  - `game.command` 失败后也会刷新一次。
- 测试：`test/game.spec.ts` 中的 "frees queue places when constructions finish"。
- **约定（待写入 AGENTS）**：前端展示的内容如果会在某个已知时间点变化（建造、行军到达），前端插件要用 `game.refreshAt()` 在那个时间点刷新，不能只依赖轮询。

### 已修复：木材花光后永久卡死，且按钮变灰没有原因

- 现象：木材只剩 40，所有建筑都要 60 以上木材，没有木材产出，而伐木场本身也要木材，玩家永远卡住；按钮变灰也没有任何说明。
- 修复：
  - `player-settlements` 给首都和分城加了**内置基础产出**（config `player-settlements.baseProduction`，默认首都每秒 食物 1 / 木材 1 / 石头 1 / 金币 0.2，分城减半），作为生产方注册到资源插件；
  - 前端建造按钮把买不起的资源数字标红，悬停提示"Need N more X"。
- 测试：`test/game.spec.ts` 中的 "capitals have a small built-in income…"。其余游戏测试在 `player()` 里默认关闭内置产出，保证数值断言只受建筑影响。
- **设计约定（待写入 AGENTS）**：任何"花资源才能产出该资源"的循环，都必须有兜底来源，防止玩家卡死。

### 已完成：建筑显示当前效果和下一级效果

- 服务端 `settlements.detail` 中，`SlotInfo.current.effects` 是当前等级的效果，`BuildOption.effects` 是升级或建成后的效果。两者都用 `{ produces, stats }` 表示，已计入 GM 设置的产量倍数（由 `buildings` 插件的 `effectsAt` 计算）。
- `/api/meta` 新增 `stats`（数值 id 及简短描述），前端用它显示"+2000 storage cap"这样的文字。
- 前端 `SlotCard`：已建成的建筑显示 "Now: …"，升级按钮下显示 "Lv N: …"，建造选项里显示 1 级效果。

## 3. 已完成：资源可为负值与维持消耗

已做：

- ✅ `0007` 中 `resources_balances.amount` 已去掉 `CHECK (amount >= 0)`（该迁移还没在任何地方执行过，所以可以直接改）。
- ✅ **小任务 A：消耗方与产出系数**。新增 `resources.addConsumer()`（返回正数表示每秒消耗）；新 stat `resources.productionFactor`（基础值 1，科技 / 道具通过 `{ percent }` 加成）。**净产率 = Σ生产方 × 系数 − Σ消耗方**，可以为负。新增 `resources.breakdown()`，返回产出、系数、消耗三部分，供显示用。测试："net rate = production x bonus factor - upkeep"。

- ✅ **小任务 B：欠债下限**。新 config `resources.debtLimit`（按资源，默认 0）。负产率时余额最低到 `-debtLimit`，然后停住；正产率时可以从负数长回去（到上限为止）。写回时只把接近 0 的浮点误差归零，允许写入负数。`spend` 仍要求余额足够，所以欠债时买不了东西。同时修复了 GM 命令 `resources.grant` 在余额为负时多加的 bug：原来 +20 会变成 +50。测试："upkeep digs below zero down to the debt limit…"。

- ✅ **小任务 C：耗尽事件**。资源池写回时，先删除这个持有者未来的 `resources.depleted` 事件，再对"净产率 < 0 且余额 > 0"的资源，按公式算出**精确的**归零时刻并登记。事件处理时依次调用 `resources.onDepleted(listener)` 注册的监听者（参数 `{ holder, resource, at }`）。新增 `resources.inDeficit()`。测试："fires a depletion event at the exact moment…"。
  - **语义（待写入 AGENTS）**：时间线事件在"下次用到这座城的资源 / 建筑"时才处理，包括只读视图（此时监听者的写入会被丢弃）。改名这类不读资源的命令不会触发。监听者只能通过 `api.write` 改状态，不能有其他副作用。
  - 需要"没人看也必须按时发生"的效果（例如溃逃的部队在地图上走动），要等以后的定时任务兜底（见第 4 节）。

- ✅ **小任务 D：前端**。`ResourcePool` 新增 `production` / `factor` / `upkeep` / `debtLimit` 四个字段。资源条插值与服务端同一规则（最低到 `-debtLimit`）；负余额和负产率显示为红色；悬停时显示产出、系数、消耗的明细。
- 已知限制：GM 修改规则导致产率变化时，不会重新计算已登记的耗尽时刻，要等该城下一次执行命令。以后可以加定时任务兜底。

### 已完成：取消建造

- 命令 `buildings.cancel`：返还部分费用（config `buildings.cancelRefund`，默认 0.5），并删除建造记录和对应的时间线事件。
- 时间线新增 `timeline.cancelWhere(api, entity, type, match)`：按载荷字段匹配删除未到期的事件（用 `json_extract`），这样其他插件不用直接写时间线的表。
- 前端：建造中的栏位有 "Cancel" 按钮，会先弹出确认。
- 测试："cancels a construction with a partial refund"。

### 已完成：NPC 城池插件骨架（`npc-camps`）

- 注册 `npc-fortress`（可驻军，`extra.loot = 'troops'`）和 `npc-outpost`（`extra.loot = 'food'`），都是 `npc: true`、单格、没有建筑栏位。
- GM 命令 `npc-camps.spawn { kind, count }`：随机找空地生成，在 GM 后台 Players → 任选一个玩家 → 运行命令。
- 地图上 NPC 显示为红色格子 ☠️。战斗和掠夺属于将来的战斗插件，那时读取 `extra.loot`。
- 测试："NPC settlements … spawned by the GM"。

### 已完成：科技（`research` + `starter-research`），迁移 `0008_research.sql`

- 每个玩家的科技等级存在 `research_levels`；同一时间只能研究一项（`research_progress`），由时间线在实体 `player:<id>` 上完成。研究费用由指定的城池支付（命令 `research.start { tech, settlement }`），费用按策划表加递增系数计算，GM 可调 `research.speed`。
- 科技定义：
  - `requires`：前置科技；
  - `unlocks: [{ building, from, perLevel }]`：通过 `buildings.addGate` 拦截对应等级，例如农田 6–10 级需要农业 1、11–15 级需要农业 2、16–20 级需要农业 3；
  - `stats` / `percent`：给玩家的所有城池加数值加成。
- 内容：农业 / 林业 / 石工 / 采矿（分别解锁对应资源建筑及仓库的 6–20 级），行政（外城科技上限 +1/级，**科技上限最高 8**，已把 stat 上限从 24 改为 8），经济（产出 +5%/级）。
- GM 命令 `research.setLevel`（会先结算玩家所有城池的资源）；视图 `research.tree`。
- 测试："research gates building levels…" 和 "takes time and money…"。
- **已知限制**：研究完成是玩家实体上的时间线事件，处理时**不会**把该玩家各城池的资源池结算到完成时刻。所以"经济"科技在完成时刻到下一次结算之间的加成会有少量偏差（`research.setLevel` 已先结算，没有这个问题）。以后如果要精确，可以让时间线支持"一个事件影响多个实体"，或在研究完成时对该玩家所有城池登记一个零效果的结算事件。
- ✅ **前端 Research 页**（`web/plugins/research`）：科技列表（等级、说明、下一级费用和时间、拦截原因、买不起的资源标红），开始研究，进度条，完成时 `refreshAt` 自动刷新。费用由当前选中的城池支付。已在浏览器冒烟测试中验证渲染正常。

### 已完成：道具（`items` + `starter-items`），迁移 `0009_items.sql`

- 背包 `items_inventory`（按玩家）。服务：`define` / `count` / `grant` / `consume`。GM 命令 `items.grant`；视图 `items.inventory`；`/api/meta` 新增 `items`。
- **可使用的道具**：定义里写 `use: { parse, apply, form }`，道具插件自动注册命令 `items.use.<id>`。表单只在拥有该道具时出现，默认放在 **`items`** 位置（Items 页）。使用时扣 1 个，和效果在同一次原子提交里，所以效果失败不会扣掉道具。
- 内容（都在用核心系统预留的接口）：
  - 外城许可 `expansion-permit`：`settlements.addOuter(..., { ignoreTechLimit: true })`；
  - 突破石 `breakthrough-stone`：`buildings.raiseCap`，随机 +1~3，新增 `buildings.capOf`；
  - 土地契 `land-grant`：新增 `settlements.addSlots`，外城 +1 栏位。
- 测试：items 下两个用例。
- ✅ 前端 Items 页（`web/plugins/inventory`）：背包列表，以及可用道具的表单（作用于当前选中的城池）。GM 在 Players 页用 `items.grant` 发放。

### 已完成：部队核心（`troops`），迁移 `0010_troops.sql`

- 兵种定义 `troops.define`（每单位的费用 / 训练时间 / 每秒维持费 / 攻 / 防 / 需要的建筑等级）。内容（在 `starter-content` 里）：民兵（兵营 1 级，维持费食物 0.02/s）、枪兵（兵营 2 级，维持费食物 0.04/s + 金币 0.01/s）。
- 训练：`troops.train { settlement, unit, count }`，每座城同时只能训练一批，由时间线完成；只有 `garrison: true` 的城池类型能训练（资源要塞不行）。
- 驻军维持费作为资源消耗方注册，会拉低净产率，可以触发耗尽事件。`troops.adjust` 会先结算资源池。GM 命令 `troops.grant`；视图 `troops.garrison`（包括可训练兵种及拦截原因）；`/api/meta` 新增 `units`。
- 测试：troops 下两个用例。

✅ **N2：资源不足的后果（逃兵）**。

- `troops` 监听 `resources.onDepleted`：某资源耗尽时，消耗该资源的兵种按 `troops.desertionRate`（默认 0.25）逃散。
- 之后每隔 `troops.deficitInterval` 秒（默认 600）检查一次：只要"净产率仍为负、且余额 ≤ 0"，就再逃一批，否则停止。
- 在时间线里读余额用新接口 `resources.peekAmounts`（不推进资源池）。**约定**：时间线处理函数中不能调用 `resources.amounts`，它会把资源池推进到真实的当前时间。
- 测试："desert when upkeep drains their resource…"：只有金币短缺时，只有枪兵逃散，民兵不受影响；100 → 75 → 56 → 42。
- 未做：用户提到的"金属不足则战斗力下降"。等加入金属资源和战斗时，新增 `troops.power()`，在 `inDeficit(metal)` 时打折。

✅ **N3：Troops 页**（`web/plugins/troops`）：当前城池的驻军（攻 / 防）、维持费、训练进度（完成时 `refreshAt`）。训练用的是 `troops.train` 的服务端表单（placement `troops`），只列出当前能训练的兵种，没有专门的前端表单代码。已在浏览器冒烟测试中验证。

### 已完成：科技改为"透明科技树 + 研究所 + 每城一个研究队列"（R1），迁移 `0011_research_queues.sql`

- 新建筑 **研究所** `institute`（在 `starter-research` 中，civic 类别，每城一座）：每级提供 `research.labs +1`、`research.speed +0.1`。
- 只有 `research.labs ≥ 1` 的城池能研究。**每座城池一个研究队列**（表 `research_queue`，以 settlement 为主键）。**同一玩家的不同城池不能同时研究同一科技**：由 `UNIQUE (player_id, tech)` 保证，并发时也不会重复。
- 研究耗时 = 策划表时间 × 修正系数 ÷ (全局 `research.speed` × 城池 stat `research.speed`)；费用由该城支付。完成事件放在城池的时间线上，完成时先结算该玩家所有城池的资源池。
- 给未来插件的接口：
  - `research.addCostModifier`：英雄作为负责人时节省消耗 / 时间；
  - `research.addGate`：额外的开始条件；
  - `research.grantLevel`：直接授予等级；
  - `research.quote`：报价。
- 视图 `research.tree`（参数 `settlement`）：新增 `all`（该玩家所有城池的研究）和 `speed`。
- 测试："runs in institutes…" 和 "lets other plugins change research costs…"。
- ✅ **R2：运行时注册科技节点**（迁移 `0012_research_nodes.sql`）。接口是 `research.registerNode(api, def, { ownerId })`：节点定义只含数据（id、名称、最大等级、策划表、前置科技、解锁的建筑等级段、固定值 / 百分比加成），经 `parseTechDef` 严格校验后，以 JSON 存入 `research_nodes`。`ownerId` 为 null 表示全局可见，否则只有该玩家可见。`research.techsFor(api, playerId)` 把静态科技和该玩家可见的运行时节点合并，研究、授予、拦截、加成、视图都走它。不同 isolate 读到新节点时会自动补注册数值贡献。GM 命令 `research.registerNode { def, global }`。测试："accepts tech nodes registered at runtime…"。**不透明科技插件的用法**：项目成功时 `registerNode`（通常 ownerId = 该玩家），再 `grantLevel`。
- ✅ **R3：前端 Research 页适配**：显示当前城池的研究速度，没有研究所时给出提示（"每座城池有自己的研究队列"），列出其他城池正在进行的研究，任一城池的研究完成时 `refreshAt`。已在浏览器冒烟测试中验证。

### 已完成：部队战力与英雄 / 资源短缺的接口（P）

- `troops.power(api, settlementId)` 返回 `{ attack, defense, factors }`：先算兵种攻防之和，再乘以各项修正。
- 修正来源：
  - **资源短缺惩罚** config `troops.deficitPenalty`，例如 `{ "iron": 0.7 }`，对应用户说的"金属不足则战斗力下降"。将来加入金属资源后，只需要改配置；
  - **`troops.addPowerModifier`**，给英雄带兵用。
- `troops.garrison` 视图带 `power` 字段，Troops 页显示攻防及每项修正，惩罚项标红。
- 测试："strength counts shortage penalties and plugin modifiers…"。
- 战斗系统将直接使用 `troops.power`。

### 已完成：定时任务与时间线清扫（Q）

- 内核新增扩展点 `ctx.tasks.add({ id, run({ kernel, env, now }) })`。Worker 的 `scheduled` 处理函数（`src/index.ts`）依次运行所有任务，单个任务失败不影响其他任务。`wrangler.jsonc` 新增 `"triggers": { "crons": ["* * * * *"] }`。
- 时间线任务 `timeline.sweep`：每分钟找出有到期事件的实体（最多 `timeline.sweepBatch` 个，默认 200），以其**拥有者**的身份执行内部命令 `timeline.sync`，照常加锁、原子提交。拥有者通过 `timeline.addOwnerResolver(prefix, fn)` 查找：内置 `player`，`settlements` 注册了 `settlement`；没有拥有者的（NPC）以 `npc:<entity>` 加锁。
- 效果：离线玩家的建造、训练、研究、资源耗尽后的逃兵，都会在一分钟内真正落库；GM 报表看到的也是最新数据。
- 测试："the cron sweep processes due events nobody looked at"（`test/engine.spec.ts`）。
- 本地开发时可以访问 `/cdn-cgi/handler/scheduled` 手动触发（Cloudflare 工具链提供）。

### 已完成：行军（S1，`armies`），迁移 `0013_armies.sql`

- 兵种新增 `speed`（格/小时）和 `carry`（每单位能带回的资源量）。
- 命令 `armies.send { from, x, y, units }`：从驻军中扣除部队，按环面最短距离和最慢兵种的速度计算行程（GM 可调 `armies.speed`）。到达、返回是 `army:<id>` 上的时间线事件；`army` 的拥有者解析已注册，离线时由清扫任务处理。
- **到达后发生什么由其他插件决定**：`armies.addEncounter(handler)`，第一个返回战报的处理函数生效；都不处理时记为 "no-battle"。armies 插件负责把战报里攻方的损失、战利品、俘获应用到部队上；守方的变化由处理函数自己完成（先 `api.lock`）。返回时部队回到出发城池的驻军，战利品存入资源池。
- 视图 `armies.list`（在外的部队及战报）。
- 测试："march out at the pace of the slowest unit and come back home"。
- **顺带修复了时间线的"追赶"问题**：事件处理中新登记的、已经到期的事件（比如部队几小时前就该到达，返回时间也已过去），现在会在同一次 `sync` 中按时间顺序接着处理。`schedule` 不再禁止过去的时刻。

**接下来**：

- ✅ S2：打 NPC。
  - `armies` 提供共用的战斗公式 `battle(attack, defense)`：强者胜，战力越接近双方损失越大；以及 `attackOf(units)`。
  - `npc-camps` 注册遭遇处理：守军由 config `npc-camps.defenders` 决定，不会被打残。打赢据点按幸存部队的载量抢食物（先 `api.lock` 据点）；打赢要塞按 `npc-camps.captureRate` 俘获守军；打输则按公式损失。
  - 据点每秒产 0.5 食物慢慢恢复（`player-settlements.baseProduction` 中的 `npc-outpost`）。
  - 新增 GM 命令 `npc-camps.spawnAt`。
  - 测试："can be raided…"。
  - ✅ NPC 营地自动补充：config `npc-camps.population`（按类型设目标数量，默认 0 = 关闭），后台任务 `npc-camps.upkeep` 每分钟最多补 5 个（以 `npc:world` 身份执行 `npc-camps.spawn`）。测试在 `test/engine.spec.ts`。
  - 未做：NPC 被打后的冷却 / 重生。
- ✅ S3：玩家对战（新插件 `pvp`）。遭遇处理先 `api.lock('player:<守方>')`，双方的变化在同一次原子提交里完成。守方防御取 `troops.power(...).defense`（包含英雄修正和资源短缺惩罚）；驻军按公式比例损失（`troops.adjust` 会先结算）；打赢后按幸存部队的载量，从守方资源池按比例掠夺，每种资源最多 `pvp.lootShare`（默认 50%）。攻击自己的城池或 NPC 城池时不处理（交给其他处理函数）。测试："attacks another player…"。
  - ✅ 新手保护：首都建立后 `pvp.protectionHours`（默认 72）小时内不会被攻击，战报为 no-battle，并带 `note: "Under beginner protection"`（新字段 `BattleReport.note`，前端会显示）。测试："does not hurt players under beginner protection"。
  - ✅ 仓库保护：新 stat `pvp.protected`（每种资源受保护的数量，由 pvp 定义），仓库每级 +500；可掠夺量 = (余额 − 保护量) × `lootShare`。
  - ✅ 守方视角（迁移 `0014_pvp_reports.sql`）：视图 `armies.incoming` 显示正朝自己城池行军的敌军（不显示兵力，含到达时间和攻击者）；`pvp` 在战斗的同一次原子提交中写入守方战报 `pvp_reports`，视图 `pvp.defenses` 显示最近 20 条。Armies 页显示"来袭警报"（红框，到达时 `refreshAt`）和"防守战报"。测试断言已加在 PvP 用例里。
  - 未做：驻防时英雄和科技对守方的加成（`troops.addPowerModifier` 已可用）、战报通知守方。
  - 注意（写测试时）：config 覆盖值超出允许范围时会被**静默忽略**。例如 `armies.speed` 最大为 1e6，传 1e9 就会按默认速度行军。
- ✅ S4：行军前端。
  - `armies.send` 带服务端表单（placement `tile`）：在地图上选中任意格子（包括 NPC 和其他玩家的城）就能出兵。出发地是有驻军的城池，每种兵一个数量框。为此表单机制新增 `FormPatch.fields`：`prepare()` 可以追加运行时才知道的字段。表单提交的扁平字段 `units.<id>` 由 `parse` 转成嵌套对象。
  - Armies 页（`web/plugins/armies`）：在外的部队、到达 / 返回倒计时、战报（胜负、攻防、双方损失、战利品、俘获），在下一次到达或返回时 `refreshAt`。
  - 已在浏览器冒烟测试中完整验证：地图选 NPC 据点 → 出兵 → 自动刷新 → 胜利战报与战利品。

### GM 与多语言改版（用户要求，已全部完成）

- ✅ **G1：GM 独立页面 + 按插件分组 + 表单化**。
  - GM 页面（`game.page('gm')`，只有 GM 可见），标签页：玩家 / 规则 / 报表 / 邀请码 / 审计。
  - "玩家"页：选玩家 → 查看摘要（城池、首都资源）→ 该玩家可用的 GM 操作表单，按插件分组。
  - 服务端：所有特权命令都带 `form`（placement `gm`），`prepare()` 用目标玩家的数据填充下拉选项；新路由 `GET /api/gm/forms?player=<id>` 以特权身份、针对目标玩家列出表单；`ResolvedForm.owner` 表示所属插件；提交仍走 `POST /api/gm/players/:id/command`（有审计）。
  - 需要"先选城池、再选目标"的操作用合并的下拉值，由 `parse` 拆开：`settlement|district|slot`、`settlement@x,y`。`research.registerNode` 同时接受 `def` 对象和表单的扁平字段。
  - 前端：`DynamicForm` 新增 `submit` 属性，用来覆盖提交方式；`forms` 服务新增 `Form` 组件。旧的 JSON 命令框（PlayersTab）已删除。
  - 插件分组名的翻译键为 `plugin:<id>`。
  - 测试："serves GM action forms…"。已在浏览器冒烟测试中验证。
- ✅ **G2：结构化规则编辑器**（`web/plugins/gm-panel/ValueEditor.vue`，递归）：数字 / 字符串 / 布尔 / 对象（纯数值的映射可以增删键，键名有资源 id 的提示）/ 数组（增删行，新行复制上一行，用于策划表）。内容 id（资源、建筑、兵种、城池类型）显示为名称，字段名走翻译。规则按插件分组（可折叠），编辑的是生效值，有修改才能保存，可撤销、可恢复默认；非法值由服务端校验，错误以翻译后的提示显示。已在浏览器冒烟测试中验证（修改建造速度、查看建筑策划表）。
- ✅ **GM 玩家页二级菜单**（用户要求）：玩家操作不再一次全部列出，左侧是插件列表（带操作数量），右侧只显示选中插件的表单；窄屏时插件列表横排。
- ✅ **G3：报表**：`ReportInfo.owner` 表示所属插件，下拉框按插件分组（`optgroup`），显示翻译后的描述；参数用同一个 `ValueEditor` 编辑，以报表的 `example` 作为初始值，不写 JSON；列名、内容 id 走翻译。已在浏览器冒烟测试中验证。
- ✅ **I1：多语言接口**（`web/core/i18n.ts`）。`game.t(text, vars?)`、`game.messages(locale, dict)`、`game.locale` / `game.setLocale()`（存在 localStorage，默认 zh-CN）。按原文查找（gettext 风格）；词典的键可以带 `{0}` 占位，用来匹配服务端拼接的句子，例如 `Requires {0} {1}` → `需要{0} {1}级`，捕获到的值也会再翻译一次。各前端插件在 setup 中注册自己界面文字的中文；服务端返回的名称、表单文字、拦截原因、错误提示集中放在 `web/plugins/locale-zh`（清单中第一个插件，保证登录页也是中文）。`toast` 也会自动翻译。
  - ✅ 服务端拼接的文字已翻译：在 `locale-zh` 中加入组合句型（`{0} ({1}, {2})`、`{0} (Lv {1})`、`{0} ({1}) — {2}`、`{0} food` 等，以及递归拆分的列表句型 `{0}, {1}`）。**句型的顺序有影响**：更具体的放在列表句型前面。已在浏览器中验证费用说明、下拉选项等处。
  - **注意词条冲突**：按原文查找时，同一个英文词在全局只能对应一个中文。例如城池类型 "City" 是"分城"，所以城市页的导航标签原文改成了 "Overview"。给新界面文字选原文时要避开已有的内容名称。
  - 加一门新语言：新建类似 `locale-zh` 的插件，并给各插件补对应语言的词典；再在界面上加一个调用 `game.setLocale` 的切换器。

## 长期规划（用户提出，先预留接口，暂不实现）

- **不透明科技 / 基金委**：在首都注册"基金委"建筑（`buildings.define({ kinds: ['capital'], unique: true })`）。点开后可以筛选要资助的**项目**；项目**随机生成**，可能成功也可能失败。每个项目无论成败都会积累"科技树隐藏点数"，提升以后项目的成功率。成功的项目通过 `research.registerNode` 生成科技树之外的新节点，并通过 `research.grantLevel` 授予等级。项目、点数、概率都由不透明科技插件自己的表来管。
- **英雄系统**：
  - **带兵**：为部队提供加成。防守方用 `troops.addPowerModifier` ✅，进攻方用 `armies.addAttackModifier` ✅（战斗处理函数统一调用 `armies.attack(api, encounter)`，修正来源写入战报的 `attackFactors`）；
  - **冒险**：升级、获得装备和道具（可调用 `items.grant`）；
  - **城池太守**：为城池提供加成（`stats.contribute`，目标为 `settlement:<id>`）；
  - **研究**：作为负责人为透明科技树节省资源（`research.addCostModifier`），并以"负责人"身份提出不透明科技树的项目。

  英雄的任命关系（英雄 ↔ 城池 / 部队 / 研究）由英雄插件自己的表管理；其他系统只通过上述接口接收加成，不需要知道英雄的存在。

## 4. 之后的步骤

1. ~~完成第 3 节~~ ✅
2. ✅ **浏览器冒烟测试已通过**（用独立数据目录，没有动 `.data/local`）。验证了：
   - GM 登录后进入城市页；
   - 在外城建伐木场，倒计时结束后**自动刷新**，显示 Lv1 和当前 / 下一级效果；
   - 资源条显示基础产出加建筑产出；
   - 用表单建第二座外城；
   - 地图页显示自己的 3 格，选中空地后出现建城表单；
   - 控制台无报错。

   复现方法：`vite.config.ts` 支持 `WARGAME_DATA_DIR` 环境变量。先 `pnpm exec wrangler d1 migrations apply DB --local --persist-to <dir>`，再 `pnpm build && WARGAME_DATA_DIR=<dir> pnpm exec vite preview --port 4199`，然后用 Playwright 操作（借用 `~/code/knowmap` 的 `@playwright/test`，脚本放在 knowmap 目录下运行）。

3. 更新文档：
   - ✅ README 已更新（快速开始、目录结构、扩展点表、新增 6.4"城池系统"，包括科技和 NPC）。原计划：README 第 6 节加入城池系统、时间线、数值加成、表单机制，以及新的扩展点表；
   - ✅ AGENTS 已加入"游戏系统约定"一节，交接文档里所有"待写入 AGENTS"的条目都已写入。原计划的约定：
     - 需要时间的机制一律走时间线；
     - 改变产率或上限前要先结算；
     - 简单功能优先用表单；
     - 新建筑类型、新城池类型的注册方式；
     - 拦截接口和突破接口的用法；
     - 维持消耗与耗尽事件的用法。
4. 后续大块功能（尚未开始）：
   - 部队：核心、逃兵、前端都已完成；战斗力随资源短缺下降要等战斗系统；
   - 行军（跨玩家时调用 `api.lock('player:<对方>')`；"没人看也要按时发生"所需的定时清扫 ✅ 已具备）；
   - 战斗；
   - 科技插件（用 `buildings.addGate` 拦截升级，用 `stats.contribute` 提供加成）；
   - ~~道具插件~~ ✅ 服务端和前端都已完成；
   - ~~NPC 城池插件~~ ✅ 骨架已完成（`npc-camps`），缺战斗与掠夺。

## 5. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、78 个测试）。
- 所有改动已 `git add`，但**未提交**（用户未要求提交）。
- 本地数据 `.data/local` 里是用户自己的试玩数据，不要擅自清除。本会话的冒烟测试都用 `WARGAME_DATA_DIR` 指向的临时目录。
- 数据库迁移已到 `0022_heroes.sql`。用户本地下次 `pnpm dev` 时会自动执行新的迁移（`0011` 会删除旧的研究进度表，`0013` 新建行军表）。
