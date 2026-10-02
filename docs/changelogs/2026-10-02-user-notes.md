# 2026-10-02：处理用户留言（续）

接 `2026-10-01-user-notes.md`，编号沿用。

- 用户确认颜色："白色到紫色 5 种稀有度，其中，紫色稀有度最高，金色放在紫色前面。即白->绿->蓝->金->紫"。第七批留言（饰品一行、军事加成合并、英雄军事数值、招募令）转进 HANDOFF 待办 P5b。
- ✅ 63 **装备大改（P5）**（用户原话见当时 HANDOFF 的 P5：七套常规装备、错开等级与秘境、饰品栏位、五色稀有度、白色在秘境商店买、掉率合并显示、饰品必加魅力、拆解）→ gameplay.md 10.2–10.5。
  - `equipment`：部位可以有组（`SlotDef.group`，饰品），每名英雄每组的上限由内容决定（`setGroupLimit`）；底子新增 `minLevel`、`set`；穿戴时检查组上限和等级；视图 `EquipmentPiece.minLevel / set`、`EquipmentBag.groups`；meta 的部位带 `icon / group`。
  - `starter-equipment` 换掉了全部数据：`slots.csv`（五个常规部位 + 十二种饰品，部位基础数值）、`sets.csv`（七套常规 + 四套饰品，倍率）、`pieces.csv`（35 件常规装备，各自的最低等级与掉落秘境区间，同套互相错开）、`rarities.csv`（白 / 绿 / 蓝 / 金 / 紫，倍率、六维点数、秘境 1 与 10 的权重、饰品不出白色）、`accessories.csv`（女性英雄的饰品数按天赋总额：4 → 1 … 9 → 10）、`rules.csv`（掉落权重、拆解、商店价格）；删掉 `bases.csv`。掉落改为每"套装 × 颜色"一项（列表合并显示，如"金色青锋套装"），饰品每颜色一项（显示"饰品"）；饰品第一点六维必在魅力。拆解返还金属 / 木 / 石 / 货币。新视图 `starter-equipment.shop` + 命令 `starter-equipment.buy`（秘境商店：已开启秘境会掉的白色件，200 × 套装倍率货币）。
  - 前端：装备块的常规部位照旧，饰品画成一行格子（数量 = 这名英雄的饰品上限，点已戴的卸下）；存放处显示套装与最低等级（不够时标红、不能穿），"熔炼"改名"拆解"；秘境页左栏"秘境商店"；新增五个稀有度颜色 token（浅色 / 深色）；58 个装备名、套装名的中文。
  - 测试：原装备测试换成新底子与颜色；新增 "sets: minimum levels, accessories only for women…, the realm shop sells white pieces"（商店只卖已开启秘境的件、白色没有六维、等级门槛、男性不能戴饰品、女性按天赋可戴）、"accessories drop in colour (never white) and always give some charm"。秘境测试改为检查"金色青锋套装"是罕见、第 1 秘境不出紫色。浏览器冒烟：新存档里秘境商店列出青锋套装五件，女性英雄饰品栏 7 格，买到的青锋剑可拆解为 ⛓️30 🪵12 🪨12 🪙6，控制台无报错。
- ✅ 64 **"军事加成"合并显示**（用户原话："带兵和守城的加成数值是一样的，合并显示成：'军事加成'"）英雄卡上带兵、守城两行相同时合并为"军事加成"一行（数值不同时仍分开显示，以防以后某个插件只加其中之一）。浏览器冒烟通过。另：留言"饰品不要分那么多行，放在一行，列数跟着英雄上限走"已随装备大改完成（63）。
- ✅ 65 **英雄军事数值调高**（用户原话："军事基本数值算法调高一点，一个普通英雄至少相当于1~200个1级部队，到大后期（英雄等级80~90、装备拉满）应该相当于200~500个6级兵……一个普通英雄刚招募时相当于10%左右，大后期要能拉到100%左右，一个稀有的英雄……大后期……应该能到300~500%左右。"）→ gameplay.md 5.2（含算账表）。
  - `starter-heroes`：带兵 / 守城的攻击、防御、生命百分比改为 属性 × 0.125% × 等级^0.21（伤亡仍 × 0.2%）；每路固定值改为 属性 × 2.5 / 2.5 / 6 × 等级^0.75。新规则字段 `effect.battlePerPoint / battleLevelPower / flatLevelPower`（`data/rules.csv`）。英雄职务加成视图（英雄卡）用同一套公式。
  - `heroes`：等级上限 60 → 90。`starter-equipment`：部位的每路攻防基础值调高（兵器 / 甲 100、佩 50、饰品 30）。
  - 测试：原有断言改为新系数；新增 "grow into an army of their own…"（刚招募 5–15%，升到 80 级以上、自由点全加武力后 100–250%）。
- ✅ 66 **招募令**（用户原话："管招募上限的插件也可以开始做了。就叫xxx招募令。二级兵 每个道具+1000上限，三级和四级兵每个道具100上限.训练任务下达后，取消/阵亡都不返还。"）→ gameplay.md 2.5。新内容插件 `starter-levies`（迁移 `0039_starter_levies.sql`，表 `starter_levies_quota`）：用 `troops.addTrainingRequirement` 要求 2–4 级兵每个 1 点额度、下达训练时扣除（不返还）；按 `troops.list()` 的兵种系列 + 等级为每种 2–4 级兵生成道具 `levy-<兵种>`（"乡勇（步兵）招募令"等 9 种，+1,000 / +100），类别"招募令"，快捷按钮挂在训练它的兵营入口，表单显示现有额度；上架聚宝阁（30 / 60 / 120 元宝）、加进秘境掉落；GM 命令 `starter-levies.grant`。数据 `data/levies.csv`。测试 "levy orders…"（1 级不要额度、没有额度被拒、用一个 +1,000 后能练、3 级 +100 后 101 个被拒、商城价格）；原"训练需求"测试补发额度，掉落测试把招募令权重置零。浏览器冒烟：步兵营入口出现三种步兵招募令，展开显示说明与"现有额度：0"，控制台无报错。
- ✅ 67 **分城上限**（用户原话："分城数量上限有设置吗？我看gameplay里没写。最初0各分城，科技树设置3个重要节点，各+1上限。声望设置5个重要节点，各加一上限。然后设计道具可以有机会+1上限。道具加的上限越多，成功率越低。最多不超过20."）→ gameplay.md 7.1、8.2、11.2。
  - `settlements`：城池类型可以有硬上限 `SettlementKind.limitMax`；新服务 `limitOf(api, ownerId, kind)` → `{ have, limit, max }`（加成后再套硬上限），`foundable` 改用它。
  - `player-settlements`：`limits.city` 默认 2 → 0；新 GM 规则 `player-settlements.limitMax`（分城 20）。
  - `starter-research`：三项 1 级的内政科技，各给分城上限 +1：实边（二阶，需郡县 1）、分道（三阶，需实边、郡县 3）、行省（四阶，需分道、漕运 3）。
  - `starter-items`：新道具"筑城诏书"（`city-charter`）：有望 +1（base 0.5、rate 0.3、保底 4），记在 `starter_items_stats`，到硬上限后拒绝使用、不消耗；聚宝阁 500 元宝、每天限购 1 张，秘境 8–10 掉落。
  - 声望的五个节点还没做，等声望系统（待办 P6）。
  - 测试：默认测试玩家给 2 个分城上限（老测试要建分城）；新增 "cities start at none…"。浏览器冒烟：道具页的筑城诏书显示"分城指标 1/20 · 成功率 50% · 保底 0/4（拥有 1 个）"（GM 视角），科技树里有三项新科技，控制台无报错。
- ✅ 68 **要塞上限**（用户原话："然后资源和军事要塞默认都是0， 要随着科技慢慢解锁到各20个。前10个可以插入到其他科技的关键等级节点上，剩下的10个放在后期的单一科技，每升一级+1个（要相对比较贵）。资源和军事要塞的上限不要绑定。然后道具也可以随机判定+1级，无上限。首个道具增加的概率定在50%，指数衰减，第10个道具+1概率定在1%。"）→ gameplay.md 7.1、8.2、8.3、11.2。
  - `starter-research`：科技效果新增"里程碑"（`effects.csv` 的 `atLevel` 列，GM 规则里同名字段）：到那一级时一次性给 `value`。`research` 的 `TechEffect.atLevel`（`src/shared/api.ts` 同步），科技卡片显示"+1（N 级时）"。
  - 两类要塞的上限默认 3 → 0；各 10 个里程碑（资源：农桑 3、山林 3、营造 3、水利 5/10、仓廪 5/10、度支 5/10、天工 3；军事：营制 3、弓弩 3、马政 3、兵法 5/10、甲胄 10、阵法 5、城防 3、保甲 3、教阅 10），外加四阶 10 级科技"皇庄""节度使"每级 +1（新费用表 `estates` / `commands`）。保甲原来每级 +1 军事要塞，改为 3 级里程碑。
  - `starter-items`：新道具"资源要塞许可""军事要塞许可"，没有上限，成功率 0.5 × e^(−0.435n)（第 1 次 50%、第 10 次 1%），保底 5；聚宝阁 300 元宝、每天各限 1 张，秘境 5–10 掉落。三种许可共用一段代码。
  - 测试：新增 "fortresses start at none too…"（里程碑只在那一级起算、后期科技每级 +1、两类分开、许可无上限）；科技树测试的数量与兵法卡片效果更新。
- 🐞 修正：`starter-equipment` 的掉落权重读的是 CSV 默认值，GM 改 `starter-equipment.rules` 的 `drop.weight / drop.accessory` 不生效。`realms` 的掉落权重函数现在多一个 `api` 参数，`starter-equipment` 按规则取值。装备掉落测试因此偶发失败（饰品套装混进来），已在测试里把饰品权重设为 0。
- ✅ 69 **保底按成功率**（用户原话："保底机制要改，要按设计的预期概率置保底数（向上取整）。如果1%，就是每100次必出一个。筑城诏书目前的概率可以。"）→ gameplay.md 11.2。`starter-items`：保底次数 = ⌈1 / 当前成功率⌉，连续尝试到第这么多次必成（原来是"连败 pity 次后下一次必成"）；`chances.csv` 的 `pity` 列全部改为 0（= 按成功率），GM 仍可以给单个道具写固定值。表单显示"保底 已失败/保底次数"。测试相应调整（固定保底 3：失败 2 次、第 3 次必成；50% 时显示 0/2）。
- ✅ 70 **GM 规则编辑器的 i18n**（用户报告：规则里的字段名没有中文；"＋"添加时的候选恒为资源名）。
  - 字段名：`gm-panel/rules-zh.ts` 新增 `fieldsZh`（约 110 个规则字段，注册为 `field:<名>`）；内容 id（资源、建筑、兵种、城池类型、地形、道具、科技、秘境、兵种系列、英雄属性 / 职务 / 招募地点、装备部位 / 颜色）显示为名称。`research` 新 meta `techs`（`Meta.techs`）。同名 id 以先列出的为准（资源 gold 优先于金色）。
  - 候选项：原因是 datalist 的 id 只按嵌套深度取，同深度的输入框共用第一个列表（资源）；现在每个编辑器实例用 `useId()`。候选按"这里和同级位置（其他等级、其他类型）已有的键"推断：都属于某一类内容就列那类，否则列同级出现过的键（例如每路兵数列出 1–6）；什么都没有时列资源。
  - 浏览器冒烟：npc-camps.levels 的字段显示"寨栅 / 每路兵数 / 可抢 / 资源偏置 / 守将人数"，每路兵数的候选是 2–6，资源规则显示"货币"，控制台无报错。
