# 在线 Demo

Demo 环境用于快速体验 XPayincus 的用户端和管理后台，不作为生产部署入口，也不作为支付、密钥、资源交付或隐私数据的真实测试环境。

## 访问入口

当前仓库不提供公共 Demo。部署后请使用你自己的用户端与管理后台域名。

## 使用边界

- 不要在非生产测试环境填写真实支付信息、API 密钥、SMTP 密码或其他敏感配置。
- 正式部署请使用自己的用户端域名和后台域名，参考 [一键安装](/deployment/one-click-install) 与 [环境变量](/deployment/environment)。
- Demo 只用于查看界面、功能结构和基础操作流程，不作为生产环境使用。

## 与正式部署的区别

- `panel.example.com` 和 `admin.example.com` 是文档中的占位示例域名，需要替换为你自己的域名。
- 生产环境需要单独配置 PostgreSQL、安装脚本保留的 Redis 服务、Incus 节点、Agent、支付渠道、SMTP、对象存储和通知通道。
