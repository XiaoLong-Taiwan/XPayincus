type RuntimeConfig = {
  apiBaseUrl?: string
  customerBaseUrl?: string
  adminBaseUrl?: string
}

declare global {
  interface Window {
    __XPAYINCUS_CONFIG__?: RuntimeConfig
  }
}

const config = window.__XPAYINCUS_CONFIG__

export const API_BASE_URL = config?.apiBaseUrl?.trim() || import.meta.env.VITE_API_BASE_URL || '/api'
export const CUSTOMER_BASE_URL = config?.customerBaseUrl?.trim() || import.meta.env.VITE_CUSTOMER_BASE_URL?.trim()
export const ADMIN_BASE_URL = config?.adminBaseUrl?.trim() || import.meta.env.VITE_ADMIN_BASE_URL?.trim()
