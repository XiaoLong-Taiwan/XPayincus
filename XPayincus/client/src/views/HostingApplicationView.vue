<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api, { type HostingAccessApplication } from '@/api'
import SkeletonLoader from '@/components/SkeletonLoader.vue'
import { useToast } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'HostingApplicationView' })

const toast = useToast()
const authStore = useAuthStore()
const { t } = useI18n()
const application = ref<HostingAccessApplication | null>(null)
const reason = ref('')
const loading = ref(true)
const loadFailed = ref(false)
const submitting = ref(false)

const statusText = computed(() => {
  if (!application.value) return t('hosting.application.status.notSubmitted')
  if (application.value.status === 'pending') return t('hosting.application.status.pending')
  if (application.value.status === 'approved') return t('hosting.application.status.approved')
  return t('hosting.application.status.rejected')
})

async function loadApplication() {
  loading.value = true
  loadFailed.value = false
  try {
    const response = await api.hosting.getApplication()
    application.value = response.application
    reason.value = response.application?.status === 'rejected' ? response.application.reason : ''
    await authStore.fetchCurrentUser()
  } catch {
    loadFailed.value = true
    toast.error(t('hosting.application.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function submitApplication() {
  const value = reason.value.trim()
  if (!value) {
    toast.error(t('hosting.application.reasonRequired'))
    return
  }
  submitting.value = true
  try {
    const response = await api.hosting.submitApplication(value)
    application.value = response.application
    reason.value = ''
    toast.success(t('hosting.application.submitSuccess'))
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('hosting.application.submitFailed'))
  } finally {
    submitting.value = false
  }
}

onMounted(loadApplication)
</script>

<template>
  <main class="kawaii-page space-y-5 animate-fade-in">
    <div class="page-header flex-col gap-3 sm:flex-row sm:items-start sm:gap-0">
      <div class="min-w-0">
        <p class="page-kicker">{{ t('hosting.application.eyebrow') }}</p>
        <h1 class="page-title">{{ t('hosting.application.title') }}</h1>
        <p class="page-description">{{ t('hosting.application.description') }}</p>
      </div>
      <span
        class="inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-sm font-medium"
        :class="{
          'border-themed bg-themed-secondary text-themed-muted': !application?.status,
          'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300': application?.status === 'pending',
          'border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950/30 dark:text-green-300': application?.status === 'approved',
          'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300': application?.status === 'rejected'
        }"
      >
        {{ loading ? t('hosting.application.loading') : statusText }}
      </span>
    </div>

    <SkeletonLoader v-if="loading" type="card" />

    <div v-else-if="loadFailed" class="card p-8 text-center">
      <p class="text-themed-muted">{{ t('hosting.application.loadFailed') }}</p>
      <button type="button" class="btn btn-secondary mt-4" @click="loadApplication">
        {{ t('hosting.application.retry') }}
      </button>
    </div>

    <section v-else class="card space-y-6 p-5 sm:p-7">
      <div v-if="application?.reviewReason" class="rounded-lg border-l-4 border-amber-500 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
        <strong class="text-themed">{{ t('hosting.application.reviewReason') }}</strong>
        <p class="mt-2 whitespace-pre-wrap text-themed-muted">{{ application.reviewReason }}</p>
      </div>

      <form v-if="!application || application.status === 'rejected'" class="space-y-4" @submit.prevent="submitApplication">
        <div class="space-y-2">
          <label for="reason" class="block text-sm font-medium text-themed">{{ t('hosting.application.reasonLabel') }}</label>
          <textarea
            id="reason"
            v-model="reason"
            class="input min-h-36 w-full resize-y"
            maxlength="1000"
            rows="7"
            :placeholder="t('hosting.application.reasonPlaceholder')"
          />
        </div>
        <button type="submit" class="btn btn-primary" :disabled="submitting">
          {{ submitting ? t('hosting.application.submitting') : application ? t('hosting.application.resubmit') : t('hosting.application.submit') }}
        </button>
      </form>

      <nav v-else-if="application?.status === 'approved'" class="flex flex-wrap gap-3" :aria-label="t('hosting.application.management')">
        <RouterLink to="/resources/hosts" class="btn btn-primary">{{ t('hosting.application.manageHosts') }}</RouterLink>
        <RouterLink to="/resources/packages" class="btn btn-secondary">{{ t('hosting.application.managePackages') }}</RouterLink>
        <RouterLink to="/hosting-wallet" class="btn btn-secondary">{{ t('hosting.application.hostingWallet') }}</RouterLink>
      </nav>

      <div v-else class="rounded-lg border border-themed bg-themed-secondary p-4 text-themed-muted">
        <p>{{ t('hosting.application.pendingMessage') }}</p>
      </div>
    </section>
  </main>
</template>
