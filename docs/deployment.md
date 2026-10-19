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

| 命令                    | 作用                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | 应用本地 D1 迁移 + Vite 开发服务器（Vue 热更新 + Worker + D1）                                                                                                 |
| `pnpm preview`          | 生产构建后在本地运行（本地部署测试），数据同样保存在 `.data/local`；监听 `0.0.0.0:4173`                                                                        |
| `pnpm smoke`            | 浏览器冒烟测试：临时库 + 生产构建，逐页检查控制台错误和未翻译的文字（不碰 `.data/local`）                                                                      |
| `pnpm build`            | 构建前端和 Worker 到 `dist/`                                                                                                                                   |
| `pnpm test`             | Vitest 监听模式                                                                                                                                                |
| `pnpm check`            | **提交前必跑**：类型检查（Worker、测试、Vue）+ 格式检查 + 全部测试                                                                                             |
| `pnpm typecheck`        | 仅类型检查（`tsc` 两套配置 + `vue-tsc`）                                                                                                                       |
| `pnpm format`           | Prettier 格式化                                                                                                                                                |
| `pnpm data:*`           | 本地测试数据的清除 / 备份 / 恢复，见第 3 节                                                                                                                    |
| `pnpm map:generate`     | 生成地图（`--seed`，输出 `.data/maps/<seed>/` 的 map.csv、preview.png、stats.json），见 `scripts/map/generate.mjs`                                             |
| `pnpm map:import <csv>` | 把地图导入正在运行的游戏（默认 `http://localhost:5173`，`--url` 指定；用 GM 账号，整张覆盖，要求确认；地图存成 R2 里的一个文件）；NPC 营寨按规则算出，不用播种 |
| `pnpm db:migrate:local` | 把 `migrations/` 应用到本地 D1（`pnpm dev` 会自动执行）                                                                                                        |
| `pnpm db:migrate`       | 把 `migrations/` 应用到**线上** D1                                                                                                                             |
| `pnpm cf-typegen`       | 修改 `wrangler.jsonc` 的 binding 后重新生成 `worker-configuration.d.ts`                                                                                        |
| `pnpm run deploy`       | 构建并部署到 Cloudflare                                                                                                                                        |

## 5. 部署到 Cloudflare

游戏可以完整跑在 Cloudflare 的免费计划上：Worker 跑服务端，D1 存全部数据，R2 存地图、静态数据和图片，网页由 Workers Assets 直接发。3–5 人的小服用不到免费额度的零头，自带的用量保护会在接近收费前暂停游戏（5.5）。

### 5.1 准备

- **Cloudflare 账号**（免费计划即可）。想用自己的域名，域名要先接入**同一个账号**（控制台 → 添加站点，按提示改 NS）；不用域名也行，游戏会在 `*.workers.dev` 上。
- **开通 R2**：控制台 → R2 对象存储 → 开通。要绑一张付款卡（免费额度内不扣费）。
- **本机**：Node.js 22 以上、pnpm（`corepack enable`），克隆仓库后 `pnpm install`。

### 5.2 一条命令部署（推荐）

```sh
pnpm setup:cloudflare
```

它一步步问你、一步步做，已有的会沿用，可以反复运行（换域名、补上公开文件域名都用它）：

1. **登录**：没登录会打开浏览器授权；账号不止一个时让你选（选域名所在的那个）。
2. **游戏域名**：如 `game.example.com`；留空用 `*.workers.dev`。
3. **D1 数据库**：没有就新建 `wargame-db`，问建在哪个区域（**选离玩家近的**：`apac` 亚太、`weur` / `eeur` 欧洲、`enam` / `wnam` 北美、`oc` 大洋洲）。
4. **R2 桶**：没开通 R2 会提示你去控制台开通，开好按回车继续；没有桶就新建 `wargame-files`。
5. **写配置**：生成你自己的部署配置 `wrangler.production.jsonc`（`wrangler.jsonc` 的一份拷贝，加上 `production` 环境：数据库 id、域名、账号 id…）。这个文件在 `.gitignore` 里，**不会被提交**，自己备份好，换电脑时拷过去。
6. **建表**：应用 `migrations/` 里的全部迁移。然后查数据库在哪个机房，把 Worker 固定在它旁边运行（5.6）。
7. **密钥与部署**：问 GM 用户名、GM 初始密码（输入不显示）和用量保护用的 `CF_API_TOKEN`（怎么建见 5.5），随部署一起上传（只在一个权限 0600 的临时文件里待几秒，部署完就删），然后构建并部署。
8. **R2 公开域名（可选）**：如 `files.example.com`，自动绑定并设好 CORS，再部署一次（5.7）。
9. **地图（新世界必需）**：生成一张新地图并以 GM 身份导入。

