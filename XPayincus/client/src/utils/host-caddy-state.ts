export function canShowHostCaddy(commandIssued: boolean, agent: { enabled?: boolean; status?: string; lastSeenAt?: string | null } | null | undefined): boolean {
  return commandIssued || (agent?.enabled === true && (agent.status === 'online' || Boolean(agent.lastSeenAt)))
}
