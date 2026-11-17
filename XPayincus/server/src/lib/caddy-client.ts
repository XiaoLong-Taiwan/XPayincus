/**
 * Caddy API 客户端
 * 通过 Agent WSS 隧道调用宿主机本机 Caddy Admin API
 */

import { Dispatcher, request as undiciRequest } from 'undici'
import { AgentTunnelDispatcher } from './agent-tunnel-dispatcher.js'
import { getAddressFamily, normalizeNetworkHost } from './network-address.js'

// 请求超时配置（毫秒）
const REQUEST_TIMEOUT = 30000 // 30秒

export interface CaddyClientConfig {
  hostId?: number
  host: string // 宿主机 IP 或域名
  port: number // 固定为本机 Caddy Admin API 端口 2019
  username?: string
  password?: string
  caPath?: string // Caddy 管理端 TLS CA PEM 路径（未传时使用 CADDY_CA_PATH）
  serverName?: string // TLS 证书名称（默认匹配安装脚本生成的 caddy-admin）
}

export interface CaddyRoute {
  '@id'?: string
  match?: Array<{ host?: string[]; protocol?: string }>
  handle?: Array<{
    handler: string
    upstreams?: Array<{ dial: string }>
    routes?: CaddyRoute[]
  }>
  terminal?: boolean
}

class CaddyApiError extends Error {
  constructor(
    readonly statusCode: number,
    responseBody: string
  ) {
    super(`Caddy API error: ${statusCode} ${responseBody}`)
    this.name = 'CaddyApiError'
  }
}

/**
 * Caddy API 客户端类
 */
export class CaddyClient {
  private baseUrl: string
  private agent: Dispatcher

  constructor(config: CaddyClientConfig) {
    this.baseUrl = 'http://127.0.0.1:2019'
    this.agent = new AgentTunnelDispatcher(async () => {
      if (!Number.isSafeInteger(config.hostId) || config.hostId! < 1) throw new Error('TUNNEL_HOST_ID_REQUIRED')
      return config.hostId!
    }, 'caddy')
  }

  /**
   * 发起 API 请求
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

    try {
      const response = await undiciRequest(url, {
        method,
        dispatcher: this.agent,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      })

      if (response.statusCode >= 400) {
        const errorText = await response.body.text()
        throw new CaddyApiError(response.statusCode, errorText)
      }

      // 某些请求没有响应体
      const text = await response.body.text()
      if (!text) {
        return {} as T
      }
      
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 获取 Caddy 配置
   */
  async getConfig(): Promise<unknown> {
    return this.request('GET', '/config/')
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    try {
      console.log(`[Caddy Client] 测试连接: ${this.baseUrl}/config/`)
      await this.getConfig()
      console.log(`[Caddy Client] 连接成功: ${this.baseUrl}`)
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // 检查是否是超时错误
      const isTimeout = errorMessage.includes('abort') || errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')
      console.error(`[Caddy Client] 连接失败: ${this.baseUrl}`, {
        error: errorMessage,
        isTimeout,
        stack: error instanceof Error ? error.stack : undefined
      })
      return false
    }
  }

