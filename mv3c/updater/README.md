# mv3c 版本更新与自动部署

## 架构与安全

- 管理员在 /admin →「版本更新」管理自动更新、通道、检查间隔，查看版本、任务、日志；数据保存在 MongoDB。
- Linux 宿主机 systemd timer 每分钟检查是否有管理员任务；按后台配置的 5–60 分钟间隔检查 GitHub。
- 网站容器不挂载 Docker Socket，不直接执行 Git、Docker 或任意 shell 命令。
- 只允许更新固定的 b8vipvip/mv3c GitHub 仓库，目标提交必须是已部署版本的快进后代，且 GitHub Actions 中 mv3c validation 和 mv3c source Docker build 两项都成功。
- 部署：Git 快进 → Docker Compose 构建 → 更新网站容器 → 健康检查；失败则尝试恢复上一提交并重新构建。
- 不删除 MongoDB、密钥和上传文件的数据卷；数据库 schema 迁移无法保证回滚，需单独备份。

## 一次性安装

在**实际运行 mv3c 的 Linux Docker 宿主机**执行。推荐将仓库放在 root 拥有的 /opt/mv3c，防止其他本机用户修改自动部署的代码。

~~~bash
sudo mkdir -p /opt
cd /opt
sudo git clone https://github.com/b8vipvip/mv3c.git
cd /opt/mv3c
sudo docker compose up -d --build

# 一次性安装宿主机更新服务
sudo bash mv3c/updater/install.sh

# 检查
sudo systemctl status mv3c-updater.timer
sudo journalctl -u mv3c-updater.service -n 100 --no-pager
~~~

若已经安装旧版 mv3c，先升级仓库到包含此功能的版本并确认站点正常，再执行上述安装脚本。无需创建 .env，也无需将 Docker Socket 暴露给网站容器。

安装脚本会验证 Git origin、main 分支、仓库目录的 root 所有权以及已跟踪文件没有未提交修改。如果仓库不是 root 拥有，请确认是正确的仓库后修改所有权（例如在 /opt 目录执行 sudo chown -R root:root /opt/mv3c）。

## 后台使用

管理员登录后进入 /admin →「版本更新」：

1. 查看当前已部署 Git SHA、GitHub 最新 SHA、检查时间、更新服务在线状态。
2. 开启或关闭自动更新，选择 **main**（默认，main 分支最新通过 CI 的提交）或 **Release**（最新 GitHub Release；仓库必须先发布 Release），选择检查间隔并保存。
3. 「立即检查 GitHub」提交检查请求；宿主机通常在下一次约 1 分钟的定时运行时处理。
4. 「立即更新并部署」提交手动任务；关闭自动更新也能手动执行，但不会绕过 GitHub CI 门禁。
5. 查看状态、最近任务、部署日志。更新期间网站可能短暂重启。

默认自动更新开启，每 10 分钟检查 GitHub。**必须先在宿主机安装并启用更新服务**，否则后台只能保存请求，无法执行部署。

## 运维与排错

~~~bash
sudo systemctl status mv3c-updater.timer
sudo journalctl -u mv3c-updater.service -n 150 --no-pager
sudo systemctl start mv3c-updater.service
cd /opt/mv3c
sudo docker compose logs --tail=200 mv3c
~~~

- 更新服务未连接：确认 timer 已启用、Docker Compose 可运行、网站容器和数据库正常。
- 等待 CI 通过：GitHub 最新目标提交的两项 Actions 尚未成功，自动/手动更新都会被阻止。
- 本地文件有修改：先提交或撤销 Git 已跟踪文件的本地更改。
- 已回滚上一版本：新版本部署失败并尝试恢复旧应用。**数据库迁移不回滚**。
- GitHub Release 不存在：选择 main 通道，或在 GitHub 先发布正式 Release。

宿主机更新服务具有 Docker 部署权限，以 root 运行；只能从固定仓库更新并执行固定的 Compose 命令，不能接受管理员提交的任意命令、仓库地址或 Git SHA。