- ✅ 71 **装备名用颜色显示**（用户原话："显示装备名的时候，就不要写'白色 青锋剑'这样了，直接用对应颜色的字体渲染，如果颜色导致背景看不清，可以给对应文字加背景。"）→ gameplay.md 10.3。`web/styles.css` 新全局样式 `.rarity` + `.rarity-<颜色>`（颜色字 + 14% 同色底）；装备块、秘境商店、秘境页的可能掉落、冒险报告都改用它，不再写颜色名（装备详情行去掉了"· 白色"）。`realms` 前端的 "Cleared: {rewards}" 改成 "Cleared:" + 列表。浏览器冒烟通过。
- ✅ 72 **招募令按任务错开掉落**（用户原话："顺带调一下招募令的概率。让骑兵的招募更不容易掉落。第一个秘境，第1-2个任务只掉落步兵，第3个任务只掉落弓兵，第4个掉落步兵和弓兵，第5个只掉落骑兵。类似这样，把招募令的刷取任务错开。"）→ gameplay.md 2.5。`starter-levies` 新数据 `tasks.csv`（第 1 个秘境各任务掉哪些系列；第 N 个整体后移 N − 1）、`families.csv`（骑兵权重 × 0.4）。测试：第 1 个秘境第 5 个任务的可能掉落里只有骑兵招募令。
- 🐞 修正：`realms` 的掉落权重函数多了 `api` 参数（见 68 下的修正）；`starter-equipment` 的饰品掉落测试不再偶发失败。
- ✅ 73 **元宝只用整数**（用户原话："确认一下。元宝是拿定点数/整数存的吧？资源有点浮点误差没问题，元宝可不能有。"）→ gameplay.md 11.1。核对结果：元宝一直按整数写（GM 发放 `Math.trunc`、规则里的价格 `Math.floor`、数量必须是整数），但有两个缺口：SQLite 的 INTEGER 列会把 2.5 存成小数，`shop.defineOffer` 不检查内容给的价格。现在：`defineOffer` 要求价格是非负整数；迁移 `0040_shop_integer_coupons.sql` 加触发器，`shop_wallets.balance`、`shop_purchases.price / quantity` 不是整数就拒绝写入。测试：发放 0.7 元宝余额不变；直接写 100.5 被数据库拒绝；余额的存储类型是 integer。
- 📝 74 **声望与流寇的设计稿** → gameplay.md 第 12 节（原第 12 节"与现有实现的差异"顺延为第 13 节）。声望的获得 / 失去、30 级称号与五个分城节点、流寇的出现间隔（基础 8 小时，按近期声望增速缩短，2–12 小时）、新手保护、按地形抽类型、等级与带队英雄、战斗结果、插件划分。标【待确认】的五点等用户拍板后再实现。
- 📝 设计定稿：声望与流寇（用户 2026-10-02 对第 12 节的拍板：损失 = 被抢资源 + 阵亡部队按现在等级的原价训练费用；官职只升不降、声望和官职都显示；新手保护 2 小时；首都更容易被挑中；流寇掉落池接口；间隔普通 4 小时、最快 20 分钟、最长 8 小时；新资源要塞 24 小时内不被挑中；到达时间按斥候等级 3 分钟–1 小时）→ gameplay.md 第 12 节。
- ✅ 75 **声望第 1 步：资源的花费与返还通知**（gameplay.md 12.5）。`resources.spend` 新增用途参数（`spend` / `upkeep` / `transfer` / `loss`），新钩子 `onSpent`、`onRefunded`，新方法 `refund`（返还并通知）、`refunded`（只通知）。调用方：建筑取消改用 `refund`；行军出发分成维持（upkeep）、辎重（transfer）、任务费用（spend）三笔（先一次检查够不够）；筑城失败把费用带回时通知 `refunded`；被掠夺用 `loss`。训练的原价费用直接用 `troops.stats().cost`（训练修改器只影响时间，5、6 级也有公式值），不需要新接口。
- ✅ 76 **声望第 2 步：声望与官职**（gameplay.md 12.1）。新系统插件 `prestige`（迁移 `0041_prestige.sql`，表 `prestige_players`：当前、最高、近期（按 `recentHours` 指数衰减的累计）；`defineRanks` / `defineRanksFromCsv`（name, threshold, stats），官职按最高声望、只升不降，官职的 stat 加成按已达到的官职累加；`add` / `get` / `rank` / `rankAt`；监听花费与返还；视图 `prestige.status`；GM 命令 `prestige.grant`；报表 `prestige.players`；规则 `prestige.rules`）。新内容插件 `starter-prestige`（30 个官职，门槛 50 ×（n − 1）^2.5，第 6、12、18、24、30 级各给分城上限 +1）。前端插件 `prestige`：用户名旁显示"县令 · 声望 2,795"，悬停显示下一官职与历史最高；30 个官职的中文。测试：花费累计与取消扣回、官职只升不降与分城上限（0 → 1 → 扣声望后仍为 1 → 最高官职 5）、GM 才能发。浏览器冒烟通过。
- ✅ 77 **声望第 3–5 步：流寇**（gameplay.md 12.2–12.4；用户补充："新建的资源要塞，24小时内不会被挑中。""可以按斥候等级增加流寇的行军时间……最低3分钟，最高不超过1小时。"）。
  - 扩展点：`armies.addIncoming`（非行军的来袭也进来袭警报，斥候情报照常）；`pvp.raid`（把"攻打玩家城池"抽成服务：守军应战、伤亡、晋升、掠夺、守方战报、`onDefense`；`after` 回调给出奖励和声望变化，写进同一份战报）；`BattleReport` 新字段 `attacker`（非玩家攻方的名字、等级）、`rewards`、`prestige`；`DefenseListener.attackerId` 可为 null；`terrain.mix(tile)`（所在地形分片的各地形格数）。
  - 新系统插件 `bandits`（迁移 `0042_bandits.sql`：`bandits_players` 下一次时间、`bandits_raids` 在路上的流寇）：每个玩家一条时间线 `bandits:<玩家>`（owner resolver），在建城或下一次花费时启动；间隔 = 4 小时 ÷（1 + 20 × 近期声望 ÷ max(声望, 100)）× 0.5–1.5，截到 [20 分钟, 8 小时]；建都 2 小时内、声望 < 50 不来；目标按库存加权（内容可改），同一座城同时只有一股；类型按 `terrain.mix` 抽地形再找对应类型；等级 = ⌈当前声望对应的官职序号 ÷ 3⌉ ± 1；头目有名有姓（`heroes.randomName`），作为整支流寇的修改器；到达时间按 `armies.scouting`：0 / 1 / 2 / 3 级 = 3 / 15 / 30 / 60 分钟；到达时 `pvp.raid`，流寇赢扣声望（被抢资源 + 守军阵亡的原价训练费用）× 0.5 ÷ 1,000，输了加声望（流寇阵亡的原价训练费用）× 0.3 ÷ 1,000 并抽掉落池；GM 命令 `bandits.spawn`、报表 `bandits.raids`、规则 `bandits.rules`。
  - 新内容插件 `starter-bandits`：六种流寇（山林盗、山贼、马贼、水寇、响马、矿匪）、1–10 级、首都权重 ×3、新资源要塞 24 小时内不被挑中、资源掉落（规则 `starter-bandits.rules`）。`starter-levies` 往掉落池放招募令（`data/bandits.csv`）。
  - 前端：来袭警报和守方战报显示流寇名（中文）、等级（"马贼（3 级）"）、声望变化、缴获；战报里的"流寇头目：××"。GM 规则与字段的中文。
  - 测试：开局保护与声望门槛、有声望后按间隔出现、近期声望让下一次提前（不早于 20 分钟）；空城被劫：掠夺、按被抢量扣声望、战报带攻方名字与等级；守军击退：加声望、掉落一件；斥候 2 级时 30 分钟到达且带情报。浏览器冒烟：GM 派出 → 军队页"马贼 将在 2m 59s 后攻击 首都"→ 到达后邮件"首都遭到马贼劫掠"，战报含"马贼（3 级）"、被掠夺、"声望 -24.15"、分路战况，控制台无报错。
  - 暂按：流寇不在地图上显示、不能被拦截；新手保护只看首都的建立时间（以前注册、早已过了 2 小时的玩家会在下一次花费后开始被流寇光顾）。
- ✅ 78 **训练计划**（用户原话："每座城池同一时间只能训练一批（所有兵营共用）。 这个规则改一下……每座城池各兵营分开算。然后同时只能训练一批，但可以无限叠加'训练计划'，一批训练完自动训下一批。加入计划时扣除资源。（作为一种保护资源的手段。敌人来的时候交训练计划，敌人走了取消返还资源）。"）→ gameplay.md 2.5。
  - `troops`：迁移 `0043_troops_queue.sql`（新表 `troops_queue`：每座城池、每种兵营（`line` = 兵种的 `trainedAt`）一条队列，`cost` 记下所付；旧表 `troops_training` 里正在训练的那一批搬过来，id 用城池 id，旧的"训练完成"事件（只带城池 id）照样能找到它）。加入时扣资源和招募令额度；同一兵营没有在训的就立即开始，否则排队；完成时自动开始同一兵营的下一个计划，训练时间在开始时计算。新命令 `troops.cancel`（只能取消还没开始的计划，经 `resources.refund` 全额返还，声望随之扣回）。`speedUp`（加速道具）作用于这座城里最快完成的那一批。`GarrisonInfo.training` 改为 `TrainingBatch[]`（`src/shared/api.ts`）。训练表单在兵营忙时提示"将排在当前训练之后"。
  - 前端：兵营入口显示这座兵营在训的一批（进度条）和排队的计划（各带"取消（返还资源）"）；军队页列出各城所有在训的批次和排队数；到点刷新按所有批次。
  - 测试：新增 "queue training plans per barracks…"（同一兵营排队、不同兵营并行、取消返还与声望扣回、在训的不能取消、完成后下一批在那一刻自动开始）；原有测试改为队列形式。浏览器冒烟：步兵营入口连下 3 批 → 1 批在训 + 2 个计划，取消一个后剩 1 个，控制台无报错。
  - 招募令额度在加入计划时扣，取消不返还（用户确认："不退。"）。
- ✅ 79 **GM 以玩家身份游玩**（用户原话："GM页面新增'以其身份游玩'功能，将GM账户的登录状态改为该玩家的登录状态，重新回到GM界面需要退出登录后再重登。"）→ ui.md 4。`accounts` 新方法 `switchSession(request, env, userId)`（删掉当前会话，给该玩家开一个普通会话，永不带 GM 权限）；`gm` 新路由 `POST /api/gm/players/:id/play`（第一行 `requireGM`；GM 账户本身不能选；写审计 `player.play`；返回 Set-Cookie）。前端 GM 后台"玩家"页的"以其身份游玩"按钮（确认后跳回游戏页）。身份仍只来自 `accounts`，GM 权限仍只看密钥。测试（api.spec）：未登录 401、普通玩家 403、不存在 404；切换后 `/api/auth/me` 是该玩家且 `gm: false`、GM 路由 403、能正常取状态；重新用 GM 登录后审计里有这一条。浏览器冒烟：确认对话框 → 顶部变成该玩家（官职、声望）、没有 GM 徽章，控制台无报错。
- 📝 80 **前端插件整合：盘点与设计稿**（用户原话："你现在帮我盘一下前端插件数，看能不能尽可能把所有前端插件合并成一个，然后后端插件想前端插件注册显示方式和位置。前端插件把控件尽可能抽象出来以便复用"）→ `docs/design/architecture.md` 第 3 节：21 个前端插件、约 7,500 行的逐个归类；目标是后端 `ctx.ui` 声明页面 / 区块 / 邮件渲染器，前端只剩外壳 + 通用控件（cards / timers / rows / badge / report / forms）+ 6 个专用控件 + GM 后台；文案下沉到各后端插件；分 4 步迁移。等用户确认 3.5 的三点。
- ✅ 81 **插件开发指南**（用户原话："规划一个开发文档，如果第三方想开发新的插件，能快速上手"）。新文档 `docs/plugin-guide.md`（五分钟上手、基本概念、插件骨架与 `ctx` 扩展点、引擎 api、数据与规则、常见做法菜谱、前端、测试、提交前检查）；可运行的示例插件 `examples/watchtower/`（箭楼：建筑 CSV + 规则 + 战斗修改器），`test/game.spec.ts` 的 "example plugin (watchtower)" 把它装进内核、派流寇来打、检查战报里的加成，保证示例不过时。`docs/plugin_architecture_reference.md` 按代码重写为插件清单（另一个 AI 的版本有多处与代码不符：插件数、层级重复、示例里不存在的 API）；README 第 5、7 节链接过去。
- ✅ 82 **训练加速令对兵营使用**（用户原话："'枢密院檄：速练新卒，本城训练提前 15 分钟。' 改成对城池里的特定兵营使用，而非城池使用。"）→ gameplay.md 2.5、11.2。`troops.speedUp` 新增可选参数 `line`（兵营类型），新方法 `troops.queue`；`starter-items` 的训练加速令单独定义：表单多一个"兵营"选择（只列正在训练的兵营，从兵营入口打开时默认选这座），文案改为"所选兵营的训练提前……"，三种加速令在四座兵营入口有快捷按钮。测试：对没在训练的兵营使用被拒且道具保留，对训练中的兵营减 1 小时。浏览器冒烟：步兵营入口 → 练兵札子 → 兵营默认"步兵营"，控制台无报错。
- 📝 前端整合的方向定稿（用户 2026-10-02）："前端插件可以尽可能收集更多的空间，供后端插件声明……比如地图插件，第三方可以引入一个'异世界'副本，在一个更小的网格上"；"同意"（文案下沉）；"按前两步 -> 清数据库 -> 后两步来做"；"如果第三方认为以上都表达不了的时候，可以开发自己的前端插件。在不改变官方代码的情况下进行扩展。" → architecture.md 第 3 节：可视化也做成通用控件（`grid` / `cells` / `tree` / `lanes`）；前端插件机制保留为对外扩展点，第三方放进 `extensions/` 自动发现。
- ✅ 83 **前端整合第 2 步：布局由后端声明**（architecture.md 3.4）。新系统插件 `ui`（服务 `ui.page / block / entry / band / slot / mail / dynamic`，meta `ui`，`src/shared/api.ts` 的 `UiLayout`）；前端核心新增 `game.widget / widgetOf / slot`，所有插件装配完后按 meta 摆放（缺的组件跳过）。19 个前端插件的 `game.page / block / entryBlock / band` 全部改成 `game.widget('<插件>.<名字>', …)`，位置搬到拥有数据的后端插件（accounts、settlements、forms、gm、armies、heroes、mail、prestige、equipment、starter-equipment、resources、research、items（快捷入口用 `dynamic`）、troops、war-reports、starter-siege、realms、shop、world-map，都加了 `dependsOn: 'ui'`）；`auth.addUserAction` → 插槽 `user-actions`，`heroes.cardSection` → 插槽 `hero-card`，`mail.renderer` → `ui.mail`（这三个前端服务方法删除）。ui.md 第 3 节、README、开发指南、AGENTS.md 同步。浏览器冒烟：标签顺序、每页的左右栏、步兵营入口（训练、表单、道具快捷）、用户名旁的官职与 GM 徽章、英雄卡上的冒险区块、邮件战报、地图、GM 后台都与改前一致，控制台无报错。
- ✅ 84 **前端整合第 1 步：文案下沉到后端插件**（用户："同意"）。新系统插件 `i18n`（`i18n.add / addCsv`，同一键在两个插件里译文不同时装配报错；meta `i18n`），前端启动时先加载它，前端插件的 `game.messages` 只放自己界面的文字。`locale-zh` 里 628 条按"英文原文出现在哪个后端插件的代码 / CSV 里"自动归属（另按规则补上前端拼出来的键：`effect:*`、`research-tier:*` → starter-research，兵种名 → starter-army，稀有度 → starter-equipment……），搬进 36 个插件的 `data/i18n.csv`；GM 规则说明（`rule:<key>`）和插件名（`plugin:<id>`）也搬到各自插件。前端只剩外壳的 9 条、内核规则的 1 条、GM 规则编辑器的字段名表和 3 个非插件名。i18n 引擎改为按固定文字长度排序带占位符的键（越具体越先匹配），不再依赖登记顺序。测试：meta 带中文与规则说明、带布局声明。浏览器冒烟：所有页面、兵营 / 研究所 / 城墙 / 酒馆入口、GM 规则页都没有漏翻的英文，控制台无报错。AGENTS.md、开发指南同步。
- 📝 85 **文档整理**（用户："都完成之后再做一下文档整理。保持所有文档干净、一致。"）：HANDOFF 重写为只有当前状态与两项待办（M1、前端整合第 3–5 步）；README 第 5 节不再罗列插件（指向插件清单），第 6 节补上训练队列、声望与流寇、文案下沉、以玩家身份游玩、`ctx.tasks`，第 7 节的示例改为指向开发指南与 `examples/watchtower`（原"声望"示例与真实插件撞名），"局域网访问"挪回第 2 节；architecture.md 删掉已实现的 1.2–1.4，更新邮件、NPC、流寇、`pvp_reports` 的说明和第 3 节的进度；ui.md 第 4 节补上训练计划、官职与声望、秘境页；插件清单补上 `ui`、`i18n`；本日的 changelog 从 `2026-10-01-user-notes.md` 拆出到本文件。
- ✅ 86 **M1 全新存档**（"上述开发完成之后，清理一次数据，即换一个全新的存档供我试玩。"；用户："授权你直接清理。"）：`pnpm data:backup before-m1` → `pnpm data:reset`（迁移到 `0043`）→ `pnpm map:generate --seed wargame`（地形比例与目标相符，公平性：最差的区块离均值 9%）→ 启动 `pnpm dev`、`pnpm map:import .data/maps/wargame/map.csv --yes`（1,024 个区块）→ 停掉服务器。GM 首次登录会自动建号。
- ✅ 87 **README 改版与许可证**（用户原话："readme的使命也变化了，只放这几样东西：1.这个项目是什么？2.简要部署指南，并链接至详细的部署文档。3.简要的玩法简介，并链接至详细的玩法文档。4. 简要的开发/贡献指南，并链接至完整的开发文档。5.免责声明。另外把我拉个版权协议文件。看下能不能用GPL v3, 不能的话退回MIT."）。
  - README 只剩这五块。原 README 的内容拆成 `docs/deployment.md`（环境要求、本地运行、局域网访问、本地数据、常用命令、部署到 Cloudflare、已知限制、常见问题）和 `docs/development.md`（目录结构、架构、开发步骤、测试），章节重新编号；快速开始里过时的说法（"页面下方出现 GM console"、英文页面名）改正。AGENTS.md 的文档分工表、HANDOFF、architecture.md、开发指南里对 README 章节的引用都改指新文档。
  - 许可证：直接依赖全是 MIT / ISC / Apache-2.0（都与 GPLv3 兼容），所以用 **GPL-3.0-only**。`LICENSE` 是 GNU 官方全文（与 gnu.org 的 `gpl-3.0.txt` 逐字节一致，SHA-256 `3972dc97…`），`package.json` 加 `"license": "GPL-3.0-only"`，README 末尾写版权与许可证。
