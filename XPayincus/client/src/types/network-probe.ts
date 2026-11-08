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
