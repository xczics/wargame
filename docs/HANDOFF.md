# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `docs/development.md`，部署与运维在 `docs/deployment.md`，规划中的架构和已知限制在 `docs/design/architecture.md`，插件开发指南在 `docs/plugin-guide.md`。约定见 `AGENTS.md`。

更新于 2026-10-19。

## 1. 状态

- **线上**：用户自己的域名（Cloudflare Workers 免费计划；部署配置在本地的 `wrangler.production.jsonc`，不进仓库；D1 `wargame-db` 在亚太区，Worker 固定在数据库旁边运行；R2 `wargame-files`，有公开文件域名；后台任务每 10 分钟），2026-10-19 首次部署，新世界，已更新到 1.5.0。部署见 deployment.md 第 5 节（`pnpm setup:cloudflare`）。线上 CPU（2026-10-19 晚）：状态同步中位数 6–12 ms，建造等命令 30–45 ms（免费计划每次 10 ms，偶尔超出可以）。待办：观察几天按小时的 CPU 分位数（控制台 Metrics 或 GraphQL `workersInvocationsAdaptive`），看有没有 1102；命令若仍持续超标，再减少命令里的读取或考虑付费计划（用户决定）；定时任务压进 10 ms 后可改回每分钟。
- `pnpm check` 通过（tsc、vue-tsc、prettier、静态检查、290 个测试），`pnpm smoke` 通过。自托管：`docker run -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame`（deployment.md 第 6 节）。代码在公开仓库 <https://github.com/xczics/wargame> （`main`）。**1.5.0 已发布**（标签 `v1.5.0`，2026-10-19：Cloudflare 部署与一条命令部署、R2 用量保护、规则缓存、只重算受影响的视图、派生数值存储、城池页空白等修复，见 `docs/releases/1.5.0.md`）；之前 **1.4.1**（标签 `v1.4.1`，2026-10-19：测试反馈的性能、数值、bug 与新功能，见 `docs/releases/1.4.1.md`）；之前 **1.4.0**（标签 `v1.4.0`，2026-10-18：R2 文件存储、地形一个文件、营寨按规则放置、拼图、不透明科技与双清观、用量日志统计 R2，见 `docs/releases/1.4.0.md`）；之前 **1.3.3**（标签 `v1.3.3`，2026-10-18：数值梳理、连续冒险与行囊、一键集合、遣散部队、会话清理，见 `docs/releases/1.3.3.md`）；之前 **1.3.1**（标签 `v1.3.1`，2026-10-03：性能修复、营寨预播种与补回、按需加载、操作的"进行中"提示，见 `docs/releases/1.3.1.md`）；**1.3.0**（标签 `v1.3.0`，2026-10-03：掉落算法 `loot`、队列 `queues`、科技解锁节点、加成按来源显示、生产表、新道具、用量日志等，见 `docs/releases/1.3.0.md` 与 changelog 164–198）。发布流程在 GitHub Actions 上构建 Docker 镜像 `ghcr.io/xczics/wargame`（amd64 / arm64）并建 Release；每次推送到 `main` 由 CI 跑 `pnpm check` 与构建。之后的版本号按 AGENTS.md"版本号与发布"递增。项目以 GPL-3.0-only 发布（`LICENSE`）。
- 玩法已实现 gameplay.md 第 1–14 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑、科技树、秘境、装备、商城与道具、声望与流寇、拼图、不透明科技）；"暂按……实现"的取舍写在 gameplay.md 对应条目里。最近的改动：`docs/changelogs/2026-10-17-user-notes.md`、`2026-10-18-user-notes.md`。
- 界面由后端声明、几乎全部由通用控件画出（`web/widgets/`，`docs/design/ui.md` 第 3 节）；剩下的前端插件只有外壳、`widgets`、邮箱 `mail` 和 GM 后台；第三方扩展放进 `extensions/`，两端自动发现（示例在 `examples/`）。
- 数据库迁移：基线 `0001_init.sql`，1.3.0 新增 `0002_queues`、`0003_items_pity`、`0004_heroes_refresh`，1.3.2 `0005`、`0006`，1.3.3 `0007_npc_camps_refill`、`0008_accounts_sessions_expires`、`0009_pvp_drop_reports`，1.4.0 `0010_terrain_file`、`0011_npc_camps_state`、`0012_puzzles`、`0013_opaque_research`，1.4.1 `0014_mail_broadcasts`、`0016_bandits_protection`、`0017_starter_defense_permanent`、`0018_settlements_task_state`、`0019_engine_versions`（`0015` 未用），1.5.0 `0020_usage_guard_state`、`0021_engine_derived`；之后从 `0022` 起。用量日志的表 `usage_periods` 不在迁移里（只在开了 `USAGE_LOG` 的本地 / Docker 由运行时创建）。
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

**1.4** 的计划（R2、地形文件、规则营寨、拼图、不透明科技）已全部完成并随 1.4.0 发布（changelog 280–288）。

**1.4.1** 已发布（changelog 292–297：性能、数值、升级时按旧规则结算、bug 与显示、邮件附件、个性化、流寇保护、永久防御）。

不在 1.4.1 里（进 2.0.0）："架构优化讨论（这个进2.0.0）：当前是各个插件维护自己的表。优势是各个插件互不打扰，缺点是，有些操作需要读写多个表完成。 是否提取出一个专门的读写表插件，统一维护/优化表格设计？因为插件不需要热插拔。尽量让所有高频/中频操作的读写表格都控制在1行？"——记进 architecture.md 第 2 节待讨论。

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟：`pnpm smoke`（`scripts/smoke/run.mjs`）。用临时库和临时 GM 账号跑生产构建，逐页、逐个建筑入口、首都旁一座 NPC 要塞的地图格子（攻打 / 拔除表单）、手机宽度下的用户菜单、GM 后台各页打开，报告控制台错误、残留的插件前缀和未翻译的英文；截图在它打印的临时目录里。`--keep` 让服务器留着，可以接着手动看；`--no-build` 复用 `dist/`。不会碰 `.data/local`。
- 要手动推进时间：军队到达、流寇来袭等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }`（或 `settlement:<id>`、`bandits:<玩家>`）；流寇可以用 GM 命令 `bandits.spawn` 立即派出；也可调 GM 规则 `armies.speed` / `buildings.speed` 加快；秘境冒险可以把 `realms.rules` 的 `groupSeconds` 调到 1–2 秒。
