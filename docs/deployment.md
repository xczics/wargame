# 部署与运维

> 写给要在本机跑起来、或部署到自己的 Cloudflare 账号上的人。项目简介见 [README](../README.md)；开发文档见 [development.md](development.md)。

## 1. 环境要求

| 工具            | 版本                                          | 安装方式                                                         |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Node.js         | ≥ 22（`.node-version` 写的是 26）             | `brew install node`（务必**显式安装**，见下方说明）或 mise / fnm |
| pnpm            | 12.x（见 `package.json` 的 `packageManager`） | `brew install pnpm`                                              |
| Cloudflare 账号 | —                                             | 仅部署时需要                                                     |

> ⚠️ **不要让 Node 以"依赖"身份存在于 Homebrew 中。** 如果 node 是被别的 formula 顺带装上的，
> 一旦那个 formula 不再依赖它，下一次任意 `brew install` 触发的自动清理（autoremove）会把 node 静默删掉。
> 用 `brew install node` 显式安装一次即可（或 `brew tab --installed-on-request node`）。

## 2. 本地运行

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 本地 GM 账号：GM_USERNAME / GM_PASSWORD，按需修改
pnpm dev                          # 应用本地 D1 迁移，再启动 http://localhost:5173（前端热更新 + Worker）
```

`pnpm dev` 和 `pnpm preview` 现在都会监听 `0.0.0.0`，所以同一局域网里的机器可以直接访问这台 Mac。默认端口分别是 `5173` 和 `4173`。

1. 用 `.dev.vars` 里的 GM 账号登录（首次登录会自动创建该账号），用户名右侧出现 **GM** 徽章，点开是 GM 后台。
2. 在 GM 后台的"邀请码"里生成邀请码（可设最大使用次数、有效期、备注），链接会自动复制到剪贴板。
3. 在另一个浏览器 / 无痕窗口打开链接 `http://localhost:5173/?invite=XXXXX-XXXXX` 注册玩家。
4. 新玩家自动获得一座首都（地图上随机空地，1 个内城 + 1 个外城）。在**城池**页的外城栏位建农田 / 伐木场等资源建筑，在内城建仓库、宫殿；建造需要时间，完成后自动刷新。关掉页面再回来，离线产出自动结算（库存上限内）。
5. 在城池页左栏的城区九宫格里点"＋"扩建外城；在**地图**页选空地建分城或要塞。（分城和要塞的数量上限开局都是 0，要先研究科技或用许可道具；本地试玩可以用 GM 规则 `player-settlements.limits` 调高。）
6. GM 在后台的"规则"里修改规则（例如把 `buildings.productionMultiplier` 改成 `10`），玩家刷新即生效。

### 局域网访问

如果要让同一局域网里的设备访问本机开发服务器：

1. 确认用的是 `pnpm dev` 或 `pnpm preview`，它们已经绑定到 `0.0.0.0`。
2. 用这台 Mac 的局域网 IP 访问，例如 `http://192.168.1.23:5173` 或 `http://192.168.1.23:4173`。
3. 如果 macOS 防火墙开启了，去「系统设置」→「网络」→「防火墙」→「选项」，允许当前运行服务器的应用程序接收传入连接；通常是 `Terminal`、`iTerm` 或 VS Code。

## 3. 本地测试数据（持久化）

本地运行产生的所有数据（账号、会话、邀请码、GM 规则、审计日志、玩家存档）都保存在 **`.data/local/`**（已被 git 忽略）。**重启 `pnpm dev` / `pnpm preview` 后数据仍在**，只有显式执行下列命令才会改变：

| 命令                       | 作用                                                |
| -------------------------- | --------------------------------------------------- |
| `pnpm data:reset`          | 删除全部本地数据，并重新建好空表                    |
| `pnpm data:backup [名称]`  | 快照到 `.data/backups/<名称>`（不写名称则用时间戳） |
| `pnpm data:restore <名称>` | 用快照替换当前数据（之后自动补跑新的迁移）          |
| `pnpm data:list`           | 列出已有快照                                        |

- 执行 `data:reset` / `data:restore` 前请先停掉 `pnpm dev` / `pnpm preview`（它们会占用数据库文件）。
- `pnpm dev`（开发，热更新）与 `pnpm preview`（生产构建后本地运行，最接近线上）**共用同一份数据**。
- 自动化测试（`pnpm test`）使用独立的临时存储，不会读写 `.data/`。
- 查看或手动修改数据：`pnpm exec wrangler d1 execute DB --local --persist-to .data/local --command "SELECT * FROM accounts_users"`。

## 4. 常用命令