完成后打开游戏网址，用 GM 用户名和初始密码登录，按提示改成自己的密码（改之前不能玩，GM 后台可用）。注册默认是关的：在 GM 后台的"邀请码"页签发邀请码，玩家凭码注册。

### 5.3 手动部署（每一步在做什么）

不想用脚本，或者想知道它做了什么，按顺序：

```sh
pnpm exec wrangler login                                   # 浏览器授权：域名所在的那个账号
pnpm exec wrangler d1 create wargame-db --location apac    # 选离玩家近的区域
pnpm exec wrangler r2 bucket create wargame-files          # 先在控制台开通 R2
# cp wrangler.jsonc wrangler.production.jsonc，在 cloudflare-setup:begin / end 之间写 "env": { "production": { … } }（字段见下表；
# vars.CF_ACCOUNT_ID 用 pnpm exec wrangler whoami 查）。这个文件不进 git
pnpm db:migrate                                            # 在线上 D1 建表（--env production）
pnpm exec wrangler secret put GM_USERNAME -c wrangler.production.jsonc --env production # 在自己的终端里交互输入
pnpm exec wrangler secret put GM_PASSWORD -c wrangler.production.jsonc --env production # 初始密码：第一次登录后必须改
pnpm exec wrangler secret put CF_API_TOKEN -c wrangler.production.jsonc --env production
pnpm run deploy                                            # 用 wrangler.production.jsonc 的 production 环境构建 + 部署
pnpm map:generate --seed <种子>                            # 新地图，结果在 .data/maps/<种子>/
GM_USERNAME=<GM 用户名> GM_PASSWORD=<密码> node scripts/map/import.mjs .data/maps/<种子>/map.csv --url https://<域名> --yes
```

部署配置的结构：仓库里的 `wrangler.jsonc` 是通用的，顶层**不带**数据库 id，本地开发、测试和 Docker 照旧用自己的本地库（加上 id，本地库文件会换掉，数据像是"丢了"）；你的线上信息（数据库 id、域名、账号）只在本地的 `wrangler.production.jsonc` 里，它是 `wrangler.jsonc` 的拷贝加上 `env.production`，不进 git、也不进 Docker 镜像。`pnpm run deploy`、`pnpm db:migrate` 用它。绑定（D1、R2）和变量不会从顶层继承，所以里面要再写一遍。

| `env.production` 里                       | 作用                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `d1_databases[0].database_id`             | 线上数据库                                                                                                                            |
| `r2_buckets`                              | 文件桶 `wargame-files`                                                                                                                |
| `routes`                                  | 自定义域名：`{ "pattern": "<域名>", "custom_domain": true }`。部署时自动建 DNS 记录和证书；域名必须在同一账号、该主机名不能已有 CNAME |
| `placement`                               | Worker 在哪里运行（5.6）                                                                                                              |
| `triggers.crons`                          | 后台任务频率，默认每 10 分钟（5.5）                                                                                                   |
| `vars.FILES_BASE_URL`                     | R2 公开域名，空 = 经由 Worker（5.7）                                                                                                  |
| `vars.CF_ACCOUNT_ID`、`vars.FILES_BUCKET` | 用量保护查用量用                                                                                                                      |
| `secrets.required`                        | `GM_USERNAME`、`GM_PASSWORD`、`CF_API_TOKEN`；缺一个，部署直接失败                                                                    |

### 5.4 升级与日常运维

- **升级到新版本**：拉代码、`pnpm install`；有新的 `migrations/*.sql` 时**先** `pnpm db:migrate` **再** `pnpm run deploy`（代码兼容迁移前后的数据），否则直接 `pnpm run deploy`。每个版本的升级须知在 `docs/releases/<版本号>.md`。
- **日志**：`pnpm exec wrangler tail -c wrangler.production.jsonc --env production`（实时，每个请求的 CPU 毫秒数也在里面），或控制台 Workers → wargame → Observability。按小时的请求数和 CPU 分位数在控制台的 Metrics 页。
- **改 GM 用户名**：控制台 Workers & Pages → wargame → 设置 → 变量和机密，立即生效；新用户名第一次登录用当时的 `GM_PASSWORD`。GM 密码在游戏里改，改过之后 `GM_PASSWORD` 不再起作用。
- **meta**：`pnpm build` 会把 meta 生成成静态文件 `meta.json`（`scripts/bake-meta.mjs`），浏览器按静态资源取，不算 Worker 请求。

### 5.5 免费额度与用量保护

