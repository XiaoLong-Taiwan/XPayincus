---
title: systemd 服务
description: 配置 XPayincus 后端、在线更新与回滚服务
---

# systemd 服务

<p class="doc-lead">使用 systemd 管理长期运行的后端服务，以及按任务 ID 启动的 OTA 更新和回滚 oneshot。</p>

<div class="doc-meta">
  <div><span>主服务</span><strong>xpayincus-backend</strong></div>
  <div><span>运行用户</span><strong>xpayincus</strong></div>
  <div><span>工作目录</span><strong>/opt/xpayincus/current</strong></div>
</div>

::: tip 配置来源
优先复制仓库中的受控模板，不要手工拼接 unit。修改后使用 `systemctl daemon-reload` 并检查服务状态。
:::

## 后端服务

模板文件：

```text
deploy/xpayincus-backend.service.example
```

安装：

```bash
sudo cp deploy/xpayincus-backend.service.example /etc/systemd/system/xpayincus-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now xpayincus-backend
sudo systemctl status xpayincus-backend --no-pager
```

模板的关键运行参数：

```text
User=xpayincus
Group=xpayincus
WorkingDirectory=/opt/xpayincus/current
EnvironmentFile=/opt/xpayincus/.env
ExecStartPre=/usr/bin/bash -lc 'cd /opt/xpayincus/current/server && pnpm exec prisma migrate deploy'
ExecStart=/usr/bin/node /opt/xpayincus/current/server/dist/app.js
```

`WorkingDirectory` 指向 `/opt/xpayincus/current`，这样 OTA 切换 symlink 后重启服务即可进入新 release。

## 权限边界

后端服务使用 `ProtectSystem=strict` 和 `ProtectHome=true`，只允许写入 XPayincus 运行目录：

```text
/opt/xpayincus
/opt/xpayincus/current
/opt/xpayincus/releases
/opt/xpayincus/update-logs
```

不要把 `/`、`/etc` 或数据库目录加入 `ReadWritePaths`。支付密钥、数据库地址、OAuth secret、SMTP 密码和安装 token 只应放在 `/opt/xpayincus/.env` 或后台加密配置里。

## 在线更新服务

在线更新和回滚 oneshot 以 **root** 运行，但入口被收敛到一个固定的 root helper，再配合受限 sudoers、参数校验 wrapper 和可信文件清单，避免把任意 root 能力暴露给服务用户。

### 1. 安装 root helper

从**已通过 SHA256 校验**的 release 中取出 helper，安装为 `root:root 0755`（下列 `deploy/*.example` 即 `/opt/xpayincus/current` 里的受控模板）：

```bash
sudo install -d -o root -g root -m 0755 /usr/local/libexec/xpayincus /usr/local/libexec/xpayincus/ota-path
sudo install -o root -g root -m 0755 deploy/xpayincus-online-task.sh.example        /usr/local/libexec/xpayincus/xpayincus-online-task
sudo install -o root -g root -m 0755 deploy/xpayincus-systemctl-wrapper.sh.example  /usr/local/libexec/xpayincus/systemctl
sudo install -o root -g root -m 0755 deploy/xpayincus-ota-chown-wrapper.sh.example  /usr/local/libexec/xpayincus/ota-path/chown
# OTA 运行期缓存与可信清单目录
sudo install -d -o root -g root -m 0755 /var/cache/xpayincus-ota /var/lib/xpayincus-ota/manifests
# 加固属主：code / current / releases 归 root，只保留运行期目录对 xpayincus 可写
sudo /usr/local/libexec/xpayincus/xpayincus-online-task harden
```

- `xpayincus-online-task`：唯一的 OTA 入口。`update <id>` / `rollback <id>` 执行前会先校验可信文件清单（SHA256）、属主和 git 控制，再以 root 运行 `server/dist/scripts/run-system-update-task.js`；任务成功后自动重新 seal 清单。
- `systemctl`（wrapper）：服务用户唯一能经 sudo 调到的 systemctl。它只接受 `start --no-block xpayincus-online-(update|rollback)@<正整数>.service`，其余参数一律拒绝。

### 2. 安装 systemd 单元

模板文件：

```text
deploy/xpayincus-online-update@.service.example
deploy/xpayincus-online-rollback@.service.example
```

安装：

```bash
sudo cp deploy/xpayincus-online-update@.service.example /etc/systemd/system/xpayincus-online-update@.service
sudo cp deploy/xpayincus-online-rollback@.service.example /etc/systemd/system/xpayincus-online-rollback@.service
sudo systemctl daemon-reload
```

两个单元都是 `Type=oneshot`、`User=root`，入口固定为 root helper，**不**直接指向 release 里的脚本：

```text
ExecStart=/usr/local/libexec/xpayincus/xpayincus-online-task update %i
ExecStart=/usr/local/libexec/xpayincus/xpayincus-online-task rollback %i
```

后台 OTA 为每个任务生成任务 ID，再经受限 sudoers 调用 wrapper 启动对应单元：

```text
sudo /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-update@<taskId>.service
sudo /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-rollback@<taskId>.service
```

## 受限 sudoers

只授权服务用户调用 **root helper wrapper**（不是 `/usr/bin/systemctl`），并用 `secure_path` 固定命令查找路径：

```bash
sudo tee /etc/sudoers.d/xpayincus-online-update >/dev/null << 'EOF'
Defaults:xpayincus !requiretty
Defaults:xpayincus secure_path=/usr/local/libexec/xpayincus:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
xpayincus ALL=(root) NOPASSWD: /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-update@*.service, /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-rollback@*.service
EOF
sudo chmod 440 /etc/sudoers.d/xpayincus-online-update
sudo visudo -cf /etc/sudoers.d/xpayincus-online-update
```

该规则只允许 `xpayincus` 通过 root-owned wrapper 启动在线更新/回滚 oneshot：wrapper 先校验单元名和任务 ID，helper 再校验可信清单、属主和 git 控制后才真正执行——服务用户拿不到任意 root shell，也无法改写代码树或清单。

### 首次写入可信清单

单元和 sudoers 就绪后，seal 一次当前 release，写入可信文件清单（此后每次 OTA 前都据此校验，成功后自动重新 seal）：

```bash
sudo /usr/local/libexec/xpayincus/xpayincus-online-task seal
```

## 日志

```bash
sudo journalctl -u xpayincus-backend -n 200 --no-pager
sudo journalctl -u 'xpayincus-online-update@*' -n 200 --no-pager
sudo journalctl -u 'xpayincus-online-rollback@*' -n 200 --no-pager
```

后台 OTA 任务日志还会写入 `SYSTEM_UPDATE_LOG_DIR`，默认是 `/opt/xpayincus/update-logs`。

## Agent 服务

宿主机 Agent 由后台生成的 Agent 安装命令写入 `xpayincus-agent.service`。当前模板会限制 Agent 自身资源和 journal 写入速率：

```text
CPUQuota=20%
MemoryMax=256M
TasksMax=128
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=120
```

如果宿主机曾经安装过旧 Agent，需要在面板更新后重新复制后台 Agent 安装命令并在宿主机执行一次。只靠 Agent 二进制自升级不会自动改写旧 systemd service，因此旧节点可能仍缺少 CPU、内存和日志速率限制。

## 验证

```bash
systemctl is-active xpayincus-backend
curl -fsS http://127.0.0.1:3001/api/health
```

如果服务启动失败，先看 `journalctl -u xpayincus-backend`，再检查 `/opt/xpayincus/.env`、数据库连接、`/opt/xpayincus/current` symlink 和 `server/dist/app.js` 是否存在。