  /**
   * 添加反代站点
   * 
   * 架构说明：
   * - 使用统一的 `sites` 服务器监听 :80 和 :443
   * - HTTPS 站点：正常配置，Caddy 自动处理证书和重定向
   * - HTTP 站点：添加 protocol 匹配，仅响应 HTTP 请求
   * 
   * @param domain 域名
   * @param targetIp 目标 IP (实例内网 IP)
   * @param targetPort 目标端口
   * @param httpsEnabled 是否启用 HTTPS（自动申请 Let's Encrypt 证书）
   */
  async addSite(domain: string, targetIp: string, targetPort: number, httpsEnabled: boolean = true): Promise<void> {
    const routeId = `site-${Buffer.from(domain).toString('base64url')}`
    const normalizedTargetIp = normalizeNetworkHost(targetIp)
    const targetAddress = getAddressFamily(normalizedTargetIp) === 6
      ? `[${normalizedTargetIp}]`
      : normalizedTargetIp
    
    // 构建路由配置
    const route: CaddyRoute = {
      '@id': routeId,
      match: [{ host: [domain] }],
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${targetAddress}:${targetPort}` }]
      }],
      terminal: true
    }

    // HTTP-only 站点：添加协议匹配，仅响应 HTTP 请求
    if (!httpsEnabled) {
      route.match = [{ host: [domain], protocol: 'http' }]
    }

    // 统一使用 sites 服务器
    const serverName = 'sites'
    const serverPath = `/config/apps/http/servers/${serverName}`
    const routesPath = `${serverPath}/routes`

    // routes 是数组；POST 只追加当前路由，不会替换现有路由集合。
    try {
      await this.request('POST', routesPath, route)
      return
    } catch (postError) {
      // 网络、认证、5xx 等错误绝不能被当作服务器不存在。
      if (!(postError instanceof CaddyApiError) || postError.statusCode !== 404) {
        throw postError
      }
    }

    // POST 的 404 之后再读取复核，区分 server 不存在与 routes 字段不存在。
    let existingServer: { routes?: CaddyRoute[] } | undefined
    try {
      existingServer = await this.request<{ routes?: CaddyRoute[] }>('GET', serverPath)
    } catch (getServerError) {
      if (!(getServerError instanceof CaddyApiError) || getServerError.statusCode !== 404) {
        throw getServerError
      }
    }

    if (existingServer) {
      if (Array.isArray(existingServer.routes)) {
        await this.request('POST', routesPath, route)
      } else {
        // server 存在但 routes 字段不存在；只在精确字段路径严格创建数组。
        await this.request('PUT', routesPath, [route])
      }
      return
    }

    // 已明确确认 sites 不存在；PUT 在对象路径上是严格创建，不会替换已有 server。
    const serverConfig: Record<string, unknown> = {
      listen: [':80', ':443'],
      routes: [route],
      automatic_https: {
        disable_redirects: true
      }
    }

    try {
      await this.request('PUT', serverPath, serverConfig)
      return
    } catch (putError) {
      // 只有明确 404 才可能是父级 http 应用不存在。
      if (!(putError instanceof CaddyApiError) || putError.statusCode !== 404) {
        throw putError
      }
    }

    const httpAppPath = '/config/apps/http'
    try {
      await this.request('GET', httpAppPath)
    } catch (getHttpError) {
      if (!(getHttpError instanceof CaddyApiError) || getHttpError.statusCode !== 404) {
        throw getHttpError
      }

      // 父级也已明确确认不存在；严格创建，不覆盖任何现有 HTTP 配置。
      await this.request('PUT', httpAppPath, {
        servers: {
          [serverName]: serverConfig
        }
      })
      return
    }

    // http 在复核期间已由其他请求创建；回到精确 server 路径严格创建。
    await this.request('PUT', serverPath, serverConfig)
  }

  /**
   * 删除反代站点
   * @param domain 域名
   */
  async deleteSite(domain: string): Promise<void> {
    const routeIds = [
      `site-${Buffer.from(domain).toString('base64url')}`,
      `site-${domain.replace(/\./g, '-')}`
    ]

    for (const routeId of new Set(routeIds)) {
      try {
        const route = await this.request<CaddyRoute>('GET', `/id/${routeId}`)
        if (!Array.isArray(route.match) || route.match.length !== 1 ||
            !Array.isArray(route.match[0]?.host) || route.match[0].host.length !== 1 ||
            route.match[0].host[0] !== domain) {
          continue
        }
        await this.request('DELETE', `/id/${routeId}`)
      } catch (error) {
        if (!(error instanceof CaddyApiError) || error.statusCode !== 404) {
          throw error
        }
      }
    }
  }

  /**
   * 获取所有反代站点
   */
  async getSites(): Promise<string[]> {
    try {
      const config = await this.getConfig() as {
        apps?: {
          http?: {
            servers?: Record<string, {
              routes?: CaddyRoute[]
            }>
          }
        }
      }

      const servers = config?.apps?.http?.servers || {}
      const domains: string[] = []

      // 从所有服务器收集域名
      for (const serverName of Object.keys(servers)) {
        const routes = servers[serverName]?.routes || []
        for (const route of routes) {
          if (route.match?.[0]?.host) {
            domains.push(...route.match[0].host)
          }
        }
      }

      return domains
    } catch {
      return []
    }
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<void> {
    // Caddy 会自动应用配置更改，不需要显式 reload
    // 这个方法保留用于兼容性
  }
}

/**
 * 创建 Caddy 客户端实例
 */
export function createCaddyClient(config: CaddyClientConfig): CaddyClient {
  return new CaddyClient(config)
}