| 资源        | 免费额度                                                  | 3–5 人实测                              |
| ----------- | --------------------------------------------------------- | --------------------------------------- |
| Worker 请求 | 每天 10 万次                                              | 每人每小时几百次                        |
| Worker CPU  | **每次 10 ms**（偶尔超出可以，持续超出会被终止，报 1102） | 同步中位数 6–12 ms，建造等命令 30–45 ms |
| D1          | 每天读 500 万行、写 10 万行                               | 每天几千行                              |
| R2          | 每月存储 10 GB、A 类操作 100 万次、B 类 1000 万次         | 不到 1%                                 |

- **用量保护**（`usage-guard`）：R2 超出免费额度会扣费，所以 Worker 每 10 分钟查一次本月 R2 用量，**任一项到 50%**（GM 规则 `usage-guard.threshold`）就暂停游戏（玩家接口回 503，GM 后台和登录照常）并关掉 R2 公开域名，下个月自动恢复。GM 后台报表 `usage-guard.status` 看用量；GM 命令"解除用量暂停"手动解除。
- **`CF_API_TOKEN` 怎么建**：控制台 → 右上角头像 → 我的个人资料 → API 令牌 → 创建令牌 → 创建自定义令牌；权限两项：**账户 · 账户分析 · 读取**、**账户 · Workers R2 存储 · 编辑**；账户资源选这个账号。（英文界面：Account Analytics · Read、Workers R2 Storage · Edit。）
- **后台任务每 10 分钟一次**：一次运行的 CPU 在免费额度附近；离线玩家的事件晚几分钟处理不影响结果（玩家打开游戏时自己的事件当场结算），用量保护本来也是 10 分钟查一次。

### 5.5.1 登录 / 注册防护

- 内置：同一用户名 + IP、同一用户名、同一 IP 的登录失败，同一 IP 的注册失败，到次数就锁 15 分钟（GM 规则 `accounts.loginLimits`）。
- **人机验证（推荐，免费）**：控制台 → Turnstile → 添加小组件：名称随意；主机名填游戏的域名（自定义域名和 `wargame.<子域>.workers.dev` 都填）；小组件模式选"托管"。创建后有两把钥匙：**站点密钥**是公开的，写进 `wrangler.production.jsonc` 的 `env.production.vars.TURNSTILE_SITE_KEY`；**密钥**在自己的终端里设：`pnpm exec wrangler secret put TURNSTILE_SECRET -c wrangler.production.jsonc --env production`。然后 `pnpm run deploy`。两把都有才启用：失败满 3 次（`captchaAfter`）后，登录 / 注册要先过验证。
- **WAF 限速规则（免费计划 1 条，只管自定义域名）**：控制台选中你的域名 → 安全性 → WAF → 速率限制规则 → 创建规则：名称随意；"传入请求匹配"选"自定义筛选表达式"，填 `(http.request.uri.path in {"/api/auth/login" "/api/auth/register"} and http.request.method eq "POST")`；"具有相同特征"选 IP；"当速率超过"填 10 个请求 / 10 秒；"采取操作"选"阻止"，持续 10 秒；部署。它在请求到达 Worker 之前就挡掉，不计 Worker 请求；`*.workers.dev` 地址不在你的域名下，不受这条规则保护（由上面两层防护）。

### 5.6 延迟：让 Worker 在数据库旁边运行

一次页面同步要依次查十几次库。Worker 默认在离**玩家**最近的机房运行，数据库却在你建库时选的区域；两者跨洲时每次查询都要往返一趟（欧洲到日本约 250 ms），一次同步就要 3–4 秒。所以 `production` 环境用 `placement` 把 Worker 固定在数据库旁边：玩家到 Worker 只有一次长途往返，查库都在机房内部。

- 脚本会查数据库主库在哪个机房（`served_by_colo`，例如 `NRT` 东京），写成 `"placement": { "region": "aws:ap-northeast-1" }`；查不出时用 `{ "mode": "smart" }`（Smart Placement 要攒够流量才会挪，流量小的服可能一直不挪）。
- 检查是否生效：`curl -sI https://<域名>/api/meta | grep cf-placement`，`remote-NRT` 这类 `remote-` 开头的表示已挪到数据库旁边，`local-XXX` 表示还在玩家附近。
- 数据库区域按大多数玩家选；建库之后区域不能改（只能新建库、重开世界）。

### 5.7 R2 公开域名（可选，省 Worker 请求）

设了之后，浏览器直接从 R2 取地图、静态数据和拼图图片，不经过 Worker；不设时经由 `/api/static/...`，照样能玩。脚本第 8 步会做；手动做法：

