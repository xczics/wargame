# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `docs/development.md`，部署与运维在 `docs/deployment.md`，规划中的架构和已知限制在 `docs/design/architecture.md`，插件开发指南在 `docs/plugin-guide.md`。约定见 `AGENTS.md`。

更新于 2026-10-02。

## 1. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、静态检查、161 个测试），`pnpm smoke` 通过。自托管：`docker run -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame`（deployment.md 第 6 节）。代码在公开仓库 https://github.com/xczics/wargame （`main`）。**1.2.0 已发布**（标签 `v1.2.0`，2026-10-02：结构化文字、命令参数声明式校验、共享格式化、`pnpm smoke`、拔除 NPC 营寨等，见 changelog 141–155）：发布流程在 GitHub Actions 上构建 Docker 镜像 `ghcr.io/xczics/wargame`（amd64 / arm64）并建 Release；每次推送到 `main` 由 CI 跑 `pnpm check` 与构建。之后的版本号按 AGENTS.md"版本号与发布"递增。项目以 GPL-3.0-only 发布（`LICENSE`）。
- 玩法已实现 gameplay.md 第 1–12 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑、科技树、秘境、装备、商城与道具、声望与流寇）；"暂按……实现"的取舍写在 gameplay.md 对应条目里。最近的改动：`docs/changelogs/2026-10-02-user-notes.md`。
- 界面由后端声明、几乎全部由通用控件画出（`web/widgets/`，`docs/design/ui.md` 第 3 节）；剩下的前端插件只有外壳、`widgets`、邮箱 `mail` 和 GM 后台；第三方扩展放进 `extensions/`，两端自动发现（示例在 `examples/`）。
- 数据库迁移：只有一个基线 `0001_init.sql`（当前版本的全部表结构）；发布后的改动从 `0002` 起。
- 多语言：每个插件只管自己的键（`<插件id>.<key>`，前端插件 `@<id>.<文字>`），CSV 为 `key,en,zh-CN[,…]`，翻译插槽 `i18n.inject`；要显示的文字一律是结构化的 `UiText`（键 + 变量），前端只按键精确查找（development.md 2.8）。账号可以改自己的密码；GM 的 `GM_PASSWORD` 只是初始密码，首次登录必须改（development.md 2.7）。
- 用户的本地存档：开发期的数据库已全部删除，现在是干净库；用户 2026-10-02："现在都是干净的数据库，你可以随时清空重建"。生成好的地图在 `.data/maps/`；`pnpm dev` 首次运行时自动选择 / 生成并导入地图（`scripts/dev.mjs`）。
- 本地开发 / 预览服务器监听 `0.0.0.0`（局域网可访问），端口 `5173`（dev）/ `4173`（preview）。

## 2. 待办

按顺序做；做完一条，把记录写进 `docs/changelogs/` 当天的文件，并从这里**删掉**。引号里是用户原话。

目前没有待办。还没做的架构改进：H（查重进 CI），见 `docs/design/architecture.md` 第 3 节，等用户决定什么时候做。

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟：`pnpm smoke`（`scripts/smoke/run.mjs`）。用临时库和临时 GM 账号跑生产构建，逐页、逐个建筑入口、首都旁一座 NPC 要塞的地图格子（攻打 / 拔除表单）、GM 后台各页打开，报告控制台错误、残留的插件前缀和未翻译的英文；截图在它打印的临时目录里。`--keep` 让服务器留着，可以接着手动看；`--no-build` 复用 `dist/`。不会碰 `.data/local`。
- 要手动推进时间：军队到达、流寇来袭等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }`（或 `settlement:<id>`、`bandits:<玩家>`）；流寇可以用 GM 命令 `bandits.spawn` 立即派出；也可调 GM 规则 `armies.speed` / `buildings.speed` 加快；秘境冒险可以把 `realms.rules` 的 `groupSeconds` 调到 1–2 秒。
