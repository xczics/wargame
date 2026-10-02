# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `docs/development.md`，部署与运维在 `docs/deployment.md`，规划中的架构和已知限制在 `docs/design/architecture.md`，插件开发指南在 `docs/plugin-guide.md`。约定见 `AGENTS.md`。

更新于 2026-10-02。

## 1. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、i18n 静态检查、156 个测试）。自托管：`docker run -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame`（deployment.md 第 6 节）。代码在公开仓库 https://github.com/xczics/wargame （`main`）。**1.1.1 已发布**（标签 `v1.1.1`，2026-10-02；1.1.0 同日发布，1.1.1 把迁移合并回一个基线、清理文档）：发布流程在 GitHub Actions 上构建 Docker 镜像 `ghcr.io/xczics/wargame`（amd64 / arm64）并建 Release；每次推送到 `main` 由 CI 跑 `pnpm check` 与构建。之后的版本号按 AGENTS.md"版本号与发布"递增。项目以 GPL-3.0-only 发布（`LICENSE`）。
- 玩法已实现 gameplay.md 第 1–12 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑、科技树、秘境、装备、商城与道具、声望与流寇）；"暂按……实现"的取舍写在 gameplay.md 对应条目里。最近的改动：`docs/changelogs/2026-10-02-user-notes.md`。
- 界面由后端声明、几乎全部由通用控件画出（`web/widgets/`，`docs/design/ui.md` 第 3 节）；剩下的前端插件只有外壳、`widgets`、邮箱 `mail` 和 GM 后台；第三方扩展放进 `extensions/`，两端自动发现（示例在 `examples/`）。
- 数据库迁移：只有一个基线 `0001_init.sql`（当前版本的全部表结构）；发布后的改动从 `0002` 起。
- 多语言：每个插件只管自己的键（`<插件id>.<key>`，前端插件 `@<id>.<文字>`），CSV 为 `key,en,zh-CN[,…]`，翻译插槽 `i18n.inject`（development.md 2.8）。账号可以改自己的密码；GM 的 `GM_PASSWORD` 只是初始密码，首次登录必须改（development.md 2.7）。
- 用户的本地存档：开发期的数据库已全部删除，现在是干净库；用户 2026-10-02："现在都是干净的数据库，你可以随时清空重建"。生成好的地图在 `.data/maps/`；`pnpm dev` 首次运行时自动选择 / 生成并导入地图（`scripts/dev.mjs`）。
- 本地开发 / 预览服务器监听 `0.0.0.0`（局域网可访问），端口 `5173`（dev）/ `4173`（preview）。

## 2. 待办

按顺序做；做完一条，把记录写进 `docs/changelogs/` 当天的文件，并从这里**删掉**。引号里是用户原话。

1. **架构评审与仓库查重**（1.1.0 发布后）（用户 2026-10-02："这次i18n的改动说明前期做好架构设计是很有必要的。推完1.1.0之后再评审一下当前架构的优势和劣势，以及你在开发过程中反复踩了哪些坑，有哪些通过优化架构可以解决。代码仓库的'内部查重'如何，有没有大量'各写一套'的问题。"）计划：通读 `src/kernel`、系统插件、`web/core` 与通用控件，列出优势 / 劣势；回顾 changelog 里反复出现的返工（例如 i18n 归属、拼接文字、视图里的原始字符串、组件跨插件渲染、"暂按"后又改）并给出对应的架构改进；用脚本统计重复代码（相似函数、各插件各自实现的 CSV 解析 / 选项拼接 / 时间格式 / 权限校验等），列出可以收进内核或共享模块的部分；结论写成文档（先给用户看，再决定改哪些）。

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟测试**不要用 `.data/local`**：
  1. `pnpm exec wrangler d1 migrations apply DB --local --persist-to <临时目录>`
  2. `pnpm build && WARGAME_DATA_DIR=<临时目录> pnpm exec vite preview --port <端口>`
  3. 用 Playwright 操作：借用 `~/code/knowmap` 的 `@playwright/test`（脚本里 `createRequire('/Users/xiaozicong/code/knowmap/package.json')('@playwright/test')`，脚本本身放在临时目录）。GM 账号在 `.dev.vars`。
  4. `vite preview` 不跑定时任务：军队到达、流寇来袭等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }`（或 `settlement:<id>`、`bandits:<玩家>`）推进；流寇可以用 GM 命令 `bandits.spawn` 立即派出；也可调 GM 规则 `armies.speed` / `buildings.speed` 加快；秘境冒险可以把 `realms.rules` 的 `groupSeconds` 调到 1–2 秒，页面会在到点时自动 `realms.sync`。
