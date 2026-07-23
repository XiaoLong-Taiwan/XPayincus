import { IProxyStrategy, ProxyDeviceResult, ProxyDeviceConfig, NamedProxyDeviceConfig } from './IProxyStrategy.js'

export class KvmProxyStrategy implements IProxyStrategy {
    createProxyDevice(
        hostNatIp: string | null | undefined,
        hostIpv6: string | null | undefined,
        networkMode: string,
        protocol: string,
        publicPort: number,
        privatePort: number
    ): ProxyDeviceResult {
        if (networkMode === 'nat_ipv6_nat') {
            const deviceConfigs: NamedProxyDeviceConfig[] = []

            if (hostNatIp && hostNatIp !== '0.0.0.0') {
                deviceConfigs.push({
                    deviceConfig: {
                        type: 'proxy',
                        listen: `${protocol}:${hostNatIp}:${publicPort}`,
                        connect: `${protocol}:0.0.0.0:${privatePort}`,
                        nat: 'true'
                    }
                })
            }

            if (hostIpv6) {
                deviceConfigs.push({
                    nameSuffix: '-v6',
                    deviceConfig: {
                        type: 'proxy',
                        listen: `${protocol}:[${hostIpv6}]:${publicPort}`,
                        connect: `${protocol}:0.0.0.0:${privatePort}`
                    }
                })
            }

            if (deviceConfigs.length === 0) {
                return {
                    success: false,
                    errorMessage: 'Current host has no usable NAT public IPv4 or IPv6 address for KVM port mapping.'
                }
            }

            return { success: true, deviceConfigs }
        }

        let listenAddr: string

        if (['ipv6_only', 'ipv6_nat'].includes(networkMode)) {
            if (!hostIpv6) {
                return {
                    success: false,
                    errorMessage: 'Current host has no public IPv6/NAT IPv6 configured for KVM port mapping.'
                }
            }
            listenAddr = `[${hostIpv6}]`
        } else {
            if (!hostNatIp || hostNatIp === '0.0.0.0') {
                return {
                    success: false,
                    errorMessage: '当前宿主机没有可用于 KVM 端口映射的本机 IPv4 监听地址。请在节点 NAT 设置中配置本机监听 IPv4（nat_bind_ip），通常填写宿主机网卡上的公网或内网可绑定 IPv4。'
                }
            }
            listenAddr = hostNatIp
        }

        const connectAddr = networkMode === 'ipv6_only' ? '[::]' : '0.0.0.0'

        const deviceConfig: ProxyDeviceConfig = {
            type: 'proxy',
            listen: `${protocol}:${listenAddr}:${publicPort}`,
            connect: `${protocol}:${connectAddr}:${privatePort}`
        }

        if (networkMode !== 'ipv6_nat') {
            deviceConfig.nat = 'true'
        }

        return { success: true, deviceConfig }
    }
}
