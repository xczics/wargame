## Docker 部署

```sh
docker run -d --name wargame -p 4173:4173 -v wargame:/data __IMAGE__:__VERSION__
```

或者下载附件 `docker-compose.yml` 后 `docker compose up -d`。打开 http://localhost:4173 ，用 GM 账号 `gm` / `wargame-gm` 登录：这只是初始密码，登录后会要求立即改成你自己的。首次启动会自动建库、生成地图并放好 NPC 城池（约几分钟）；数据都在卷 `/data` 里。

## 从旧版本升级

停服几十秒；数据库和地图在卷里，保留不变，新版本的迁移在启动时自动执行。

用 docker compose：

```sh
docker compose pull          # 先拉新镜像，旧版照常运行
docker compose stop          # 停服
docker compose up -d         # 用新镜像重建
```

用 docker run（卷名、端口和 `-e` 参数换成你当初用的）。第一次 run 时没写 `--name` 的话，容器名是 Docker 随机起的，先查出来：`docker ps -a --filter volume=wargame --format '{{.Names}}'`，把下面 `stop` / `rm` 里的 `wargame` 换成它；重建时照写 `--name wargame`，以后就固定了：

```sh
docker pull __IMAGE__:__VERSION__
docker stop wargame
docker run --rm -v wargame:/data -v "$PWD":/backup busybox tar czf /backup/wargame-backup.tgz /data   # 可选：备份
docker rm wargame
docker run -d --name wargame -p 4173:4173 -v wargame:/data __IMAGE__:__VERSION__
docker logs -f wargame
```

退回旧版本要用升级前的备份恢复卷，详见 [docs/deployment.md](https://github.com/__REPO__/blob/v__VERSION__/docs/deployment.md) 第 6 节；部署到 Cloudflare 也见该文档。

## 细节

每项改动的细节（接口变化、取舍、测试）见 [docs/changelogs/](https://github.com/__REPO__/tree/v__VERSION__/docs/changelogs)。