- ✅ 88 **前端整合第 3 步（一）：声明带参数、第一个通用控件**（architecture.md 3.4）。`ui` 的所有声明可带 `props`（`UiProps`：`view`、`params`、控件配置），前端摆放时绑定为组件的 props，并自动 `game.need(view)`；插槽改为返回 `{ component, props }`；窄带的 key 改为插件名 + 序号（多个由服务端声明的项不再撞 key）。新文件 `src/shared/ui.ts`（通用控件的数据形状：`UiText`、`BadgeData`）、`web/widgets/`（`Badge.vue`、`text.ts`），前端插件 `widgets` 注册 `ui.badge`。`prestige` 新视图 `prestige.badge`（官职、声望、下一官职），用户名旁改用 `ui.badge`；前端插件 `prestige` 删除，它的文案搬进 `prestige`、`bandits`、`starter-prestige` 的 `data/i18n.csv`。测试：`prestige.badge` 的内容。浏览器冒烟：用户名旁仍是"郡丞 · 声望 5,990"，悬停提示一致，控制台无报错。
- ✅ 89 **前端整合第 3 步（二）：卡片控件，聚宝阁改用通用控件**。`src/shared/ui.ts` 新增 `UiAction`（命令按钮：`blocked` 时禁用并显示原因，可带确认）、`UiCard`、`CardsData`；`web/widgets/` 新增 `Cards.vue`（`ui.cards`：按组分节、状态行（`warn` 标红）、按钮）、`Filters.vue`（`ui.filters`：标题、摘要、"全部"+ 每组一个按钮（带件数）、脚注）、`state.ts`（同名 `filter` 共享所选组）、`actions.ts`。`shop` 新视图 `shop.cards`（余额、类别、商品卡片；限购优先于元宝不足作为禁用原因），聚宝阁两栏改为声明 `ui.filters` / `ui.cards`；前端插件 `shop` 删除，文案进 `shop/data/i18n.csv`。测试 "shows its offers as generic cards…"。浏览器冒烟：左栏余额与类别（带件数）、右栏按类别显示、余额不足时按钮禁用并提示、购买后余额减少，控制台无报错。
- ✅ 90 **前端整合第 3 步（三）：计时列表控件，兵营入口改用通用控件**。`src/shared/ui.ts` 新增 `UiTimer`（`where` 按入口类型筛选、`startedAt / endsAt` 倒计时与进度条、状态行、按钮）、`TimersData`（可按入口的提示）；`web/widgets/Timers.vue`（`ui.timers`，到点按最早的 `endsAt` 自动 `refreshAt`）。`troops` 新视图 `troops.training`（这座城每座兵营的队列：在训的一批、可取消的计划；没在训练的兵营给出原因），兵营入口改为声明 `ui.timers`；前端 `TrainingBlock.vue` 删除，相关文案进 `troops/data/i18n.csv`。测试补在 "queue training plans…" 里。浏览器冒烟：步兵营入口显示倒计时、计划与"取消（返还资源）"，取消后少一条，控制台无报错。
- ✅ 91 **前端整合第 3 步（四）：行列表控件，城墙入口改用通用控件**。`src/shared/ui.ts` 新增 `UiRow`、`RowsData`；`src/shared/format.ts`（`duration`、`amount`、`amounts`，前后端共用）；`web/widgets/Rows.vue`（`ui.rows`）。`starter-siege` 新视图 `starter-siege.queue`（在建项，给 `ui.timers`）与 `starter-siege.rows`（城防工事、守城器械：当前效果、下一级 / 每个的效果与费用、维持、未解锁），城墙入口改为声明这两个控件；前端插件 `siege` 删除，文案进 `starter-siege/data/i18n.csv`。测试补在 "siege defences at the wall…" 里。浏览器冒烟：城墙入口的列表、费用、"需要城墙 N 级"都与原来一致，控制台无报错。另：全套测试连跑 3 次都通过（"map overview" 曾偶发失败一次，单独重跑 3 次都通过）。
- ✅ 92 **1.0.0 发布**（用户原话："以上任务完成后，另外再整理一下哪些文件/文件夹需要加入gitignore. 就可以提交一个1.0.0版了。新建并提交到github上，公开。"）。`.gitignore` 改写为本项目专用（原来是通用 Node 模板，且 `*.log` 等几条被写坏成 `_.log`、`\*.pid.lock`，实际不生效）：依赖、构建产物、wrangler 本地状态与密钥（保留 `.dev.vars.example`）、本地游戏数据 `.data/`（存档、备份、生成的地图）、日志缓存、系统与编辑器文件（保留 `.vscode/settings.json`）。公开前检查过：密钥从未进过 git 历史，`.dev.vars.example` 与测试里的 GM 密码都是占位值，`wrangler.jsonc` 没有真实的数据库 id。`package.json` 版本 1.0.0；提交并打标签 `v1.0.0`，推到新建的公开仓库。
- ↩️ 93 **撤回提前发布的 1.0.0**（用户："我让你都完成之后再发布"——"以上任务完成后"指前端整合全部完成，而不是当时那一小步）：删除 GitHub Release 与远端 / 本地的 `v1.0.0` 标签，仓库保持公开（用户选择），提交 `2533e42` 保留。`package.json` 的 1.0.0 作为待发布的目标版本。全部做完后再发布。
- ✅ 94 **前端整合第 3 步（五）：研究所入口与研究队列**。`research` 把 `research.tree` 的计算抽成 `treeOf`（同一次调用里缓存），新视图 `research.queue`（所有城池在研的项，给科技页左栏的 `ui.timers`）、`research.current`（本城在研项与研究速度说明）、`research.options`（本城现在能研究的科技，按门类 · 阶分节：等级、解锁、每级 / 到几级时的效果、费用（资源不足标红）、"研究 N 级"按钮及禁用原因）。效果文字改由服务端生成（文案键 `{effect} {value} per level` 等），`TechEffect` 新增 `familyName`（由 `starter-research` 填，`research` 不依赖战斗插件）。前端 `LabBlock.vue`、`QueueBlock.vue`、`time.ts` 删除（科技树留到第 4 步）。修正：`ui.timers` 放在入口里时，没有 `where` 的条目和提示也要显示。测试补在 "runs in institutes…" 里。浏览器冒烟：研究所入口与原来一致，控制台无报错。
- ✅ 95 **前端整合第 3 步（六）：军队页**。通用控件扩展：`UiAction.page`（按钮也可以打开页面，如"完整战报见邮箱"）、`UiText.vars` 可以是 `UiText[]`（逐项翻译后用"，"连接，如部队列表）、`TimersData.tone: 'warn'`（整块醒目，如来袭警报）。`armies` 把来袭与行军列表的计算抽成 `incomingOf` / `listOf`，新视图 `armies.alerts`（来袭：攻方、目标、倒计时、斥候情报）与 `armies.marches`（出发地 → 目标、任务 · 阶段、部队、粮饷 / 带回 / 辎重、战果、召回（带确认）与"去邮箱看战报"），军队页右栏改为两个 `ui.timers`；前端 `ArmiesPage.vue` 删除（到点提交行军的逻辑留在前端插件）。测试补在 "siege defences at the wall…" 里。浏览器冒烟：来袭警报、行军、召回确认与返程都正常，控制台无报错。
- ✅ 96 **前端整合第 3 步（七）：道具页**。`ui.cards` 新增 `layout: 'tiles'`（小方块网格，标题随所选组变化，`CardsData.allTitle`）与卡片详情（`UiCard.detail`：说明行 + 一个服务端命令表单，复用 `forms` 的 Outlet；有"返回"；道具用完或换了组时回到网格），`widgets` 前端插件依赖 `forms`。`items` 新视图 `items.cards`（按类别分组的道具，可用的带 `items.use.<id>` 表单），道具页两栏改为 `ui.filters` / `ui.cards`；前端 `InventoryList.vue`、`ItemsPage.vue`、`state.ts` 删除（各建筑与页面上的道具快捷按钮暂留）。因为 `items` 不依赖城池插件，详情里的提示改为"作用于当前选中的城池（在左上角切换）"。测试 "show on the Items page as generic tiles…"。浏览器冒烟：类别筛选、网格、详情与使用（数量减少）都正常，控制台无报错。
- 📝 收到并记入 HANDOFF（1.0.0 之后再做）：市政厅改名、市政厅 / 宫殿加本城建造速度、三座招募建筑只能建在首都、内城默认栏位 22。
- ✅ 97 **前端整合第 3 步（八）：军队页的各城驻军**。通用控件扩展：统一的状态行 `UiLine`（可带 `endsAt`，控件自己显示倒计时；公用组件 `web/widgets/Line.vue`、`time.ts`），`UiAction.params`（按钮修改前端参数，如切换城池），`RowsData` 的分节可带 `actions`（标题可点）、`lines`（节末说明行）、`current`（高亮）。`troops` 新视图 `troops.garrisons`（每座能驻军的城池一节：每个兵种的数量与攻防生命、战力、维持费、在训的一批（倒计时）、排队计划数），军队页左栏改为 `ui.rows`；前端 `GarrisonsBlock.vue` 删除。测试补在 "trains in batches after the barracks…" 里。浏览器冒烟：与原来一致，控制台无报错。另：一次全套测试里 "luck (from charm) makes more drops likelier"（统计性质，"几乎总是"满掉落）失败一次，之后单独连跑 28 次都通过，属罕见偶发，暂不改。
- 📝 **版本号规则**（用户："约定一下以后得版本号递增规律。A.B.C，如果新版本只设计默认的数值修改，递增C，如果设计不影响兼容性的核心插件修改，递增B，影响兼容性的修改，递增A。"）→ AGENTS.md 新增"版本号与发布"一节（连同"只在用户要求、且范围全部完成时发布"）。
- ✅ 98 **前端整合第 3 步（九）：秘境页左栏**。通用控件的文字翻译认出名字部件的键（"姓键 名键"），按当前语言拼写（中文不加空格）。`realms` 把总览的计算抽成 `overviewOf`（同一次调用缓存），新视图 `realms.away`（在外冒险的英雄：秘境 · 任务、倒计时）与 `realms.injured`（重伤的英雄：疗伤中倒计时，或"疗伤（费用，时长）"按钮）；`starter-equipment` 新视图 `starter-equipment.shop-rows`（秘境商店：白色字、套装 · 等级要求、标价按钮，买不起禁用），`UiRow` 新增 `rarity`。秘境页左栏改为两个 `ui.timers` + 一个 `ui.rows`；前端 `AdventuresBlock.vue`、`RealmShop.vue` 删除（秘境列表 `RealmsPage.vue` 要选英雄并在前端算预计战果，暂留）。测试补在秘境与装备的测试里。浏览器冒烟：与原来一致，控制台无报错。
- 📝 排期（1.0.0 之后）：领导溃败的英雄重伤（HANDOFF 待办 3）。
- ✅ 99 **前端整合第 3 步（十）：英雄的职务与守城顺序**。`RowsData` 分节可带 `where`（与 `ui.timers` 同样的入口筛选）。`starter-heroes` 新视图 `starter-heroes.posts-city`（城池页：本城的职务与守城武将，人数 / 上限、担任者、加成，没人时"去委派英雄"）与 `starter-heroes.posts-entry`（各建筑入口的职务，按 `where` 显示），声明也放在 `starter-heroes`（系统插件 `heroes` 不引用内容插件的视图）；`heroes` 新视图 `heroes.defense-rows`（守城顺序：每位英雄一行，↑ / ↓ 直接保存交换后的顺序，"恢复默认"）。前端 `PostsBlock.vue`、`DefenseBlock.vue` 删除。测试补在英雄职务的测试里。浏览器冒烟：城池页、研究所入口、英雄页都与原来一致（守城顺序改为点 ↑ / ↓ 即保存），控制台无报错。
- ✅ 100 **前端整合第 3 步（十一）：道具快捷按钮，第 3 步完成**。`UiCard.where`（`building:<类型>` / `page:<页面>`），`ui.cards` 新增 `compact` 布局（每张卡一个小按钮，就地展开说明、服务端表单（在入口里带上该城池）或按钮）。`items` 新视图 `items.shortcuts`（每个快捷位置一张卡：有就给使用表单，没有就说从哪里获得、"去聚宝阁购买"），`ui.dynamic` 的声明改为 `ui.cards`；前端插件 `inventory` 整个删除（文案进 `items/data/i18n.csv`）。测试补在招贤令的测试里。浏览器冒烟：兵营入口（练兵札子使用表单、没有的显示来源与购买）、英雄页左栏的招贤令都正常，控制台无报错。
  - 第 3 步小结：用户名旁的官职与声望、聚宝阁、道具页与快捷按钮、兵营训练队列、城墙城防、研究所与研究队列、军队页（来袭、行军、各城驻军）、秘境页左栏、英雄职务与守城顺序都已改成后端声明 + 通用控件（`ui.badge / cards / filters / timers / rows`）。删掉的前端插件：`prestige`、`shop`、`siege`、`inventory`。留到第 5 步统一归置的专用组件：邮箱、英雄卡片与候选、秘境列表（选英雄、前端预计战果）、战报渲染；城池页、地图、科技树、装备栏、阵列、分路战况属于第 4 步。
