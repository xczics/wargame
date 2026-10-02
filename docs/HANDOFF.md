# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `docs/development.md`，部署与运维在 `docs/deployment.md`，规划中的架构和已知限制在 `docs/design/architecture.md`，插件开发指南在 `docs/plugin-guide.md`。约定见 `AGENTS.md`。

更新于 2026-10-02。

## 1. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、145 个测试）。代码在公开仓库 https://github.com/xczics/wargame （`main`）。**1.0.0 已发布**（标签 `v1.0.0` 与 GitHub Release，2026-10-02）：包含前端整合、扩展机制与本轮全部玩法改动；之后的版本号按 AGENTS.md"版本号与发布"递增。项目以 GPL-3.0-only 发布（`LICENSE`）。
- 玩法已实现 gameplay.md 第 1–12 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑、科技树、秘境、装备、商城与道具、声望与流寇）；"暂按……实现"的取舍写在 gameplay.md 对应条目里。最近的改动：`docs/changelogs/2026-10-02-user-notes.md`。
- 前端整合已完成：界面由后端声明、几乎全部由通用控件画出（`web/widgets/`，`docs/design/ui.md` 第 3 节）；剩下的前端插件只有外壳、`widgets`、邮箱 `mail` 和 GM 后台；第三方扩展放进 `extensions/`，两端自动发现（示例在 `examples/`）。
- 数据库迁移到 `0044_settlements_inner_slots.sql`。
- 用户的本地存档 `.data/local`：2026-10-02 重置为全新存档（M1），导入了种子 `wargame` 的新地图（`.data/maps/wargame/`）；之前的数据备份在 `.data/backups/before-m1`。**不要擅自清除或重置**。
- 本地开发 / 预览服务器监听 `0.0.0.0`（局域网可访问），端口 `5173`（dev）/ `4173`（preview）。

## 2. 待办

按顺序做；做完一条，把记录写进 `docs/changelogs/` 当天的文件，并从这里**删掉**。引号里是用户原话。

（暂无。新留言见 `humannotes.md`。）

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟测试**不要用 `.data/local`**：
  1. `pnpm exec wrangler d1 migrations apply DB --local --persist-to <临时目录>`
  2. `pnpm build && WARGAME_DATA_DIR=<临时目录> pnpm exec vite preview --port <端口>`
  3. 用 Playwright 操作：借用 `~/code/knowmap` 的 `@playwright/test`（脚本里 `createRequire('/Users/xiaozicong/code/knowmap/package.json')('@playwright/test')`，脚本本身放在临时目录）。GM 账号在 `.dev.vars`。
  4. `vite preview` 不跑定时任务：军队到达、流寇来袭等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }`（或 `settlement:<id>`、`bandits:<玩家>`）推进；流寇可以用 GM 命令 `bandits.spawn` 立即派出；也可调 GM 规则 `armies.speed` / `buildings.speed` 加快；秘境冒险可以把 `realms.rules` 的 `groupSeconds` 调到 1–2 秒，页面会在到点时自动 `realms.sync`。
