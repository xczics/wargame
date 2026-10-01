# 开发交接：当前状态

> 这是**唯一的状态文档**，只写"现在是什么样、接下来做什么"。已完成的改动记在 `docs/changelogs/`，玩法设计在 `docs/design/gameplay.md`，界面在 `docs/design/ui.md`，已实现的架构在 `README.md`，规划中的架构和已知限制在 `docs/design/architecture.md`。约定见 `AGENTS.md`。

更新于 2026-10-01。

## 1. 状态

- `pnpm check` 通过（tsc、vue-tsc、prettier、93 个测试）。
- 所有改动都**未提交**（用户没有要求提交）。
- 数据库迁移到 `0024_mail.sql`。用户本地下次 `pnpm dev` 会自动执行 `0023_armies_missions`、`0024_mail`。
- 用户的本地存档 `.data/local`：2026-10-01 按用户要求导入了随机生成的地图（种子 `wargame`）；导入前的备份在 `.data/backups/2026-09-30T23-06-38-834Z`。不要擅自清除或重置。
- 玩法已实现到 gameplay.md 第 1–7 节（资源、部队、战斗、地图、英雄、邮箱与战报、城池与建筑）；"暂按……实现"的取舍都写在 gameplay.md 对应条目里。
- 最近的改动：`docs/changelogs/2026-10-01-user-notes.md`。

## 2. 待办

按顺序做；做完一条，把记录写进 `docs/changelogs/` 当天的文件，并从这里删掉。

- ▶ **实现科技树**（gameplay.md 第 8 节；用户确认："1. 改名；2.需要；3.风格对的。开始实现吧"——"采矿"改名"钱法"、需要 GM 规则 `starter-research.effects` 调效果数值、题注与数值风格认可）
  - ✅ 第 1、2 步（见 changelog ㉓）。
  - ▶ 第 3 步：补 8.6 的新接口，接上剩下的科技：驿传 / 骑射（行军速度）、水利（地形额外加成）、科举（候选数）、漕运（辎重载重）、交子 / 天工（建筑上限）、城防 / 火药（城墙防御）、斥候（来袭情报）、神机营（削减城墙加成）、王师（晋升额度）。这些科技已经能研究，但这部分效果还没有。

## 3. 怎么验证

- 自动化：`pnpm check`。
- 浏览器冒烟测试**不要用 `.data/local`**：
  1. `pnpm exec wrangler d1 migrations apply DB --local --persist-to <临时目录>`
  2. `pnpm build && WARGAME_DATA_DIR=<临时目录> pnpm exec vite preview --port <端口>`
  3. 用 Playwright 操作：借用 `~/code/knowmap` 的 `@playwright/test`（脚本里 `createRequire('/Users/xiaozicong/code/knowmap/package.json')('@playwright/test')`，脚本本身放在临时目录）。GM 账号在 `.dev.vars`。
  4. `vite preview` 不跑定时任务：军队到达等事件用 GM 命令 `timeline.sync { entity: "army:<id>" }` 推进，或调 GM 规则 `armies.speed` / `buildings.speed` 加快。
