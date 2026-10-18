# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `docs/development.md`，部署与运维在 `docs/deployment.md`，规划中的架构和已知限制在 `docs/design/architecture.md`，插件开发指南在 `docs/plugin-guide.md`。约定见 `AGENTS.md`。

更新于 2026-10-18。

## 1. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、静态检查、230 个测试），`pnpm smoke` 通过。自托管：`docker run -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame`（deployment.md 第 6 节）。代码在公开仓库 <https://github.com/xczics/wargame> （`main`）。**1.3.3 已发布**（标签 `v1.3.3`，2026-10-18：数值梳理、连续冒险与行囊、一键集合、遣散部队、会话清理，见 `docs/releases/1.3.3.md`）；之前 **1.3.1**（标签 `v1.3.1`，2026-10-03：性能修复、营寨预播种与补回、按需加载、操作的"进行中"提示，见 `docs/releases/1.3.1.md`）；**1.3.0**（标签 `v1.3.0`，2026-10-03：掉落算法 `loot`、队列 `queues`、科技解锁节点、加成按来源显示、生产表、新道具、用量日志等，见 `docs/releases/1.3.0.md` 与 changelog 164–198）。发布流程在 GitHub Actions 上构建 Docker 镜像 `ghcr.io/xczics/wargame`（amd64 / arm64）并建 Release；每次推送到 `main` 由 CI 跑 `pnpm check` 与构建。之后的版本号按 AGENTS.md"版本号与发布"递增。项目以 GPL-3.0-only 发布（`LICENSE`）。
- 玩法已实现 gameplay.md 第 1–12 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑、科技树、秘境、装备、商城与道具、声望与流寇）；"暂按……实现"的取舍写在 gameplay.md 对应条目里。最近的改动：`docs/changelogs/2026-10-17-user-notes.md`、`2026-10-18-user-notes.md`。
- 界面由后端声明、几乎全部由通用控件画出（`web/widgets/`，`docs/design/ui.md` 第 3 节）；剩下的前端插件只有外壳、`widgets`、邮箱 `mail` 和 GM 后台；第三方扩展放进 `extensions/`，两端自动发现（示例在 `examples/`）。
- 数据库迁移：基线 `0001_init.sql`，1.3.0 新增 `0002_queues`、`0003_items_pity`、`0004_heroes_refresh`，1.3.2 `0005`、`0006`，1.3.3 `0007_npc_camps_refill`、`0008_accounts_sessions_expires`、`0009_pvp_drop_reports`；之后从 `0010` 起。用量日志的表 `usage_periods` 不在迁移里（只在开了 `USAGE_LOG` 的本地 / Docker 由运行时创建）。
- 多语言：每个插件只管自己的键（`<插件id>.<key>`，前端插件 `@<id>.<文字>`），CSV 为 `key,en,zh-CN[,…]`，翻译插槽 `i18n.inject`；要显示的文字一律是结构化的 `UiText`（键 + 变量），前端只按键精确查找（development.md 2.8）。账号可以改自己的密码；GM 的 `GM_PASSWORD` 只是初始密码，首次登录必须改（development.md 2.7）。
- 用户的本地存档：开发期的数据库已全部删除，现在是干净库；用户 2026-10-02："现在都是干净的数据库，你可以随时清空重建"。生成好的地图在 `.data/maps/`；`pnpm dev` 首次运行时自动选择 / 生成并导入地图（`scripts/dev.mjs`）。
- 本地开发 / 预览服务器监听 `0.0.0.0`（局域网可访问），端口 `5173`（dev）/ `4173`（preview）。

## 2. 待办

按顺序做；做完一条，把记录写进 `docs/changelogs/` 当天的文件，并从这里**删掉**。引号里是用户原话。

**1.3.2 已发布（changelog 249）之后接着做**：