```sh
pnpm exec wrangler r2 bucket domain add wargame-files --domain files.example.com --zone-id <区域 id>   # 区域 id 在控制台该域名概览页
pnpm exec wrangler r2 bucket cors set wargame-files --file cors.json
# cors.json：{"rules":[{"allowed":{"origins":["https://<游戏域名>"],"methods":["GET","HEAD"],"headers":["*"]},"maxAgeSeconds":86400}]}
# 再把 wrangler.production.jsonc 里 env.production.vars.FILES_BASE_URL 设成 https://files.example.com，pnpm run deploy
```

二级子域名（如 `files.game.example.com`）也可以，证书几分钟内自动签好。公开域名会把桶里**任何**猜得到名字的文件都发出去，所以不该给玩家看的文件（规则快照 `versions/`，含不透明科技的分组）用随机文件名，由数据库里的行指向它。

### 5.8 常见问题（部署时）

- **`wrangler login` 登进了别的账号**（没有 R2、看不到域名）：`pnpm exec wrangler logout`，再 `login`，在浏览器里换成域名所在的那个账号。
- **建 R2 桶报错 10042**：这个账号还没开通 R2，去控制台开通。
- **部署报自定义域名的错**：域名不在这个账号里，或者这个主机名已经有一条 CNAME（删掉它，部署会自己建）。
- **部署报缺少 secret**：`GM_USERNAME`、`GM_PASSWORD`、`CF_API_TOKEN` 都是必需的。
- **接口报 `no such table`**：有迁移没应用到线上，`pnpm db:migrate`。
- **页面每次刷新都要好几秒**：Worker 和数据库不在一处，见 5.6。
- **zsh 里 `read -p` 报 `no coprocess`**：zsh 的写法是 `read "VAR?提示: "`，隐藏输入 `read -s "VAR?提示: "`。
- **控制台的"生产环境剖析"（Profiling in production）在小服上基本采不到**：它每次只随机挑一个实例采样，请求分散在几个实例上时多半采到空闲的。看 CPU 用 `wrangler tail` 或 Metrics 页的分位数。

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

### 站点图标

默认图标是 `public/favicon.svg` / `favicon.ico`（静态资源，永不 404）。GM 可以在后台"个性化"页签换内置图标或上传自己的；上传需要 R2 桶 `FILES`，配了 `FILES_BASE_URL` 时从桶的公开域名直接取。

### 用量日志（估算上 Cloudflare 的用量）

给容器加环境变量 `USAGE_LOG=on`（每 4 小时一行；也可以写分钟数，如 `USAGE_LOG=60`），每个周期结束时在日志里打一行 JSON：请求数、命令数、D1 读行 / 写行、库大小、R2 操作、CPU 时间（估计），以及换算成每天、占 Cloudflare 免费额度的比例。

```sh
docker run -d --name wargame -p 4173:4173 -v wargame:/data -e USAGE_LOG=on ghcr.io/xczics/wargame:latest
docker logs wargame | grep '"usage"'
```

- 本地也一样：`USAGE_LOG=on pnpm dev`（开发服务器），或 `USAGE_LOG=on node scripts/dev.mjs --serve`（和 Docker 一样的生产构建）。变量只在运行时加进本地 Worker，`pnpm build` / `pnpm deploy` 不会带上它。
- 每个周期的数存在本地库的 `usage_periods` 表里（重启后接着累计）。这张表只在开了这个选项时才建，迁移里没有，正式部署到 Cloudflare 不会有它；`wrangler.jsonc` 里不能写 `USAGE_LOG`（`pnpm check` 会拦）。
- D1 读行 / 写行、库大小来自本地 D1 每次查询返回的统计，口径和线上计费一致。
- 开着这个选项时，每个响应带 `x-usage-rows: 读,写`（这次请求读写了几行），可以逐页、逐视图看读表量（1.4.1）。
- R2 分三项（用户 2026-10-18："R2要统计写入、读取和不经过worker的拉取"）：`r2Writes`（写入，A 类操作）、`r2Reads`（Worker 自己的读取，B 类）、`r2Fetches`（浏览器取的文件：地形、静态视图、拼图图片）。本地和 Docker 没有公开域名，浏览器经 Worker 的文件路由（`/api/files/…`、`/api/static/…`）取，这些请求记作 `r2Fetches`、不计入请求数；线上配了 `FILES_BASE_URL` 时它们直接从桶的公开域名取，不经过 Worker，但同样是 B 类操作（公开域名有缓存时会更少）。免费额度按月算（A 类 100 万、B 类 1000 万），日志里按 30 天换算。CPU 是本地运行时进程（workerd）在这段时间里用的 CPU，包含空闲时的开销，所以"每次请求的 CPU"偏高，只能当上限看。定时任务每分钟一次，也算请求（线上同样计费）。

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
