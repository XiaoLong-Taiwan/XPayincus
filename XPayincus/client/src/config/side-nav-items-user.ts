export interface MenuItem {
  name?: string
  path?: string
  icon?: string
  label?: string
  labelText?: string
  divider?: boolean
}

export const isAdminEntry = false

export const navMenuItems: MenuItem[] = [
  { divider: true, label: 'nav.main' },
  { name: 'dashboard', path: '/dashboard', icon: 'home', label: 'nav.dashboard' },
  { name: 'instances', path: '/instances', icon: 'server', label: 'nav.instances' },
  { name: 'tasks', path: '/tasks', icon: 'logs', label: 'operations.title' },
  { name: 'terminal', path: '/terminal', icon: 'terminal', label: 'nav.terminal' },
  { divider: true, label: 'nav.billing' },
  { name: 'wallet', path: '/wallet', icon: 'wallet', label: 'nav.wallet' },
  { name: 'orders', path: '/orders', icon: 'card', label: 'nav.orders' },
  { name: 'gift-cards', path: '/gift-cards', icon: 'gift', label: 'nav.giftCards' },
  { name: 'invites', path: '/invites', icon: 'key', label: 'nav.invites' },
  { name: 'friends', path: '/friends', icon: 'users', label: 'nav.friends' },
  { name: 'transfers', path: '/transfers', icon: 'transfer', label: 'nav.transfers' },
  { divider: true, label: 'nav.support' },
  { name: 'tickets', path: '/tickets', icon: 'ticket', label: 'nav.tickets' },
  { name: 'help', path: '/help', icon: 'help', label: 'nav.help' },
  { name: 'logs', path: '/logs', icon: 'logs', label: 'nav.logs' },
  { divider: true, label: 'nav.resources' },
  { name: 'host-status', path: '/host-status', icon: 'pulse', label: 'nav.hostStatus' },
  { name: 'hosting-application', path: '/hosting-application', icon: 'clipboard', labelText: '托管上架申请' },
  { divider: true, label: 'nav.system' },
  { name: 'extensions', path: '/extensions', icon: 'puzzle', label: 'nav.extensions' },
  { name: 'entertainment', path: '/entertainment', icon: 'gift', label: 'nav.entertainment' },
  { name: 'profile', path: '/profile', icon: 'settings', label: 'nav.settings' },
]
