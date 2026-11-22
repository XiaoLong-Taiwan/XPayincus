export interface InstanceMonitoringSample {
  sampledAt: string
  online: boolean
  metrics: Record<string, number>
}

export interface InstanceMonitoringOfflineEvent {
  type: 'offline'
  online: false
}

export type InstanceMonitoringStreamEvent = InstanceMonitoringSample | InstanceMonitoringOfflineEvent
type Subscriber = (event: InstanceMonitoringStreamEvent) => void

const subscribers = new Map<number, Set<Subscriber>>()

export function publishInstanceMonitoring(instanceId: number, event: InstanceMonitoringStreamEvent): void {
  for (const subscriber of subscribers.get(instanceId) ?? []) subscriber(event)
}

export function subscribeInstanceMonitoring(instanceId: number, subscriber: Subscriber): () => void {
  const current = subscribers.get(instanceId) ?? new Set<Subscriber>()
  current.add(subscriber)
  subscribers.set(instanceId, current)
  return () => {
    current.delete(subscriber)
    if (current.size === 0) subscribers.delete(instanceId)
  }
}

export function getInstanceMonitoringSubscriberCount(instanceId: number): number {
  return subscribers.get(instanceId)?.size ?? 0
}