1. **每个页面拆成"不变的只发一次"和"会变的只在变了时发"**（用户 2026-10-05："所有页面都要拆哈。"；"其他每个页面也都查一下，每次更新只传变化量。"；"但是'重复比较'的任务不能每次在服务端做哦，要在写代码的时候就想好，到底什么数据是变化的，什么数据是不变的。"——已写进 AGENTS.md 性能原则；做法见 development.md"不变的只发一次""会变的也只在变了时发"）。
   - 已完成（changelog 236–248）：秘境、科技、聚宝阁、秘境商店、资源池、城池页（定时同步 1.2 KB）、英雄页（1.3 KB）、道具（1.0 KB）、道具快捷卡片、军队页、meta 按版本长期缓存。
   - 地图页切换已合成 1 个状态请求，登录后不再整页重载（changelog 264、265）。
   - **请求数**（用户 2026-10-05："不要因为视图拆分浪费太多的请求数"）：每页拆完用 `pnpm requests <地址>` 实测到达 Worker 的请求数，定时同步保持每次 1 个 `/api/state`。
   - 离线玩家的后台开销已测（changelog 247）：每个离线玩家每分钟 1 行读、0 行写。
   - **全部拆完后写复盘**（用户 2026-10-05："等你都做完了之后，总结一下今天的坑，然后盘一下哪些是本可以在游戏设计一开始就考虑好的（而不是现在修），另外有没有哪些关键能力应该进核心/共享函数库。"）。

**用户留言（2026-10-05，`humannotes.md`）**：玩法、内容与界面。和上面的性能项一起做，版本号发布时按改动定。

**1.3.3 之后留下的数值问题**（1.3.3 已发布，过程见 changelog 2026-10-05 第 250 条起、2026-10-06、2026-10-17）：

- 后期数值（第 262 条）是按上一轮一年模拟估算的，没有复跑；以后要验证时先用 30 天短跑（`test/sim/month.sim.ts`），一年模拟写盘太重（第 261 条）；
- 还没核对：玩家互打、元宝经济、英雄任职加成。

**1.4**（用户 2026-10-17："那就只有地形仅R2, 营寨走规则计算。这个决定你细化到1.4的开发计划里去。"；"1.4 还引入新的系统插件：拼图碎片系统 和 不透明科技树系统"）。完整计划见 architecture.md 1.1、1.6–1.8，按顺序做：

1. R2 绑定；`staticStore` 的 R2 实现；meta 在构建时生成成静态资源（1.7）。
2. 地形改为一个带版本号的文件，只放 R2：导入直接写 R2，服务端每个 isolate 读一次放内存，浏览器整张取、长期缓存，GM 改地形换版本，`pnpm map:export` 给已有世界用（1.6 A）。
3. `worldMap` / `settlements` 加虚拟来源的扩展点（1.6 B）。
4. 营寨按规则算出：共享函数、例外表、去掉分批播种、补回改为随机补出真实营寨、GM 放营寨、新手营寨的兼容（1.6 B、C）。
5. 核对查询预算、离线开销、冒烟、请求数；数一遍新地图导入的 D1 写入（营寨、地形都应为 0）。

6. 拼图碎片（新系统插件 `puzzles` + 接线插件 `starter-puzzles`）：`loot` 的地点目录 / 独立概率 / 数据驱动掉落，GM 上传与掉落设置，碎片与兑换，道具页"拼图"类别，听曲楼的拼图界面（architecture.md 1.8，gameplay.md 第 13 节）。规则已和用户确认（价值、重复碎片换资源、兑换上限）。
7. 不透明科技（新系统插件 `opaque-research` + 接线插件 `starter-opaque-research`）：256 维隐藏值、驻守研究所的英雄提出申请书、首都双清观里批准、冲刺 + 填平分配、函评成功率（architecture.md 1.1，gameplay.md 第 14 节）。规则都已和用户确认。

已确认（用户 2026-10-17）：拔除后随机补出一座真实营寨；GM 改地形改为整份文件换版本（1.6 D）。

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟：`pnpm smoke`（`scripts/smoke/run.mjs`）。用临时库和临时 GM 账号跑生产构建，逐页、逐个建筑入口、首都旁一座 NPC 要塞的地图格子（攻打 / 拔除表单）、手机宽度下的用户菜单、GM 后台各页打开，报告控制台错误、残留的插件前缀和未翻译的英文；截图在它打印的临时目录里。`--keep` 让服务器留着，可以接着手动看；`--no-build` 复用 `dist/`。不会碰 `.data/local`。
- 要手动推进时间：军队到达、流寇来袭等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }`（或 `settlement:<id>`、`bandits:<玩家>`）；流寇可以用 GM 命令 `bandits.spawn` 立即派出；也可调 GM 规则 `armies.speed` / `buildings.speed` 加快；秘境冒险可以把 `realms.rules` 的 `groupSeconds` 调到 1–2 秒。
