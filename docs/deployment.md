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
pnpm dev                          # 应用本地 D1 迁移，启动 http://localhost:5173（前端热更新 + Worker）；首次运行（还没有地形）时选择 / 生成地图并自动导入（含 NPC 城池）
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

| 命令                    | 作用                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | 应用本地 D1 迁移 + Vite 开发服务器（Vue 热更新 + Worker + D1）                                                                                  |
| `pnpm preview`          | 生产构建后在本地运行（本地部署测试），数据同样保存在 `.data/local`；监听 `0.0.0.0:4173`                                                         |
| `pnpm smoke`            | 浏览器冒烟测试：临时库 + 生产构建，逐页检查控制台错误和未翻译的文字（不碰 `.data/local`）                                                       |
| `pnpm build`            | 构建前端和 Worker 到 `dist/`                                                                                                                    |
| `pnpm test`             | Vitest 监听模式                                                                                                                                 |
| `pnpm check`            | **提交前必跑**：类型检查（Worker、测试、Vue）+ 格式检查 + 全部测试                                                                              |
| `pnpm typecheck`        | 仅类型检查（`tsc` 两套配置 + `vue-tsc`）                                                                                                        |
| `pnpm format`           | Prettier 格式化                                                                                                                                 |
| `pnpm data:*`           | 本地测试数据的清除 / 备份 / 恢复，见第 3 节                                                                                                     |
| `pnpm map:generate`     | 生成地图（`--seed`，输出 `.data/maps/<seed>/` 的 map.csv、preview.png、stats.json），见 `scripts/map/generate.mjs`                              |
| `pnpm map:import <csv>` | 把地图导入正在运行的游戏（默认 `http://localhost:5173`，`--url` 指定；用 GM 账号，整张覆盖，要求确认），再逐块播种 NPC 城池（`--no-npcs` 跳过） |
| `pnpm db:migrate:local` | 把 `migrations/` 应用到本地 D1（`pnpm dev` 会自动执行）                                                                                         |
| `pnpm db:migrate`       | 把 `migrations/` 应用到**线上** D1                                                                                                              |
| `pnpm cf-typegen`       | 修改 `wrangler.jsonc` 的 binding 后重新生成 `worker-configuration.d.ts`                                                                         |
| `pnpm run deploy`       | 构建并部署到 Cloudflare                                                                                                                         |

## 5. 部署到 Cloudflare

首次部署：

```sh
pnpm exec wrangler login                       # 浏览器授权 Cloudflare 账号
pnpm exec wrangler d1 create wargame-db        # 创建 D1，把输出的 database_id 填进 wrangler.jsonc 的 d1_databases
pnpm db:migrate                                # 在线上 D1 建表
pnpm exec wrangler secret put GM_USERNAME      # 超级用户名
pnpm exec wrangler secret put GM_PASSWORD      # GM 的初始密码：第一次登录后必须改成自己的密码
pnpm run deploy                                # vite build + wrangler deploy，输出 *.workers.dev 地址
```

之后：有新的 `migrations/*.sql` 时先 `pnpm db:migrate` 再 `pnpm run deploy`；否则直接 `pnpm run deploy`。建议上线前先用 `pnpm preview` 在本地跑一遍生产构建。

- GM 用户名可以在控制台修改（Workers & Pages → wargame → Settings → Variables and Secrets），立即生效；新用户名第一次登录时用当时的 `GM_PASSWORD`。GM 密码在游戏里改，改过之后 `GM_PASSWORD` 不再起作用。
- 自定义域名：Cloudflare 控制台 → Workers & Pages → wargame → Settings → Domains & Routes。
- 线上日志：`pnpm exec wrangler tail`，或控制台 Observability（已在 `wrangler.jsonc` 中开启）。

## 6. 用 Docker 自托管

不想用 Cloudflare 账号时，可以直接跑发布的镜像（每个版本的 GitHub Release 里都有说明和 `docker-compose.yml`）：

```sh
docker run -d --name wargame -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame:latest
```

或者下载 `docker-compose.yml` 后 `docker compose up -d`。打开 http://localhost:4173 ，用 GM 账号 `gm` / `wargame-gm` 登录。这只是**初始密码**，登录后先要改成自己的，之后在 GM 后台发邀请码。想换 GM 用户名或初始密码，就设环境变量 `GM_USERNAME` / `GM_PASSWORD`。

- **GM 账号从哪来**：`vite preview` 读的是构建时复制到 `dist/wargame/.dev.vars` 的那份（`pnpm dev` 读根目录的 `.dev.vars`），所以 `scripts/dev.mjs --serve` 把 `GM_USERNAME` / `GM_PASSWORD` 写到 `dist/wargame/.dev.vars`。
- **运行方式**：镜像里是生产构建，由 workerd（与 Cloudflare 相同的运行时，经 `vite preview`）提供服务。D1 是本地 SQLite，和地图一起放在卷 `/data`（`/data/local`、`/data/maps`）。每分钟的定时任务由 `vite.config.ts` 的 `localCron` 触发（本地服务器自己没有调度），和线上的 Cron Trigger 一样。
- **首次启动**（`node scripts/dev.mjs --serve`，即 `pnpm start`）：
  - 自动建表；
  - 游戏还没有地形时，用 `/data/maps` 里最新的地图，没有就生成一张；
  - 以 GM 身份导入，再逐块放好 NPC 城池。整个过程要几分钟，日志里有进度。

  之后重启不会再动地图。GM 账号改密码之前，GM 接口照常可用，导入因此不受影响；游戏接口要等改完密码。

