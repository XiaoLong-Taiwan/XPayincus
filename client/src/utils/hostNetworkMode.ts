export type HostNetworkMode =
  | 'nat'
  | 'nat_ipv6'
  | 'nat_ipv6_nat'
  | 'ipv6_only'
  | 'ipv6_nat'
  | 'public_ipv4'
  | 'public_ipv4_ipv6'

export interface HostNetworkModeConfig {
  ipv6Mode: 1 | 2 | 3
  needsIpv6Subnet: boolean
  needsNatIpv4: boolean
  needsNatIpv6: boolean
}

export const hostNetworkModes: HostNetworkMode[] = [
  'nat',
  'nat_ipv6',
  'nat_ipv6_nat',
  'ipv6_only',
  'ipv6_nat',
  'public_ipv4',
  'public_ipv4_ipv6'
]

export const hostNetworkModeConfig: Record<HostNetworkMode, HostNetworkModeConfig> = {
  nat: { ipv6Mode: 3, needsIpv6Subnet: false, needsNatIpv4: true, needsNatIpv6: false },
  nat_ipv6: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: true, needsNatIpv6: false },
  nat_ipv6_nat: { ipv6Mode: 2, needsIpv6Subnet: false, needsNatIpv4: true, needsNatIpv6: true },
  ipv6_only: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: false, needsNatIpv6: false },
  ipv6_nat: { ipv6Mode: 2, needsIpv6Subnet: false, needsNatIpv4: false, needsNatIpv6: true },
  public_ipv4: { ipv6Mode: 3, needsIpv6Subnet: false, needsNatIpv4: false, needsNatIpv6: false },
  public_ipv4_ipv6: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: false, needsNatIpv6: false }
}

export function isHostNetworkMode(value: unknown): value is HostNetworkMode {
  return typeof value === 'string' && hostNetworkModes.includes(value as HostNetworkMode)
}

export function inferHostNetworkMode(input: {
  ipv6Mode?: number
  hasNatIpv4: boolean
  hasNatIpv6: boolean
  hasPublicIpv4: boolean
}): HostNetworkMode {
  if (input.ipv6Mode === 1) {
    if (input.hasNatIpv4) return 'nat_ipv6'
    return input.hasPublicIpv4 ? 'public_ipv4_ipv6' : 'ipv6_only'
  }
  if (input.ipv6Mode === 2) return input.hasNatIpv4 ? 'nat_ipv6_nat' : 'ipv6_nat'
  return input.hasPublicIpv4 && !input.hasNatIpv4 ? 'public_ipv4' : 'nat'
}