- ✅ 101 **前端整合第 4 步（一）：通用格子地图 `ui.grid`，世界地图改用它**（用户："比如地图插件，第三方可以引入一个'异世界'副本，在一个更小的网格上，让玩家战斗等。"）。`src/shared/ui.ts` 新增 `GridCell`、`GridData`（网格大小、是否首尾相接、窗口中心与半径、每格的底色 / 图标 / 边框 / 提示 / 选中后的信息与按钮、图例、`placement`）；`web/widgets/Grid.vue`（移动、回家、跳转、选中格子的信息与服务端表单，插槽 `grid-side:<grid>`）。`world-map` 新扩展点 `addLayer`（各插件按窗口给格子填内容，按登记顺序合并）、`setHome`，新视图 `world-map.grid`（原来的标记变成一个内置图层，空地写"空地。"）；`terrain` 登记地形图层（底色、名称、图例，迷雾里的格子为未知）；`settlements` 登记城池图层（中心图标、边框：自己的 / NPC / 别人的、"名字（类型）· 主人"、自己的可"打开"）并设回家位置为选中的城池；城池类型新增 `icon`（首都 🏰 等，原来写在前端）。地图页改为声明 `ui.grid`，"周边 NPC 城池"面板挂在插槽 `grid-side:world`；前端 `MapPage.vue` 删除。测试：新增 "generic grid (ui.grid)"（世界地图的图层与回家；一个只有后端的 5×5 "异世界"假插件，用 `ui.grid` 声明自己的页面）。浏览器冒烟：225 格、底色与边框、图例、移动、选中首都（信息与"打开"）、空地的筑城表单都正常，控制台无报错。
- ✅ 102 **前端整合第 4 步（二）：通用节点图 `ui.tree`，科技树改用它**。`src/shared/ui.ts` 新增 `TreeNode`、`TreeData`；`web/widgets/Tree.vue`（同组前置连线、别组前置标签、节点状态与按钮）。`research` 新视图 `research.graph`（门类 → 阶 → 科技：等级、题注、解锁、效果、研究中 / 未解锁原因），科技页右栏改为声明 `ui.tree`；前端插件 `research` 整个删除（研究完成的到点刷新由 `ui.timers` 负责），文案进 `research/data/i18n.csv`。测试补在科技树的测试里（只看两个门类：别的测试会注册不属于门类的临时节点）。浏览器冒烟：46 个节点、45 条连线、14 个跨门类标签，控制台无报错。
- ✅ 103 **前端整合第 4 步（三）：通用格子 `ui.cells`，城池页改用通用控件**。`src/shared/ui.ts` 新增 `UiCellItem`、`CellsData`；`web/widgets/Cells.vue`（选中格子时关掉打开的入口）。`ui.cards` 扩展：页眉 `header`、`defaultGroup`（所选组不在数据里时回落，例如换了城池）、卡片下方的服务端表单 `placement`、`detail.label` / `detail.choices`（选项按钮及其状态行）、`where` 可为列表或 `<入口类型>#<入口 id>`、打开当前入口的按钮自动隐藏、按最早的 `endsAt` 到点刷新；`UiLine` 新增 `tone: 'info'` 与 `startedAt`（进度条）；`UiAction.entry`（按钮打开入口）。`settlements` 新服务方法 `detail`（同一次调用缓存，`settlements.detail` 视图用它）和视图 `settlements.districts`（城区九宫格：内城、外城、可建外城的空地（点了确认后 `settlements.addOuter`，研究不够时提示原因）、地形与加成）；`terrain` 给 `detail.terrain` 补上地形名；`buildings` 新视图 `buildings.slots`（页眉：类型、坐标、建造队列、外城数、可驻军；按城区分组，每个栏位一张卡：当前效果、升级（费用 · 时长、禁用原因、资源不足提示）、建造中倒计时与进度条、取消（带确认）、"打开"入口；空栏位"建造…"列出能建的建筑），城池页两栏与建筑入口的第一块都声明为通用控件；"换城池时关掉入口"移进前端插件 `settlement`；前端插件 `city` 整个删除，文案进 `settlements`、`buildings` 的 `data/i18n.csv`。测试 "draws the City page as generic widgets…"。浏览器冒烟：九宫格（内城高亮、外城、＋空地）、切换城区、空栏位建造列表、建造后倒计时与进度条、打开农田入口，控制台无报错。
- ✅ 104 **前端整合第 4 步（四）：装备栏改用通用控件**。没有新控件，扩展现有的：`ui.rows` 新增 `picker`（顶部下拉框，设置一个前端参数，视图跟着变）和分节的 `cells`（一排小格子）；格子抽成公用组件 `web/widgets/Cell.vue`（`ui.cells` 也用它），`UiCellItem` 新增 `rarity`；通用控件的文字若本身就是名字部件的键（如下拉框里的英雄名）也按语言拼写。`equipment` 新视图 `equipment.gear`（参数 `hero`，默认本城第一位英雄：各常规栏位穿着什么（颜色、属性、卸下）、饰品一排格子（点了卸下，空格提示）、本城存放 n / 上限与每件的"装备"（等级不够时禁用并说明）/"拆解（可得资源）"（带确认）、别的英雄穿着的），英雄页右栏与武库入口改为声明 `ui.rows`；前端插件 `equipment` 整个删除，文案进 `equipment`、`starter-equipment` 的 `data/i18n.csv`。测试补在"are stored in settlements…"里。浏览器冒烟：英雄名、穿上 / 卸下、存放数、饰品格子，控制台无报错。
- ✅ 105 **前端整合第 4 步（五）：通用报告 `ui.report` 与分路对比 `ui.lanes`，战报改由服务端呈现**。`src/shared/ui.ts` 新增 `UiField`、`LanesData`、`ReportData`；`web/widgets/Report.vue`（`ui.report`：放在邮件里时读消息的 `report`，也可读视图）、`Lanes.vue`（`ui.lanes`）。`mail` 新服务方法 `present(kind, fn)`：邮箱视图读信时调用对应的呈现函数，把 `report` 放进消息（呈现失败的旧信只是不显示正文，不会让整个状态请求失败）；`MailMessage.report`。`war-reports` 登记行军、守城、短缺三种战报的呈现（任务标记、出发地 → 目标、结果与攻防、部队 / 损失 / 战利品 / 俘获 / 晋升、声望涨跌、缴获（按颜色）、分路表（从本方视角：每路兵种与人数、克制、攻防生命、损失；双方加成）），声明改为 `ui.mail(kind, 'ui.report')`，文案进新的 `war-reports/data/i18n.csv`（"缴获"的键改为 `Spoils`，避免与"建立"的 `Found` 冲突）；前端插件 `war-reports` 整个删除。通用控件的文字翻译现在会拼写嵌在文字里的名字键（如"流寇头目：孔寒山"）。测试补在"attacks another player…"里（双方各自视角的分路胜负）。浏览器冒烟：守城战报的各项与分路表与原来一致，控制台无报错。
- ✅ 106 **前端整合第 4 步（六）：阵列编辑器改为通用表单字段 `ui.lanes-input`，第 4 步完成**。`src/shared/ui.ts` 新增 `LanesInputData`（几路、每路的标题、可选的组、各项（属于哪组、排序）、池子（按另一个表单字段的值选，如出发城池）、输出的键名、不分组的格子、空路提示、合计文字）；`web/widgets/LanesInput.vue`（由原来的阵列编辑器改写，与玩法无关），`widgets` 前端插件把它注册为表单字段编辑器（`payload` 按 `data.output` 输出各路与每项合计）；表单字段编辑器的 `payload` 多收一个参数 `field`。`battle` 的攻打选项改为给出 `ui.lanes-input` 的数据（兵种系为组、兵种为项、各城驻军为池、辅助兵种进不分组的格子，输出仍是 `formation` / `units`，接口不变）；`FormationWidgetData` 删除；前端插件 `battle` 删除，文案进 `battle/data/i18n.csv`。测试改在"offers a formation editor…"里。浏览器冒烟：对另一名玩家的首都打开攻打表单，五路的兵种选择、"最多 N"、合计，填 5 人出征后行军带着 `infantry-1` ×5，控制台无报错。
  - 第 4 步小结：世界地图（`ui.grid`）、科技树（`ui.tree`）、城池页（`ui.cells` + `ui.cards`）、装备栏（`ui.rows` 的下拉与格子）、战报（`ui.report` + `ui.lanes`）、阵列编辑器（`ui.lanes-input`）都已改成通用控件。删掉的前端插件：`city`、`equipment`、`war-reports`、`battle`（另有第 3 步的 `research`）。剩下的前端插件：外壳（auth、settlement、resource-bar、forms、locale-zh）、widgets、gm-panel，以及第 5 步要归置的 armies、heroes、mail、realms、troops、world-map。
- ✅ 107 **前端整合第 5 步（一）：到点同步 `ui.sync`，前端插件 `armies`、`troops` 删除**。`src/shared/ui.ts` 新增 `SyncData`；`web/widgets/Sync.vue`（`ui.sync`：不显示，声明在顶部窄带，所以每个页面都生效；到点刷新或执行命令，加载时已到期的命令执行一次）。`armies` 新视图 `armies.due`（按**已提交**的行军行给出到达 / 返回时刻 → `armies.sync`，所以离线期间到期的行军在加载时补提交；来袭的到达时刻 → 刷新），`troops` 新视图 `troops.due`（各城训练完成时刻 → 刷新），两者都声明为 `ui.band({ band: 'top', widget: 'ui.sync' })`；这两个前端插件原来就只剩文案和这段定时逻辑，整个删除，后端代码里用到而还没有译文的键搬进 `armies`、`troops` 的 `data/i18n.csv`（包括拼出来的 `{0} (supplies)` 等模式键；另有 13 条已经没人用的旧键丢弃）。`ViewMap` 补上本轮新增的视图。测试补在"attacks another player…"里（攻方的客户端到点提交、守方到点刷新）。浏览器冒烟：停在城池页，行军（GM 加速到 6 秒后到达）到点后战报自动进了邮箱；军队页的驻军、行军都正常，控制台无报错。
- ✅ 108 **前端整合第 5 步（二）：冒险报告与秘境的到点提交改用通用控件**。`UiLine` 新增 `rarity`（文字按颜色）；`ui.report` 的分路表没有标题时直接显示（不折叠）。`realms` 登记 `realms.report` 的呈现（英雄 · 秘境 · 任务、冒险属性、经验与升级、每组怪物一行（攻防命、英雄生命变化、胜负、掉落按颜色，丢失的注明"行囊已满"）、通关奖励、重伤提示），声明改为 `ui.mail('realms.report', 'ui.report')`；新视图 `realms.due`（按已提交的冒险与疗伤行给出结束时刻 → `realms.sync`），声明为顶部窄带的 `ui.sync`。前端 `RealmReport.vue` 与定时逻辑删除，前端插件 `realms` 只剩秘境列表（选英雄、预计战果）和英雄卡上的冒险区块；文案按"后端用到的进 `realms/data/i18n.csv`、只有前端组件用的留下"整理。测试补在冒险掉落装备的测试里。浏览器冒烟：停在城池页，冒险（每组 1 秒）结束后报告自动进邮箱，报告的各行与掉落颜色正常，控制台无报错。
- ✅ 109 **前端整合第 5 步（三）：秘境列表改用 `ui.rows`**。`ui.rows` 的分节新增 `intro`（标题下的说明行），`UiLine` 新增 `parts`（文字后面分段着色，如可能的掉落）。`realms` 新视图 `realms.list`（参数 `hero`，默认第一位空闲英雄：下拉选英雄、冒险属性与幸运；每个秘境一节：序号与名字（未开启加 🔒）、地图位置、题词、开启方法；每个任务一行：组数 · 最强攻防命 · 经验 · 掉落率与平均件数、按"一般 / 偶见 / 罕见 / 通关必得"分行的掉落（按颜色）、预计战果（服务端用同一个 `fightGroups` 算）、"出发"（没有空闲英雄时禁用））；前端 `RealmsPage.vue` 删除，前端插件 `realms` 只剩英雄卡上的冒险区块。修正：地图位置的坐标列表原来被 `{0} ({1}, {2})`、`{0}, {1}` 两个模式键误翻译，改为每个坐标一项 `({0}, {1})`（加了原样的精确键）。测试补在"are ten, five tasks each…"里。浏览器冒烟：秘境页与原来一致（坐标、掉落颜色、预计战果），派出冒险后"出发"变为禁用（没有空闲英雄），控制台无报错。
- ✅ 110 **前端整合第 5 步（四）：英雄页改用通用控件，前端插件 `heroes`、`realms` 删除**。
  - 名字拼写下沉到前端核心：`game.t` 先把文字里的名字键（"s:Zhao m:Zilong"）按语言拼写（meta `heroNames`），通用控件不再各自处理；玩家看到的服务端表单（出征带的英雄、秘境冒险、招贤令等）改为直接发名字键，`heroes` 前端插件原来"把英文拼写的名字补成译文"的逻辑删除。
  - 候选英雄：`heroes` 新视图 `heroes.candidate-cards`（每个招募建筑一组，组标题下"距离刷新"倒计时；每个栏位一张卡：名字、六维与天赋、"招募 · 费用 / 免费"（资源不足时禁用）；已招募 / 本轮无人；`where` 让建筑入口只显示自己的），`CardsData.groups` 可带 `lines`（`ui.cards` 也按它到点刷新）。
  - 英雄卡：`heroes` 新视图 `heroes.cards`（页眉"某城的英雄（本城 / 全部）"；每位英雄：等级 · 职务 · 地点、经验与天赋、六维（加成、天赋）、自由点，再加上其他插件的行），新扩展点 `heroes.addCardLines`（`starter-heroes` 加各职务的加成，`realms` 加冒险属性；原来的前端插槽 `hero-card` 不再使用）；"管理"打开放在 `hero` 位置的服务端表单（`UiCard.detail.form` 可以不指定命令、带 `context`）：`heroes.assign`（职务）、`heroes.setHome`（改挂靠，会卸任时在说明里提示）、`heroes.allocate`（每个属性一个数字，用预算限制不超过自由点；命令新增接受 `points.<属性>` 平铺字段）、`heroes.dismiss`（只对空闲英雄，带确认）；`heroes.assign` 设为空闲时不再记录地点。
  - 前端插件 `heroes`（`HeroCard`、`HeroList`、`RoleEffects`、`CandidatesBlock`）和 `realms`（`AdventureSection`）删除，文案进各自后端插件的 `data/i18n.csv`。
  - 测试：候选卡片（"are recruited at a venue…"）、英雄卡与 `hero` 位置的表单（"are ten, five tasks each…"）、按表单形状分配点数。浏览器冒烟：英雄页（卡片、各职务加成、冒险属性、"管理"里的分配点数表单）、候选与守城顺序正常，控制台无报错。
