export interface NetworkProbeTarget {
  id: string
  label: string
  host: string
  packageId: number
  hostId: number
  tcpPorts: number[]
  icmp: boolean
  https: boolean
}

export interface NetworkProbeSample {
  durationMs: number
  success: boolean
}

export interface NetworkProbeRecordInput {
  packageId: number
  hostId: number
  targetId: string
  source: 'browser' | 'manual-local'
  method: 'https' | 'tcp' | 'icmp'
  port?: number
  measuredAt: string
  samples: NetworkProbeSample[]
  acknowledgedUnverified?: boolean
}

export interface NetworkProbeRecord {
  id: string
  packageId: number
  hostId: number
  targetId: string
  targetHost: string
  targetLabel: string
  source: NetworkProbeRecordInput['source']
  method: NetworkProbeRecordInput['method']
  port: number | null
  measuredAt: string
  recordedAt: string
  verified: false
  samples: NetworkProbeSample[]
}
