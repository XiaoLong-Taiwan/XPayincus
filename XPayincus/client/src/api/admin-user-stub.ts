import type { HostWithDetails, PortMapping } from '@/types/api'

type PortList = {
  source: 'managed-mappings'
  completeness: 'partial' | 'managed-only'
  listenerCoverage: 'unavailable'
  readFailures: number
  mappings: Array<{
    id: number
    instanceId: number
    instanceName: string
    instanceStatus: string
    instanceType: 'container' | 'virtual-machine' | 'unknown'
    protocol: 'tcp' | 'udp'
    publicPort: number
    privatePort: number
    addressFamilies: Array<'ipv4' | 'ipv6' | 'unknown'>
    systemManaged: boolean
    remark: string | null
  }>
}

const unavailable = (): never => {
  throw new Error('This operation is unavailable in the customer application')
}

const instancePorts = {
  add: (_id: number, _data: unknown): Promise<PortMapping> => Promise.reject(new Error('This operation is unavailable in the customer application')),
  addBatch: (_id: number, _data: unknown): Promise<never> => Promise.reject(new Error('This operation is unavailable in the customer application')),
  delete: (_id: number, _portId: number): Promise<void> => Promise.reject(new Error('This operation is unavailable in the customer application'))
}

const hosts = {
  getPorts: (_id: number): Promise<PortList> => Promise.reject(new Error('This operation is unavailable in the customer application')),
  list: (_params: Record<string, unknown> = {}): Promise<{ hosts: HostWithDetails[]; total: number; page: number; pageSize: number; totalPages: number }> => Promise.resolve({ hosts: [], total: 0, page: 1, pageSize: 0, totalPages: 0 })
}

export default {
  instancePorts,
  hosts,
  unavailable
}