- ✅ 111 **秘境页按秘境分组**（用户原话："秘境现在的排版没以前那么好看了，右栏加一个按秘境分组的按钮吧。然后顺带左栏商店仅显示当前秘境的装备。要不然都解锁之后就太长了。"）。`ui.rows` 新增 `tabs` / `defaultTab`（一排分组按钮）和分节的 `group`（只在所选组时显示），所选组经同名 `filter` 与其他控件共享（没有 `filter` 时只在本控件内）。`realms.list` 每个秘境一个按钮（未开启的带 🔒），默认显示最新开启的秘境；`starter-equipment.shop-rows` 改为每个已开启的秘境一节（标题是秘境名），跟随右栏的选择（所选秘境未开启时显示默认的最新秘境）；两个声明都带 `filter: 'realms.realm'`。排版：`ui.rows` 里带按钮的行之间加分隔线和间距、分节说明与行之间留白（秘境的每个任务成为一块）。测试补在"are ten…"里。浏览器冒烟：右栏一次只显示一个秘境，切换按钮时左栏商店跟着变，控制台无报错。
- ✅ 112 **前端整合第 5 步（五）：地图旁的列表改由服务端声明，前端插件 `world-map` 删除**。`src/shared/ui.ts` 新增 `GridSide`、`GridData.sides`（格子旁的列表：标题、说明、可选的下拉选项（作为参数随下次请求发送）、每项的文字与坐标（点了居中并选中）、空列表提示）；`ui.grid` 渲染它（插槽 `grid-side:<grid>` 仍保留给前端插件）。`world-map` 新扩展点 `addSide`；`settlements` 把"附近的城池"抽成 `nearbyOf`（视图 `settlements.nearby` 照旧），登记"周边 NPC 城池"侧栏（范围 10 / 20 / 30 / 50 … 至 GM 上限，参数 `nearbyR`）。前端 `NearbyPanel.vue` 与插件 `world-map` 删除，文案进 `settlements/data/i18n.csv`。`mail` 是邮箱本身（分页、已读、删除），与 `forms` 一样作为官方基础前端插件保留。测试补在 "generic grid…" 里。浏览器冒烟：地图页侧栏与范围下拉正常，控制台无报错。
- ✅ 113 **前端整合第 5 步（六）：`extensions/` 两端自动发现与三个示例扩展**（用户："如果第三方认为以上都表达不了的时候，可以开发自己的前端插件。在不改变官方代码的情况下进行扩展。"）。
  - `src/plugins.ts` 末尾收集 `extensions/*/server.ts`、`web/plugins.ts` 末尾收集 `extensions/*/client.ts`（Vite `import.meta.glob`，构建时打包；服务端的类型声明在 `src/types/glob.d.ts`）；根 `tsconfig.json` 检查 `extensions/*/server.ts` 与 `examples/*/server.ts`，`web/tsconfig.json` 检查两者的 `client.ts` 与 `.vue`。`extensions/README.md` 说明目录约定。
  - 示例（都在 `examples/`，复制到 `extensions/` 即启用）：`watchtower`（`index.ts` 改名 `server.ts`）；新的 `otherworld`（只写后端：5×5 小网格页面、格子按钮执行命令、命令的邮件由 `mail.present` 显示为通用报告；取代测试里原来的"异世界"假插件）；新的 `announcement`（自带前端控件：GM 规则 `announcement.text`、视图、顶部窄带声明，`client.ts` + `Banner.vue` 画横幅、可关闭当前这条；两端共用的类型在 `types.ts`）。
  - 开发指南第 1 节改为三个示例，第 7 节改写为"多数时候只写后端"（通用控件一览、`UiText`、名字键、何时写自己的前端插件），新增第 8 节"扩展"；development.md 的目录结构、README、AGENTS.md 同步。
  - 测试：示例 `otherworld`（页面声明、格子、按钮、邮件报告、拒绝路径）和 `announcement`（窄带声明、规则空 / 非空时的视图）。浏览器冒烟：把两个示例复制进 `extensions/` 构建，公告横幅显示且可关闭，"异世界"页 25 格、探查后邮件以通用报告显示，控制台无报错；冒烟后删掉了复制品。
  - 另：用户反馈"地图页的派兵表单不见了"，用存档副本确认是城池里没有驻军时表单本来就不显示（用户："我知道了，没有部队就不显示表单了，不是你写错了"）。
- ✅ 114 **GM 群发邮件和公告**（用户原话："对了，GM要可以群发邮件和公告。"）。
  - 群发邮件：`mail` 新 GM 路由 `POST /api/gm/mail/broadcast` { title（≤100 字）, body（≤2000 字） }（第一行 `requireGM`），给全部玩家各放一封 `mail.broadcast`（和普通邮件一样已读、删除），正文按行显示为通用报告；写审计日志 `mail.broadcast`（`gm` 新服务 `gmAudit.record`，让别的插件的 GM 路由也能记审计）。
  - 公告：`mail` 新 GM 规则 `mail.announcement`（≤200 字，留空不显示）与视图 `mail.announcement`；新通用控件 `ui.banner`（`BannerData`：图标、文字、`key`；玩家点"知道了"后隐藏，换了新公告再出现），声明在顶部窄带。
  - GM 后台新增"群发"标签页：给所有玩家发邮件（带确认，提示发给了几人）、编辑 / 撤下公告。
  - 示例 `announcement` 与官方公告重复，改成 `examples/clock`（自带前端控件：底部窄带走动的服务器时间，GM 规则 `clock.utcOffset`）。
  - 测试：`test/api.spec.ts` "GM messages to everyone"（玩家调用被拒 403、空标题 400、群发后玩家收件箱里有这封且正文分行、公告设上 / 撤下、审计日志）；示例 clock 的测试。浏览器冒烟：GM 后台群发后提示"已发送给 5 名玩家"、邮件正文两行、公告横幅出现且可关闭，控制台无报错。
- ✅ 115 **流寇加强、兵力不再整齐**（用户原话："然后设计稿里流寇有点弱。我用GM测试，声望一万，派了2级流寇才这么点人。正常到这个声望的时候，玩家军力应该有好几万了。然后流寇除了等级之外，来的兵不要那么整。等级决定最高几级兵和有没有英雄。玩家声望决定兵的多少。"）→ gameplay.md 12.3。`bandits`：`BanditLevel.lane`（每路固定人数）改为 `mix`（各等级的比例），`defineLevelsFromCsv` 读 `mix` 列；新函数 `composeLanes`：总数 = `size.base + size.perPrestige × 当前声望^size.exponent`（默认 60 / 2 / 1：声望 1 万约 2 万人），总数 ±`size.jitter`（0.2），各路份额 ±`laneJitter`（0.3），各等级比例 ±`mixJitter`（0.15），人数取整到个位。`starter-bandits/data/levels.csv` 改为比例（与原来各级的构成相同）。规则说明与 GM 字段名补中文。测试 "come in numbers by prestige, in tiers by level, never in round blocks"（声望 1 万：约 2 万人、3 级流寇只到 2 级兵、各路各级人数互不相同；关掉随机时总数精确）；原有流寇测试照常通过。线上已有、还在路上的流寇不受影响（兵力在出现时就定了）。
- ✅ 116 **"x色xx宝箱"**（用户原话："对了，添加'x色xx宝箱'。随机出一个制定颜色+制定套装的装备。"）→ gameplay.md 10.4。`starter-equipment` 定义 51 种宝箱道具 `chest-<套装>-<颜色>`（7 个常规套装 × 5 色 + 4 个饰品套装 × 4 色，饰品没有白色），名称用模式键 `{0} {1} chest` 译成"紫色青锋套装宝箱"，类别"宝箱"；打开（`items.use.chest-…`，作用于选中的城池）时按玩家与时间播种随机，在该套装里随机一个部位、用同一套属性规则生成该颜色的装备；存放处满时拒绝（`storage_full`），宝箱保留。`items` 的 `ItemDef` 新增 `rarity`，道具卡片按颜色显示名字。暂按：只由 GM 发放。测试 "come in chests of one set and colour…"（名称、颜色、打开三次得到三件该色该套、第四次因存放处满被拒且宝箱保留）。浏览器冒烟：道具页"宝箱"分类、紫色名称、打开后得到紫色青锋套装的靴子，控制台无报错。
- ✅ 117 **战报每路的兵力组成**（用户原话："战报里要显示地方每一路的兵力组成。不能光步兵×多少，要是步兵（下一行）民兵x多少；xxx"）→ gameplay.md 6。`war-reports` 的分路表里每一方每一路在"兵种系 ×总数"下面加一行逐个兵种的人数；战报是读取时呈现的，所以旧战报也这样显示。测试补在"attacks another player…"里。浏览器冒烟：守城战报第 1 路敌方显示"🏹 弓兵 ×360 / 猎户（弓兵）×300，弓手（弓兵）×60"。
- ✅ 118 **宝箱上架聚宝阁**（用户："宝箱部署了吗？我在聚宝阁里没看到宝箱？"——原来暂按只由 GM 发放）→ gameplay.md 10.4。`starter-shop/data/offers.csv` 加 51 个宝箱商品（类别 `chests`"宝箱"；价格 = 颜色基价 20 / 50 / 120 / 300 / 700 × 1.3^(套装序号 − 1)，取整到 5；金色每天限购 3、紫色 1），`starter-shop` 依赖 `starter-equipment`；商品卡片按道具的 `rarity` 着色（`ShopOffer.rarity`）。测试补在宝箱的测试里。浏览器冒烟：聚宝阁"宝箱"类别、价格、限购与颜色正常，控制台无报错。
- ✅ 119 **秘境商店始终跟随右栏选择**（用户："然后秘境左侧商店不是筛选只显示右侧选项卡中选中的秘境装备吗？为啥我点进'断魂谷'（目前未解锁），左侧还是黑风岭的装备？"——原来选中未开启的秘境时回落到最新开启的那个）。`starter-equipment.shop-rows` 改为每个秘境都有一节：未开启的标 🔒、说明"开启这个秘境后才能购买"，列出它的装备与价格，购买按钮禁用（服务端照旧只卖已开启秘境的装备）。测试补在秘境商店的测试里。浏览器冒烟：点"断魂谷"左栏变为断魂谷的装备（8 件、按钮禁用），点回"黑风岭"恢复，控制台无报错。
- ✅ 120 **饰品宝箱改名**（用户："还需要'x色饰品套装'的宝箱"；确认后选"现有的就行，改名"）：饰品套装的 16 种宝箱原来叫"绿色素心套装宝箱"，不容易看出是饰品，改为"绿色素心饰品宝箱"（名称键 `rarity:<颜色> chest-set:<套装> accessory chest`，模式 `{0}{1}饰品宝箱`，套装简称 `chest-set:*` 在 `starter-equipment/data/i18n.csv`）。道具 id 不变。测试补在宝箱的测试里。浏览器冒烟：聚宝阁显示"绿色素心饰品宝箱""蓝色流云饰品宝箱"等，控制台无报错。另：一次全套测试里统计性质的 "luck (from charm)…" 偶发失败，单独连跑 3 次与全套重跑都通过（已知现象）。
- ✅ 121 **去掉白色宝箱**（用户："对了，白色套装宝箱可以删了，秘境直接能买，聚宝阁里就不出现了。"）→ gameplay.md 10.4。宝箱只有绿 / 蓝 / 金 / 紫四色（共 44 种），7 个白色宝箱的道具定义和聚宝阁商品都删除（尚未发布，没有玩家持有；持有已删除道具的库存会被忽略，不报错）。测试补在宝箱的测试里（44 种、没有白色）。浏览器冒烟：聚宝阁"宝箱"类别没有白色，控制台无报错。
- ✅ 122 **1.0.0 前的玩法微调**（用户原话："对了，1.0.0版本提交后再微调一下玩法：市政厅->其他更符合中国中世纪背景的名字。然后市政厅/宫殿的作用还可以加本城建筑的建造速度。三种英雄招募建筑设为只有首都可以有。首都/分城的内城默认建筑栏位改为22。"；之后用户："然后把剩下的玩法微调都做完之后，不用我确认，你直接发布1.0.0"）→ gameplay.md 5.1、7。
  - 市政厅改名**府衙**（英文 Prefecture Office；建筑 id `town-hall` 不变，已有的建筑照旧）。
  - 新 stat `buildings.speed`（建造速度 %，`buildings` 系统插件定义，在报价时把时间 ÷ (1 + 速度/100)，与其他时间修正相乘）；宫殿与府衙每级 +3%（`starter-content/data/buildings.csv` 的 stats 列）。
  - 酒馆、书院、听曲楼的 `kinds` 改为只有首都（分城里已建的保留）。
  - 内城默认栏位 12 → 22（`player-settlements` 的 `innerSlots`）；新迁移 `0044_settlements_inner_slots.sql` 给已有内城各加 10 个栏位（保留道具加的）。
  - 测试 "builds faster with a seat of government…"（宫殿 1 级后建造时间 ÷ 1.03；分城的内城不能建酒馆、能建府衙），开局测试改为 22 个栏位。