| 命令                    | 作用                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`              | 应用本地 D1 迁移 + Vite 开发服务器（Vue 热更新 + Worker + D1）                                                     |
| `pnpm preview`          | 生产构建后在本地运行（本地部署测试），数据同样保存在 `.data/local`；监听 `0.0.0.0:4173`                            |
| `pnpm build`            | 构建前端和 Worker 到 `dist/`                                                                                       |
| `pnpm test`             | Vitest 监听模式                                                                                                    |
| `pnpm check`            | **提交前必跑**：类型检查（Worker、测试、Vue）+ 格式检查 + 全部测试                                                 |
| `pnpm typecheck`        | 仅类型检查（`tsc` 两套配置 + `vue-tsc`）                                                                           |
| `pnpm format`           | Prettier 格式化                                                                                                    |
| `pnpm data:*`           | 本地测试数据的清除 / 备份 / 恢复，见第 3 节                                                                        |
| `pnpm map:generate`     | 生成地图（`--seed`，输出 `.data/maps/<seed>/` 的 map.csv、preview.png、stats.json），见 `scripts/map/generate.mjs` |
| `pnpm map:import <csv>` | 把地图导入正在运行的游戏（默认 `http://localhost:5173`，`--url` 指定；用 GM 账号，整张覆盖，要求确认）             |
| `pnpm db:migrate:local` | 把 `migrations/` 应用到本地 D1（`pnpm dev` 会自动执行）                                                            |
| `pnpm db:migrate`       | 把 `migrations/` 应用到**线上** D1                                                                                 |
| `pnpm cf-typegen`       | 修改 `wrangler.jsonc` 的 binding 后重新生成 `worker-configuration.d.ts`                                            |
| `pnpm run deploy`       | 构建并部署到 Cloudflare                                                                                            |

## 5. 部署到 Cloudflare

首次部署：

```sh
pnpm exec wrangler login                       # 浏览器授权 Cloudflare 账号
pnpm exec wrangler d1 create wargame-db        # 创建 D1，把输出的 database_id 填进 wrangler.jsonc 的 d1_databases
pnpm db:migrate                                # 在线上 D1 建表
pnpm exec wrangler secret put GM_USERNAME      # 超级用户名
pnpm exec wrangler secret put GM_PASSWORD      # 超级用户密码（请用强密码）
pnpm run deploy                                # vite build + wrangler deploy，输出 *.workers.dev 地址
```

之后：有新的 `migrations/*.sql` 时先 `pnpm db:migrate` 再 `pnpm run deploy`；否则直接 `pnpm run deploy`。建议上线前先用 `pnpm preview` 在本地跑一遍生产构建。

- GM 账号也可以在控制台修改：Workers & Pages → wargame → Settings → Variables and Secrets。修改后立即生效。
- 自定义域名：Cloudflare 控制台 → Workers & Pages → wargame → Settings → Domains & Routes。
- 线上日志：`pnpm exec wrangler tail`，或控制台 Observability（已在 `wrangler.jsonc` 中开启）。

## 6. 已知限制

（游戏系统的已知限制和改进方向见 `docs/design/architecture.md`。）

- 免费版 D1 每天 10 万行写入、Workers 每天 10 万次请求，只够开发和小规模测试；正式开服建议付费版（$5/月，每月含 5000 万行写入、1000 万次请求）。一次购买大约写 5 行（锁 + 资源 + 建筑）。
- 登录接口暂无频率限制；上线公开前建议加上 Cloudflare Rate Limiting（可写成一个插件）。
- 过期会话不会主动清理，只在读取时失效；数据量大后可加一个定时清理（Cron Trigger）插件。
- 玩家暂不能修改密码；GM 以外没有其他管理员角色。

## 7. 常见问题

| 现象                                | 处理                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `command not found: node`           | 见第 1 节；`brew list node` 确认存在，`brew info node` 确认是 "Installed on request" |
| pnpm 提示 build scripts 被阻止      | 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式允许（当前允许 esbuild、workerd）    |
| 修改 binding 后类型报错             | `pnpm cf-typegen`                                                                    |
| 启动时报 `PluginError`              | 插件装配错误（缺依赖、循环依赖、重复注册），错误信息会指出具体插件                   |
| 报 `no such table: accounts_…`      | 迁移没跑：本地 `pnpm db:migrate:local`，线上 `pnpm db:migrate`                       |
| 想从干净的本地环境重新测试          | 停掉开发服务器，`pnpm data:backup` 留个快照（可选），再 `pnpm data:reset`            |
| GM 登录失败                         | 本地检查 `.dev.vars`；线上确认两个密钥都已设置（`pnpm exec wrangler secret list`）   |
| 后台某条规则显示 "override ignored" | 存量覆盖值已不合法（例如引用的建筑被删掉），重新保存或点 "Reset to default"          |
