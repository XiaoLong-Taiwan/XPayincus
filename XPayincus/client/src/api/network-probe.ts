import axios from 'axios'
import { buildApiUrl } from '@/utils/api-url'
import type { NetworkProbeRecord, NetworkProbeRecordInput, NetworkProbeTarget } from '@/types/network-probe'

async function request<T>(method: 'GET' | 'POST', packageId: number, hostId: number, body?: NetworkProbeRecordInput): Promise<T> {
  const token = localStorage.getItem('token')
  const response = await axios.request<T>({
    method,
    url: buildApiUrl('/network-probe/records'),
    params: method === 'GET' ? { packageId, hostId } : undefined,
    data: body,
    withCredentials: true,
    timeout: 15000,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  return response.data
}

export const networkProbeApi = {
  targets: (packageId: number, hostId: number) => axios.get<{ targets: NetworkProbeTarget[] }>(buildApiUrl('/network-probe/targets'), { params: { packageId, hostId }, withCredentials: true, timeout: 15000, headers: localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {} }).then(response => response.data),
  prepare: (packageId: number, hostId: number, targetId: string) => axios.post<{ target: NetworkProbeTarget; address: string; httpsUrl: string | null }>(buildApiUrl('/network-probe/prepare'), { packageId, hostId, targetId }, { withCredentials: true, timeout: 15000, headers: localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {} }).then(response => response.data),
  records: (targets: Array<{ packageId: number; hostId: number }>) => {
    const uniqueTargets = [...new Map(targets.map(target => [`${target.packageId}:${target.hostId}`, target])).values()]
    return Promise.all(uniqueTargets.map(target => request<{ records: NetworkProbeRecord[]; limit: number; retentionDays: number }>('GET', target.packageId, target.hostId))).then(results => ({
      records: results.flatMap(result => result.records),
      limit: results.length ? Math.min(...results.map(result => result.limit)) : 0,
      retentionDays: results.length ? Math.min(...results.map(result => result.retentionDays)) : 0
    }))
  },
  save: (input: NetworkProbeRecordInput) => request<{ record: NetworkProbeRecord }>('POST', input.packageId, input.hostId, input)
}