- ✅ 123 **敌楼改为加防御**（用户："🗼 敌楼 0/3 级 下一级：守方攻击 +5% 改为守方防御+10%"）→ gameplay.md 3.13。`starter-siege/data/works.csv`：敌楼从守方攻击 +5% / +10% / +15% 改为守方防御 +10% / +20% / +30%（造价、时长、维持不变）。
- ✅ 124 **建筑效果文案**（用户："+3 建造速度（%） 语病，应该是建造速度 + 3%"）：建筑卡片的 stat 效果改为"名称 +数值"（"装备存放 +20"），描述以 " (%)" 结尾的 stat 写成百分比（"建造速度 +3%"）；`buildings.speed` 的中文改为"建造速度"。
- ✅ 125 **领导溃败的英雄重伤**（用户原话："加一个排期：英雄'领导'的溃败战斗也会让英雄重伤。"；守城武将算不算原标【待确认】，用户随后："然后把剩下的玩法微调都做完之后，不用我确认，你直接发布1.0.0"，于是按建议实现并注明"暂按"）→ gameplay.md 5.4、9.6。`battle` 新扩展点 `onFought`（每次 `fight` 之后通知，监听者的写入与战斗同一次提交）；`realms` 新服务方法 `injure`（与冒险失败同样的重伤，已重伤的不重复；冒险失败也改用它）；`starter-heroes`（新依赖 `realms`）监听战斗：攻方溃败时带兵的英雄、守方溃败时守城武将都重伤。插件开发指南的菜谱补上 `battle.onFought`。测试 "injure the heroes leading a routed army"、"injure the heroes defending a routed town…"。
- ✅ 126 **研究所的科技改为"门类·阶"筛选 + 卡片**（用户："改成 内政*开基 内政*治世 军事*开基 的筛选+每个科技按以卡片形式展示。""卡片格式类似于科技树里每个科技的卡片格式。""横着拍，竖着排不好看。"）→ ui.md 第 4 节。`research.options` 由 `RowsData` 改为 `CardsData`：每个"门类 · 阶"一组（默认第一组），每个能研究的科技一张卡（名称、等级标记、题注、解锁、效果、费用与时长、"研究 N 级"）；研究所入口改为声明 `ui.filters`（`layout: 'row'`，横排）+ `ui.cards`（`layout: 'nodes'`，与科技树节点相同的样式）。通用控件扩展：`UiCard.badge` / `quote`、`ui.cards` 的 `nodes` 布局、`ui.filters` 的 `row` 布局；数据有 `defaultGroup` 时 `ui.filters` 不显示"全部"、高亮当前显示的组。测试改在 "runs in institutes…" 里。浏览器冒烟：研究所入口三组按钮横排、切换后显示该组的科技卡，控制台无报错。
- ✅ 127 **建筑效果去掉"研究所 +N"，缺资源时哪个资源变红**（用户："研究所+3是废话，不写。资源不足的提示方式不好""还是喜欢原来的缺哪个，哪个资源变红的设计"）。`stats` 的 `StatDef` 新增 `hidden`（记账用、不当作效果显示），`research.labs` 标为隐藏，建筑卡片的效果不再列它。通用按钮 `UiAction` 新增 `parts`（跟在文字后面的几段，"warn" 的显示为红字浅底），由新组件 `web/widgets/ActionLabel.vue` 统一渲染（卡片、行列表、计时、科技树、格子地图的按钮都用它）；`src/shared/format.ts` 新增 `costParts`（费用按资源拆段，按当前库存标出不够的）。建筑的"升级"、空栏位的建造选项、研究所的"研究 N 级"都把费用与时长放进按钮，缺哪个资源哪个变红，按钮禁用（悬停显示"资源不足"），不再另起一行"资源不足"；只因缺资源而禁用的按钮淡得少一些（`button:disabled:has(.short)`），保证红字看得清。浏览器冒烟：新玩家的空栏位里，听曲楼的木头 600、货币 300 标红并禁用，其余照常，控制台无报错。
- ✅ 128 **发布 1.0.0**（用户："然后把剩下的玩法微调都做完之后，不用我确认，你直接发布1.0.0"）：HANDOFF 待办清空、`humannotes.md` 没有新留言，`pnpm check` 通过（148 个测试），全页面浏览器冒烟无报错。提交到 `main`、打标签 `v1.0.0`、建 GitHub Release。上线前要先 `pnpm db:migrate`（新迁移 `0044_settlements_inner_slots.sql`）再部署。
- ✅ 129 **删除开发期数据库，迁移合并为一个基线**（用户："把目前开发阶段的所有数据库都删了（不要可惜，直接删）然后我自己run pnpm dev"；"为啥都clear了，还是有44个迁移sql要执行？能不能合并成一个init.sql?"；确认后"合并吧"）。删除 `.data/local`、`.data/backups`、`.wrangler/state` 和冒烟用的临时库（生成的地图 `.data/maps/wargame/` 保留）。`migrations/0001`–`0044` 合并为 `migrations/0001_init.sql`：用原 44 个迁移建一个新库，按"每张表 + 它的索引和触发器"导出全部结构（50 张表、27 个索引、4 个触发器，保留建表时的注释；没有任何初始数据要带）；用新文件另建一个库逐项比对：`sqlite_master` 的全部定义、每张表的列和外键完全一致。AGENTS.md、development.md：`0001_init.sql` 是 1.0.0 的基线，之后从 `0002` 起只新增。`pnpm check` 通过（148 个测试，测试也只应用这一个文件）。注意：已经按旧迁移建过的库不能再用这套迁移升级（当时没有线上库）。
- ✅ 130 **首次运行时自动处理地图**（用户："然后把地图生成命令和整合进首次运行时里面吧。检查有没有.data/maps, 没有就新建，有就交互式提问要不要继承，或者选择要哪个。"）。`pnpm dev` 改为 `node scripts/dev.mjs`：应用本地迁移（`CI=true`，不再问"continue? (Y/n)"）；用 wrangler 查本地库有没有地形，没有时：`.data/maps/` 里没有地图就生成一张（种子 `map-<日期>-<随机>`），有就列出（新的在前）让用户选一张或生成新的（可填种子；不在终端里运行时用最新的一张）；服务器能访问后自动 `pnpm map:import … --yes`。已有地形时什么都不问。`WARGAME_SKIP_MAP=1` 跳过，`WARGAME_DATA_DIR` 照旧。实测：非终端首次运行（选最新地图并导入）、伪终端里选"生成新地图"并填种子、第二次启动不再提问。另：用户 2026-10-02 "现在都是干净的数据库，你可以随时清空重建"，HANDOFF 已注明。
- ✅ 131 **NPC 城池初始密度**（用户原话："稍等，调整一下初始的NPC城池密度，你计算一下，保证每个16*16的块，平均能分到3个NPC城池（资源或军队）"）→ gameplay.md 3.12。计算：1024×1024 / (16×16) = 4096 块 × 3 = 12,288 座，两类各半。`npc-camps` 新规则 `density`（`blockSize` 16、`perBlock` 3、`spread` 1、`fortressShare` 0.5）与 GM 命令 `npc-camps.populate`（一次最多 32 个块；按块播种 2–4 座，位置按块号播种随机、重试结果相同；已有 NPC 的块跳过）；`population` 默认值由 0 改为各 6,144。`pnpm map:import` 导完地形后逐块调用它（`--no-npcs` 跳过）。测试 "seed a new world block by block…"。实测全新首次运行：4096 个块全部播种，共 12,288 座（要塞 6,241、据点 6,047），平均每块 3.0 座。
- ✅ 132 **点开 NPC 城池显示兵力与收益**（用户："然后NPC城池点击后，要给提示，给一个大概得兵力水平+预期的受益。"；"守军：共约{0}人，最高{1}及兵，有{2}位首领/群龙无首。"）→ gameplay.md 3.12。`npc-camps` 登记地图图层：选中 NPC 城池的格子时显示等级、"守军：共约 X 人，最高 N 级兵，有 M 位首领 / 群龙无首"、营寨每路防御、获胜收益（据点：最多可掠夺多少资源；要塞：可俘获的各级兵数）。测试补在上一条的测试里。浏览器冒烟（开发服务器）：地图旁列出附近的 NPC 城池，点开"乡勇哨卡（要塞）"显示"1 级 / 守军：共约 6,000 人，最高 1 级兵，群龙无首 / 营寨：每路防御 +40 / 获胜可俘获：1 级兵 ×5"，控制台无报错。
- ✅ 133 **NPC 城池奖励加倍**（用户："NPC城池的攻打奖励有点低，加个零。"；之后"NPC城池的奖励，资源ok, 俘获量再×5"）→ gameplay.md 3.12。`npc-camps/data/levels.csv`：据点的可掠夺资源 ×10（1 级 5,000 … 10 级 1,200,000，仍受幸存部队载重限制）；要塞的俘获量 ×50（1 级 250 个 1 阶兵 … 10 级 3,000 / 2,000 / 1,000 / 250 / 50 个 2–6 阶兵）。地图上 NPC 城池的收益说明直接读这张表。测试 "come in levels 1-10…" 与 "can be raided…" 的数字随之更新。
- ✅ 134 **i18n 全面改为"插件 id.key + 英文 + 中文"**（用户原话："也就是说，所有插件注册的i18n必须是key+英文+中文。key由插件管理，但统一前缀由内核或者i18n自动添加。使得不同插件之间不会key冲突，同一插件由key冲突的话拒绝加载"；"全部改完再发，然后除了key,en,zh-CN,后面还提供可选列（不同的插件可以给自己添加不同的语言），然后i18n预留'翻译插槽'，其他插件可以'注入'自定义翻译，使得社区翻译不需要改官方代码。总之，一次性搞定，不给后面留尾巴。"；"因为1.1.0相对1.0.0是快速修正，目前没人用，就不考虑兼容性，直接改。"）→ development.md 2.6。
  - 表格：每个插件的 `data/i18n.csv` 为 `key,en,zh-CN[,其他语言…]`，用 `i18n.addCsv(csv, ctx.pluginId)` 登记为 `<插件id>.<key>`；同一插件重复的键、缺英文、缺 `en` 列都拒绝加载。原来没有表的 `forms`、`gm`、`http-api`、`i18n`、`starter-shop`、`stats`、`ui` 补了表（至少有插件名 `plugin:<id>`）。
  - 翻译插槽：`i18n.inject(csv)`（列 `key,<语言>…`，key 是完整键）让任何插件增改任何插件的译文、加新语言；两个注入互相矛盾时拒绝加载；注入的优先于插件自带的。
  - 归属：内核 `ctx.caller()`（正在 setup 的插件）；`i18n.own(text)` / `i18n.scope()` 把文字变成调用方插件的键；系统插件的 `define*`（资源、建筑、兵种、道具、科技、秘境、城池类型、属性、英雄属性 / 场所 / 职务、装备部位 / 底材 / 品质、兵系、流寇、地形、页面标签）都用它给名称加前缀，钩子（建筑 / 科技 / 训练的拦截原因、战斗加成来源、地图图层与标记、英雄卡片行、邮件呈现、派兵选项、遭遇说明…）在登记时绑定登记者。`GameError` 新增第 4 个参数 `owner`（293 处用脚本补上），客户端拼成 `<owner>.<message>`；表单按命令所属插件加前缀（含控件字段的数据），视图按 id 的插件加前缀，邮件标题按 kind 的插件加前缀（GM 群发的原样显示）。
  - "是不是键"统一由 `src/shared/i18n.ts` 的 `keyMatcher` 判断：登记过的键、完整匹配某个模式键（`starter-realms.Key to {0}`）、或没有可翻译的字（数字、时长、人名键）；拼出来的文字（"`starter-defense.Wall Lv 3`"）由拼它的插件加前缀、用自己的模式键翻译。客户端与测试共用 `createCatalog`（精确键 + 模式键，捕获的部分先在模式所属插件里找）。报错文字本身已是键（钩子返回的原因）时客户端不再加前缀（只此一处特判，没有"查不到就去掉前缀重试"之类会掩盖缺译的通用回退）。
  - 客户端插件同样各管各的键（用户："为啥还有键值命名冲突？不是约定各插件自己管自己的键吗？"）：`game.messages` 登记为 `@<客户端插件id>.<文字>`，框架自己的词（原 `locale-zh` 插件，移到 `web/core/messages.ts`）为 `@core.<文字>`；组件用 `useGame('<插件id>')` 拿到绑定本插件的 `game`，`t` 依次查本插件、框架、服务端的键（组件会经服务 / 插槽在别的插件里渲染，所以由组件自己声明归属，`scripts/check-i18n.mjs` 检查每个组件写的 id 与所在目录一致）。GM 表单、报表说明的中文从 `gm-panel` 移回拥有它们的服务端插件（报表说明按报表所属插件加前缀）。
  - 查找：模式的占位分别按"尽量短 / 尽量长"两种切法尝试，取所有部分都能翻译的那一种（"`{0} ({1})`"切"弓手（弓兵）招募令 (2)"、"`{0} {1} chest`"切"金色 青锋 套装宝箱"）；所有候选键（本插件、框架、服务端）都先找完整翻译，没有才用部分翻译，宽泛的模式（"`{0}, {1}`"）不会抢走有自己译文的文字。系统插件拼接别人名称的选项文字（"`名称 (数量)`""`科技 (Lv x/y)`""`城池 (x, y)`"）显式加上自己的前缀。
  - 顺带修正：训练表单的费用原来写资源 id（"5 stone"），改为资源图标；研究运行时节点的效果名用被修改的属性的说明；宝箱 / 商品类别用最先使用该类别的插件的键；GM 后台的插件名与规则说明按新键查找。
  - 检查：`pnpm check` 新增 `scripts/check-i18n.mjs`（每个 `new GameError` 的文字必须是所属插件 CSV 的键，内核的在 `locale-zh`；305 条，补了约 200 条中文）；测试 "translations (i18n)" 改写（按插件分命名空间、可选语言列、重复键 / 缺英文拒绝、内容名称归定义者、翻译插槽与冲突），新增 "cover every text a player sees"：一个建了建筑、研究了科技、拥有全部道具、招了英雄、打了 NPC、去了秘境的账号，遍历全部视图、各处表单（含每种建筑入口）和 meta，每段要显示的文字都能译成中文。其余测试的期望值改为带前缀的键。
  - 文档：`docs/development.md` 新增 2.8 节"多语言"，AGENTS.md、插件开发指南、插件清单同步。浏览器冒烟（`vite preview` + 临时库）：全部页面、建筑入口、GM 控制台（玩家 / 规则 / 报表 / 审计）都是中文，没有残留的插件前缀，控制台无报错；冒烟中发现并修好的：两个前端插件对 `limit` 译文不同（促成前端插件改为各自命名空间）、宽泛模式 `{0}, {1}` 抢走道具说明、城池切换器和审计表头的文字。
