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

const subscribers = new Map<string, Set<Subscriber>>()

export function publishInstanceMonitoring(scope: string, event: InstanceMonitoringStreamEvent): void {
  for (const subscriber of subscribers.get(scope) ?? []) subscriber(event)
}

export function subscribeInstanceMonitoring(scope: string, subscriber: Subscriber): () => void {
  const current = subscribers.get(scope) ?? new Set<Subscriber>()
  current.add(subscriber)
  subscribers.set(scope, current)
  return () => {
    current.delete(subscriber)
    if (current.size === 0 && subscribers.get(scope) === current) subscribers.delete(scope)
  }
}

export function getInstanceMonitoringSubscriberCount(scope: string): number {
  return subscribers.get(scope)?.size ?? 0
}
