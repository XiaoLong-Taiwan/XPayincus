import { onBeforeUnmount, onDeactivated, ref } from 'vue'
import type { HostInstallDetails } from '@/types/api'

export function useHostInstallDetails() {
  const installDetails = ref<HostInstallDetails | null>(null)
  let generation = 0

  function clearInstallDetails() {
    generation += 1
    installDetails.value = null
  }

  async function loadInstallDetails<T extends Partial<HostInstallDetails>>(request: () => Promise<T>) {
    clearInstallDetails()
    const currentGeneration = generation
    const response = await request()
    if (currentGeneration !== generation) return null
    if (response.installCommand && response.panelUrl && response.installScriptUrl && response.installToken) {
      if (response.installCommand.includes(response.installToken)) throw new Error('Invalid installation response')
      installDetails.value = {
        installCommand: response.installCommand,
        panelUrl: response.panelUrl,
        installScriptUrl: response.installScriptUrl,
        installToken: response.installToken,
        installTokenExpiresAt: response.installTokenExpiresAt
      }
    }
    return response
  }

  onDeactivated(clearInstallDetails)
  onBeforeUnmount(clearInstallDetails)

  return { installDetails, clearInstallDetails, loadInstallDetails }
}