- ✅ 135 **改密码；GM 首次登录必须改密码**（用户原话："还有一个任务，每个账号可以自己改自己的密码，GM首次登录后要求改密码。这样初始gm账号-密码信息就可以按默认值分发，而无需用户改docker_file重新构建，镜像下下来就能跑"；"GM在登录的待遇上要和普通用户保持一致哦。系统变量仅制定初始密码。"；"Password: 8-128 characters别忘了，这个worning也要i18n哦"）→ development.md 2.7。
  - `accounts_users.must_change` 列（在基线 `0001_init.sql` 里，见 139）。GM 登录与普通账号相同，校验库里的哈希；GM 账号不存在或还没有密码（1.0.0 建的 GM 账号就是这样）时，用 `GM_PASSWORD` 登录会存下哈希并标记必须改密码，之后环境变量不再起作用。标记了的账号不能玩：游戏接口（`session.resolve`）返回 403 `password_change_required`；GM 接口照常可用——首次运行的地图导入要以 GM 身份调用 GM 接口，而那时还没有人改过密码（用户在"一次性内部令牌 / 改密码前放行 GM 接口 / 改完密码后再导入"中选了"改密码前放行 GM 接口"）。
  - 新接口 `POST /api/auth/password` { oldPassword, newPassword }（`ChangePasswordRequest`）：当前密码错、新密码不是 8–128 个字符、与当前相同都拒绝；改后该账号的其他会话失效。`User.mustChangePassword`。所有提示都有中文。
  - 前端：必须改密码时整个界面换成改密码页（`auth` 插件的 `PasswordScreen`）；平时用户名旁有"修改密码"，展开小表单（当前密码、新密码、再次输入；两次不一致在前端提示）。
  - AGENTS.md"账号、权限与 GM"、部署文档、README 同步。测试：`test/api.spec.ts` "passwords"（GM 用初始密码登录后游戏接口 403、GM 接口可用、错误的当前密码 / 太短 / 相同被拒、改后可用、初始密码失效；普通账号改密码后另一处会话失效、旧密码失效、未登录 401），测试用的 `loginGM` 首次登录后自动改密码。浏览器冒烟（临时库里 1.0.0 建的 GM 账号）：初始密码登录后只显示改密码页，两次不一致有提示，改后进入游戏；用户栏"修改密码"再改回，提示"密码已修改"，控制台无报错。