- **升级**：不能不停服热升级，但停服只有几十秒：先拉新镜像，再停掉旧容器、按原样用同一个卷重建。数据库和地图都在卷里，所以数据保留；新版本的迁移在启动时自动执行，已有的地图不会重新生成。步骤见下面"升级到新版本"。
- **备份**：停掉容器后打包卷 `/data`（命令见下面第 2 步），恢复时把包解回同名的卷。
- **适合**：小规模、自己和朋友玩；大规模、公网服务仍建议部署到 Cloudflare（第 5 节）。
- 镜像由 GitHub Actions 在推送版本标签（`vA.B.C`）时构建（amd64、arm64），推到 `ghcr.io/<仓库>`，标签为版本号、`A.B` 和 `latest`。

### 升级到新版本

用 docker compose：

```sh
docker compose pull          # 先拉新镜像，旧版照常运行
docker compose stop          # 停服
docker run --rm -v wargame_wargame:/data -v "$PWD":/backup busybox tar czf /backup/wargame-backup.tgz /data   # 可选：备份（卷名见 docker volume ls）
docker compose up -d         # 用新镜像重建，数据保留
```

用 docker run（卷名、端口和 `-e` 参数换成你当初用的）。第一次 run 时没写 `--name` 的话，容器名是 Docker 随机起的（如 `eager_turing`），先查出来：

```sh
docker ps -a --filter volume=wargame --format '{{.Names}}  {{.Image}}  {{.Status}}'
```

第 2、3 步的 `wargame` 换成查到的名字；第 4 步照写 `--name wargame`，以后就固定了：

```sh
docker pull ghcr.io/xczics/wargame:latest                  # 1. 先拉新镜像，旧版照常运行
docker stop wargame                                        # 2. 停服
docker run --rm -v wargame:/data -v "$PWD":/backup busybox tar czf /backup/wargame-backup.tgz /data   #    可选：备份
docker rm wargame                                          # 3. 删掉旧容器（数据在卷里，不受影响）
docker run -d --name wargame -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame:latest   # 4. 用新镜像重建
docker logs -f wargame                                     # 看迁移与启动日志，出现地址即可访问
```

想固定在某个版本，把 `latest` 换成版本号（如 `1.2.1`）。要退回旧版本：停掉容器，用备份恢复卷（`docker run --rm -v wargame:/data -v "$PWD":/backup busybox sh -c "rm -rf /data/* && tar xzf /backup/wargame-backup.tgz -C /"`），再用旧版本号的镜像重建；新版本的库不保证能被旧版本读取，所以退回一定要用升级前的备份。

## 7. 持续集成与发布

- **CI**（`.github/workflows/ci.yml`）：每次推送到 `main` 和每个 PR 都跑 `pnpm check`（类型、格式、i18n 检查、全部测试）和 `pnpm build`。
- **发布**（`.github/workflows/release.yml`）：推送 `vA.B.C` 标签后：
  1. 先确认 `docs/releases/A.B.C.md` 存在，再跑检查；
  2. 构建并推送 Docker 镜像；
  3. 建 GitHub Release：开头是 `docs/releases/A.B.C.md` 的改动列表，然后是 `.github/release-notes.md`（部署与升级命令），附 `docker-compose.yml`。

  版本号规则见 AGENTS.md"版本号与发布"。发布步骤：改 `package.json` 的 `version`、写 changelog、写 `docs/releases/A.B.C.md`（自上次发布以来的改动，见 `docs/releases/README.md`；Release 说明的开头就是它，没有它发布会失败），提交后 `git tag vA.B.C && git push origin vA.B.C`。

- GHCR 上新建的镜像默认是私有的：第一次发布后在 GitHub 的 Packages 设置里改为公开，别人才能直接 `docker pull`。

## 8. 已知限制

（游戏系统的已知限制和改进方向见 `docs/design/architecture.md`。）

- 免费版 D1 每天 10 万行写入、Workers 每天 10 万次请求，只够开发和小规模测试；正式开服建议付费版（$5/月，每月含 5000 万行写入、1000 万次请求）。一次购买大约写 5 行（锁 + 资源 + 建筑）。
- 登录接口暂无频率限制；上线公开前建议加上 Cloudflare Rate Limiting（可写成一个插件）。
- 过期会话不会主动清理，只在读取时失效；数据量大后可加一个定时清理（Cron Trigger）插件。
- 玩家暂不能修改密码；GM 以外没有其他管理员角色。

## 9. 常见问题

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