- ✅ 136 **文档清理：只留现状和未来**（用户原话："注意，文档还没完全清理干净。只留现状和未来。`取代现在的\"金币\"`类的说明不要"；"（建筑名称已确认，可以随时再改。） 这些也不要"；"'改为按路计算' 这类也要记得清理哦。"）。gameplay.md 删掉第 13 节"与现有实现的差异"（整节是与旧代码的对比；仍在规划的充值、免战牌 / 招贤榜 / 迁城令在第 11 节已有），资源表去掉"新增 / 取代金币"列，删去"已确认""最初按……后来改为""原来……2026-10-01 修正""1.0.0 之前""迁移前的行囊"等沿革与确认过程说明，"暂按……（用户已确认）"的条目改为直接陈述，三座兵营共用造价表的暂按移到兵营一节；ui.md、development.md、AGENTS.md（迁移基线的来历）同样只留现状。用户原话作为设计依据保留。
- ✅ 137 **CI/CD 与 Docker 自托管**（用户原话："都完成之后再帮我设计一下CI/CD, release的内容要能够提供用户直接docker部署的权限。发布1.1.0。"）→ deployment.md 第 6、7 节，README。
  - `.github/workflows/ci.yml`：推送到 `main` 与 PR 时跑 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build`。
  - `.github/workflows/release.yml`：推送 `vA.B.C` 标签时依次：检查；用 buildx 构建 amd64 / arm64 镜像，推到 `ghcr.io/<仓库>`（标签：版本号、`A.B`、`latest`）；建 GitHub Release（`docker run` 用法，附 `docker-compose.yml`）。
  - `Dockerfile`：node:24-bookworm-slim（workerd 需要 glibc），先装依赖再拷代码，构建生产版本。卷 `/data`，端口 4173。自带默认 GM 账号 `gm` / `wargame-gm`，只是初始密码，首次登录必须改（见 135），所以镜像下下来就能跑。另有 `.dockerignore`、`docker-compose.yml`。
  - `scripts/dev.mjs` 新增 `--serve`（`pnpm start`）：
    - 用 `vite preview` 跑生产构建，把 `GM_USERNAME` / `GM_PASSWORD` 写进构建产物旁的 `dist/wargame/.dev.vars`（`vite preview` 读的是构建时拷过去的那份，写根目录的不起作用）；
    - `WARGAME_MAPS_DIR` 指定地图目录；
    - 首次启动（容器里没有终端）用最新的地图，没有就生成一张，然后以 GM 身份导入并放 NPC。
  - 验证：本机没有 Docker，镜像由发布流程在 GitHub 上构建。用全新的数据目录和地图目录直接跑容器里的命令 `node scripts/dev.mjs --serve`：建表、生成地图、导入地形、逐块放 NPC（6233 座要塞、6052 座据点）都成功；默认 GM 登录后游戏接口 403、GM 接口可用，改密码后可以玩；后台任务照常运行（`vite.config.ts` 的 `localCron` 对 `vite preview` 同样生效）。
- ✅ 138 **发布 1.1.0**（用户："都完成之后再帮我设计一下CI/CD, release的内容要能够提供用户直接docker部署的权限。发布1.1.0。"；"全部改完再发"）：版本号 1.0.0 → 1.1.0。包含 changelog 129–137：迁移合并为基线、首次运行自动处理地图、NPC 初始密度与点开提示、NPC 奖励、i18n 按插件命名空间（含翻译插槽、前端插件命名空间、静态检查）、改密码与 GM 初始密码、文档清理、CI/CD 与 Docker。已有的 GM 账号（1.0.0 建的，没有密码哈希）下次用当时的 `GM_PASSWORD` 登录后需要改密码。
- ✅ 139 **只留一个 SQL、gameplay 去掉用户原话**（用户原话："保持sql干净,这个版本只留一个sql。文档还不是很干净。gameplay里还有用户原话。"）。`0002_accounts_password_change.sql` 合并进 `migrations/0001_init.sql`（`accounts_users.must_change`），基线注释改为"当前版本的全部表结构"；AGENTS.md 改为"一个版本只有一个基线，发布后的改动从 `0002` 起"。已经应用过旧基线的本地库要重建（`.data/local` 等）。gameplay.md 删去全部用户原话（约 60 处括号引文、第 12 节开头两段原话、"由用户口述"的说明、"用户已拍板的决定"改为"布局与规则"），英雄数值目标等改写为直接陈述；ui.md、部署文档、插件开发指南里的原话也一并删去。
- ✅ 140 **发布 1.1.1**（用户在"原地重发 1.1.0 / 发 1.1.1 / 只提交到 main"中选了"1.1.1"）：包含 139（迁移只留基线 `0001_init.sql`、文档去掉用户原话）。从 1.1.0 升级的库已经有 `0002_accounts_password_change` 加的列，1.1.1 不再带这个文件，wrangler 只会把它当作已应用的历史记录，不影响；新库直接由基线建好。
- ✅ 141 **去掉重复的本地定时触发**（架构评审中发现）：1.1.0 在 `scripts/dev.mjs` 里加了每分钟调用 `/cdn-cgi/handler/scheduled`，但 `vite.config.ts` 的 `localCron` 插件早已对开发与预览服务器做同一件事（2026-10-01 加的），结果后台任务每分钟跑两次（NPC 据点每分钟补 10 座而不是 5 座）。删掉 `dev.mjs` 里的那份；更正 137 里"之前本地和自托管都没有后台任务"的错误说法。
- ✅ 142 **架构评审与仓库查重**（用户原话："这次i18n的改动说明前期做好架构设计是很有必要的。推完1.1.0之后再评审一下当前架构的优势和劣势，以及你在开发过程中反复踩了哪些坑，有哪些通过优化架构可以解决。代码仓库的'内部查重'如何，有没有大量'各写一套'的问题。"）→ architecture.md 第 3 节。用 6 行窗口查重（去掉空白、注释、import）：17,800 行里重复块约 300 行（1.7%）；"各写一套"主要是写法不同的同类代码（107 处手写参数校验、"No such hero"5 个插件各一份且译名不一致、共享格式化工具没人用、13 处手拼人名、本地定时触发两份）。列出 8 条改进建议（结构化文字、插件报错工厂、声明式参数校验、实体由拥有者校验、格式化收口、基础设施一处化与仓库内冒烟脚本、测试拆分与按结构断言、查重进 CI），等用户决定。顺带：用户的本地库按新基线清空重建（用户："帮我清空重建一下数据库"），architecture.md 第 2 节删掉已过时的"玩家不能改密码"。
- ✅ 143 **改名表单显示翻译键**（用户截图："i18n还是有问题"：改名表单的输入框里是 `player-settlements.Capital`）。没改过名的城池，名称是城池类型的翻译键，表单却把它当默认值填进文本框（值不经翻译，提交还会被存成名字）。`settlements.rename` 的表单：名称是翻译键时文本框留空，说明行写"当前名称：首都"（新键 `Current name: {0}`）；改过名的照旧以原名为默认值。i18n 完整性测试新增一条：文本框的默认值不能是翻译键（修复前该测试能复现这个问题）。浏览器冒烟：说明行"当前名称：首都"、输入框为空，控制台无报错。
- ✅ 144 **F：基础设施一处化，冒烟测试进仓库**（1.2.0；用户："A-G似乎都不涉及数据库和关键插件的api问题，统一开始做吧。放到1.2.0里去。"；"也别写兼容性新增了，目前项目还在冷启动阶段"）。本地定时触发只留 `vite.config.ts` 的 `localCron`（141）。新增 `pnpm smoke`（`scripts/smoke/run.mjs`；开发依赖 `@playwright/test` 1.63）：
  - 准备：临时库、建表、生产构建；临时 GM 账号写进 `dist/wargame/.dev.vars`；空闲端口上启动 `vite preview`。
  - 流程：走首次登录强制改密码；发资源、道具、兵；把 GM 规则 `buildings.speed` 调到极快，建齐各类建筑；逐页、逐个建筑入口（12 个）、GM 后台各页打开。
  - 报告：控制台 / 页面错误、残留的插件前缀、中文界面里的英文单词。`<code>` / `<pre>` 里的技术文本和用户名不算。

  它第一次运行就发现：
  - GM 后台"邀请码"页的文字是写死在模板里的英文（已改为翻译）；
  - 时间按浏览器语言显示成英文格式：`formatTime` 改为按游戏语言，邮件时间也改用它；
  - 审计页的操作类型显示原始 id，加了中文名称（`audit:<操作>`）。

  部署文档写明 `.dev.vars` 的两个位置（`pnpm dev` 读根目录，`vite preview` 读 `dist/wargame/`）；HANDOFF"怎么验证"、开发文档 3.4、AGENTS.md 改为用 `pnpm smoke`。

- ✅ 145 **E：格式化收口**（1.2.0）。`src/shared/format.ts` 新增 `whole`（向下取整、千分位）与 `signed`（带正负号，真正的减号）；删掉 prestige / shop 的 `whole`、research 的 `signed`、troops 自拼的费用文字（改用 `amounts`），starter-heroes 的加成用 `signed`。人名：发给前端的一律是名字键（`s:Wang m:Rui`，前端按语言拼写），heroes 新服务方法 `nameKey(hero)` 产出它，13 处手拼的 `${surname} ${given}` 都改用它；把名字在服务端拼成英文的 `nameOf` / `setNameFormatter`（starter-heroes 注册）删掉——它只被 realms 的 GM 加速表单用过，结果中文界面里显示拼音（一并修好）。一开始误把手拼处换成 `nameOf`，i18n 完整性测试当场报出 9 处英文名。`scripts/check-i18n.mjs` 更名 `scripts/check.mjs`（`pnpm check:static`），新增三条规则：插件 / 组件里不许 `toLocaleString`、不许手拼人名（用 `heroes.nameKey`）、`.vue` 模板里不许直接写英文；它立刻找出审计页的"Nothing yet."（已改为翻译）。AGENTS.md 前端一节写明"格式化只用共享模块"。
- ✅ 146 **D：实体由拥有者校验**（1.2.0）。heroes 新服务方法：
  - `requireOwned(api, playerId, heroId)`：英雄不存在就报"没有这位英雄"；
  - `requireFree(hero)`：职务不能随时离开就报"英雄正忙"。

  这两句报错都只由 heroes 发出。equipment 新增 `createOrRefuse`：存放处满时报"本城放不下了"，归 equipment 自己。改动的插件：
  - equipment、realms（3 处）、starter-items、starter-heroes 改用 `heroes.requireOwned`；
  - starter-equipment 的宝箱和秘境商店改用 `equipment.createOrRefuse`；
  - buildings / troops 的 GM 命令改用 `settlements.requireOwned`。

  删掉 7 份重复的译文行。原来不一致的译名统一为：存放处"本城放不下了（建武库可以多存）"（原另一份写作"兵器库"），"该英雄正在担任其他职务"。新测试："about another plugin's entity come from that plugin"，在三个插件的命令里引用不存在的英雄，报错都是 heroes 的。

- ✅ 147 **B：插件报错工厂**（1.2.0）。内核新增 `gameErrors(owner)`：每个插件文件顶上 `const fail = gameErrors('<插件id>')`，之后 `throw fail(code, message, status?)`。用脚本把插件和示例里的 285 处 `new GameError(…, '<id>')` 全部换掉（状态码 400 的省略）；research / starter-research 里原来叫 `fail` 的校验小函数改名 `invalid`。`scripts/check.mjs` 改为只认 `fail(…)`：所属插件取自文件顶上的 `gameErrors`，并核对它与所在目录的插件一致；插件里再写 `new GameError` 直接报错（临时改坏一条消息时，检查当场报出）。AGENTS.md、开发文档 2.8、插件开发指南同步。
- ✅ 148 **C：声明式参数校验**（1.2.0）。内核新增 `src/kernel/fields.ts`：
  - `fields`（`id`、`text`、`int`、`number`、`bool`、`oneOf`、`list`、`record`、`object`、`optional`、`orElse`、`raw`）与 `shape(spec, refine?)`；
  - 报错统一是内核的 `bad_payload`，用字段路径点名（"units.spearman must be a whole number from 0 to 1000000000"），译文在 `web/core/messages.ts`；
  - 表单的数字字符串算数字，空串 / null 算缺失，`a.b` 形式的扁平字段自动展开成嵌套对象。

  全部 60 个命令、约 20 个道具使用命令、出兵指令 `armies.parseOrder`、运输 / 筑城 / 带兵英雄三个扩展钩子、三个 GM 报表的参数都改用它，手写的 `parse` 全部删掉。research 注册节点的表单字段 `cost:<资源>` 改为 `cost.<资源>`。元宝发放仍按设计舍去小数（`refine` 里截断）。

  删掉 55 条不再使用的报错译文和 settlements / starter-items / equipment / npc-camps 里的旧解析辅助函数。tsconfig 打开 `noUnusedLocals`，改写留下的无用导入、变量会被类型检查拦下（顺带清掉 9 处）。测试：内核 "command payloads (fields, shape)"（类型、默认值、扁平字段、各种拒绝及其文字）；3 个测试的期望改为新的统一文字。

- ✅ 149 **编码规范与复用登记表**（用户原话："你后面把新加进来的编码规范写入agents.md， 有必要的话可以要求后面的agents新写函数的时候，必须检查已有的共享函数，甚至可以维护以一个表，供等级'我在xx模块写了这个函数，我觉得它可能会被其他模块用到，你们未来要复用的时候搂一眼，用得到就顺手放进共享模块里，别各写一套了'"）。新文档 `docs/shared-code.md`：
  - 第 1 节：已有的共享模块各管什么；
  - 第 2 节：候选登记，先登记了 4 条：D1 按 100 个一批查询、下拉框组合值的拆分、"城池名 (x, y)"标签、地图脚本里的种子随机数；
  - 第 3 节：已经收进共享模块的，记录去向。

  AGENTS.md 新增"代码风格与复用"一节：写新函数前先查登记表，可能复用的函数要登记，第二处要用时挪进共享模块；共享代码放哪；`pnpm check` 会拦下的固定写法。文档分工表加上 `docs/shared-code.md`。

- ✅ 150 **G：测试按系统拆分**（1.2.0）。`test/game.spec.ts`（4,100 行）用脚本拆成 `test/game/` 下 10 个文件：city、map、research、items、army、battle、mail、heroes、rules、i18n。公共部分放进 `test/helpers.ts`：数据库、`T0`、内核、测试兵种、`player`、`inner` / `outer` / `inbox`。每个文件只导入自己用到的东西（`noUnusedLocals`）。159 个测试照常通过，现在是 13 个测试文件。约 70 处比对显示文字的断言留到 A：那些字段在 A 里会变成结构化文字，届时直接改成按结构断言，避免改两遍。AGENTS.md、开发文档、插件开发指南的测试约定同步，并写明断言优先比对 id / 数值 / 结构。

- ✅ 151 **A：结构化文字**（1.2.0，用户原话："A-G似乎都不涉及数据库和关键插件的api问题，统一开始做吧。放到1.2.0里去。""也别写兼容性新增了，目前项目还在冷启动阶段"）。服务端发给前端、要显示的文字一律是 `UiText`：`{ text: '<插件id>.<key>', vars? }`。变量要么是值（数字、数量、玩家输入的名字、英雄名字键），原样显示；要么本身是 `UiText`，先翻译再填入。前端只按键精确查找，不再猜。
  - 共享工具（`src/shared/i18n.ts`）：`uiTexts(owner)` → `text(key, vars?)`、`keyText(key)`、`literal(s)`。删掉 `keyMatcher`、`neutral`、`mapUiTexts`、`createCatalog`（模式反查、短切 / 长切），以及前端按视图加前缀的 `web/core/owned.ts`。`i18n.isKey` 改为精确匹配，`web/core/i18n.ts` 只做精确查找。
  - 接口变化：
    - 加成来源、伤亡钩子来源、建造 / 研究 / 训练门槛与要求、职务与行军目的的检查、`settlements.foundable`、行军报告备注 `note`、来袭者名字 `attackerName`、科技的 `blocked` / `locked`、规则的 `error`、建筑入口标题 `entry.label`，都改为 `UiText`；
    - `stats.define` 的 `description` 可以是 `UiText`（`buildings` 的"{0} level cap"、`resources` 的"{0} production"、`settlements` 的"Max {0} per player"），新增 `percent` 标记，取代"描述以 (%) 结尾"的约定；
    - `mail.send` 的 `title` 是 `UiText`，存为键 + 变量，`MailMessage` 不再有单独的 `vars`；
    - 报错用 `fail(code, 'Message' | text(key, vars), status?)`，原来 72 处模板字符串改成键 + 变量；`fail` 去掉了 `vars` 参数。内核新增导出 `errorText(err)`，buildings、规则校验用它包住别的报错。
  - 新增 `i18n.derive(key, uiText)`：由别的名称拼出来的内容名登记为调用方的键，服务端在下发 meta 时按各语言拼好。用在秘境钥匙（名称和说明）、招募令（名称和说明）、装备宝箱。
  - 顺带修好的错误：
    - 城防器械、工事、装备件、starter-items 道具名在本插件里被当成完整键（`keyText`）；
    - war-reports 的兵种名、目标名、城池名，以及科技队列、英雄卡、秘境报告、地图格子上的名称，以字符串变量传了键；
    - 城区格子的地形名被 `literal` 原样显示成 `terrain.Grassland`；
    - starter-research 规则校验的英文消息放在变量里。
  - 检查：
    - `scripts/check.mjs` 也检查每个 `text('…')` 的键：只有布局的键（`{0} · {1}`）除外，按 id 取的键（``text(`mission:${id}`)``）要求插件有这一类键；
    - 译文完整性测试改为：文字的键必须登记过且有中文，变量里不能是键或英文，`literal` 里不能是键；
    - 新增测试工具 `en(ui)`（`test/helpers.ts`），按英文渲染一段文字，用于看整句的断言。
  - 测试：约 50 个测试的断言改为按结构（键 + 变量）比对。`pnpm check` 通过（159 个测试），`pnpm smoke` 通过。开发文档 2.8 节、AGENTS.md、插件开发指南、共享代码登记、插件清单同步；`docs/design/architecture.md` 第 3 节只留下还没做的 H（查重进 CI）。

- ✅ 152 **拔除外城范围内的 NPC 要塞 / 据点**（用户原话："A-G搞定之后再做一个功能：如果外城的地块有被NPC的要塞/据点占据，可以提供“拔除”的行军类型，5路全胜可以将其从地图中删掉。如果没有5路全胜，则按正常的抢资源/抢兵结算。"）。设计写进 gameplay.md 2.7（行军目的表多一行"拔除"）。
  - 新行军目的 `uproot`，地图格子上的表单"拔除"（命令 `npc-camps.uproot`）。只在 NPC 营寨位于玩家某座首都 / 分城的外城范围内时出现：以内城为中心的 5×5，外城最多能建到的地方，不要求紧挨已有城区。
  - 到达时照常交战、照常掠夺 / 俘获。五路全胜时把营寨从地图上删掉：格子、城区、城池、等级行都删除，战报备注"已拔除，地块空出"。否则按普通攻打结算。
  - 五路全胜也照常掠夺 / 俘获；被拔除的营寨由后台任务按全图数量在别处补上。范围、掠夺和进 1.2.0 都已经由用户确认（"你的处理都没问题，放进1.2.0."）。
  - 接口：
    - settlements 新增 `remove(api, id)`（调用方先 `api.lock`）、`onRemoved(listener)`、`outerArea(settlement)`。同一次调用里删掉的城池，`get` 立即返回 null。
    - armies 的任务名改为定义它的插件的键（`mission:<id>`，各插件自己的 CSV），新增 `missionName(id)`。war-reports 的任务标签改用它，不再自带 `mission:settle`。
  - 顺带修好：
    - 行军列表的"任务 · 阶段"以字符串变量传了键和英文；
    - 来袭警报、行军标题的城池名不是 `UiText`；
    - 筑城表单的费用写成"500 gold"，现在用图标 + 数量。
    - 译文完整性测试多看一遍"行军中、英雄冒险中"时的全部视图，原来只在军队回城后看，漏了这些。
  - 测试 "uprooting NPC camps"：
    - 只有外城范围内的营寨有表单，范围外和非 NPC 目标被拒；
    - 打不过时营寨留着；
    - 五路全胜删掉营寨和它的等级行，俘获照常；
    - 两支军队同时到达、两条命令并行，只拔除一次，另一支报"营寨已经不在了"。

  `pnpm check`（161 个测试）、`pnpm smoke` 通过。

- ✅ 153 **文档与代码对齐**（用户原话："检查一下各类文档是否已经和最新的代码更新了"）。用脚本把文档里引用的函数、服务、路径和代码逐个对照，再人工看了 i18n、测试、行军相关的段落。改了：
  - AGENTS.md 去掉早已不存在的 `generators` 插件，示例改用 `buildings.define` / `buildings.rules` / `buildings.place`；`buildings.addGate` 返回 `UiText`。
  - gameplay.md 3.7 的实现说明改为现在的 `battle.addModifier` 与战报 `modifiers`（原来写的 `troops.addPowerModifier`、`armies.addAttackModifier`、`attackFactors` 都已不存在）。行军报告和 NPC 城池两处补上"拔除"。拔除的取舍已由用户确认，去掉"暂按"。
  - ui.md 的文字说明改成结构化文字（原来写的是"前端按视图所属插件加前缀"）。
  - development.md 2.2 补一句内核导出的工具；3.4 写明断言按键 + 变量比对、`en(ui)`。
  - plugin-guide 的菜谱更新：`mail.send` 的标题、门槛的返回值、战斗加成的 `source`、行军任务名的键、`settlements.remove`；测试一节改用 `pnpm smoke`。
  - 插件清单和代码里的插件一一对上。

- ✅ 154 **拔除的出征表单**（用户原话："拔除的出征UI不对"，附截图：拔除表单没有阵列，只有一个兵种数量框，而且和旁边的"出征攻打"表单并排时被拉高、各行之间留着大片空白）。
  - 阵列：阵列选项原来写死只用于 `attack`。现在任务可以标 `battle: true`（到达后要交战：攻打、拔除），附加选项标 `forBattle: true` 就用于所有这类任务；battle 插件的阵列改用它，所以 battle 不用知道有"拔除"。
  - 布局：通用表单（`DynamicForm.vue`）加 `align-content: start`，和更高的表单并排时各行不再被拉开。
  - 测试：拔除表单的阵列字段与攻打表单相同。`pnpm smoke` 多看一处：在首都旁放一座 NPC 要塞，在地图上选中它，检查格子上的表单（攻打、拔除并排，截图）里没有残留的前缀和英文，并且有"拔除"。

- ✅ 155 **发布 1.2.0**（用户原话："好的，发布1.2.0吧。"）：版本号 1.1.1 → 1.2.0（B 级：改了插件代码和接口，没有存档迁移，表结构仍是基线 `0001_init.sql`）。包含 changelog 141–154：
  - 架构评审 A–G：结构化文字、插件报错工厂、命令参数的声明式校验、实体由拥有者校验、共享格式化、基础设施收口与 `pnpm smoke`、测试按系统拆分；
  - 编码规范与共享代码登记；
  - 拔除外城范围内的 NPC 营寨，以及它的出征表单；
  - 文档与代码对齐。

- ✅ 156 **发布流程里的测试在慢机器上失败**：推送 `v1.2.0` 后 Release 工作流的 `pnpm check` 有 3 个测试失败（同一提交的 CI 通过），镜像和 Release 都没有生成。
  - i18n 完整性测试现在要读两遍全部视图，超过了 vitest 默认的 5 秒，改为 30 秒；
  - `test/api.spec.ts` 两处粮食数量用"接近 500（误差 0.5）"断言，但 HTTP 测试用真实时钟，慢机器上多产出了 0.5 以上，改为"500 到 510 之间"。

- ✅ 157 **GitHub Actions 的警告**（用户原话："搂一眼github的报告"）。报告里的 4 个错误是第一次推送 `v1.2.0` 时那 3 个测试（见 156），重新打标签后 check / image / release 都已通过。另外的警告"Node.js 20 is deprecated"来自 `actions/checkout@v4`、`actions/setup-node@v4`、`pnpm/action-setup@v4`，升级到 `checkout@v7`、`setup-node@v7`、`action-setup@v6`（都跑在 Node 24 上；查过它们的大版本说明，不影响我们用到的输入）。"ubuntu-latest 将在 2026-10-19 起换成 Ubuntu 26"只是通知，暂不处理（Node 24 + pnpm 在新镜像上照常可用）。
