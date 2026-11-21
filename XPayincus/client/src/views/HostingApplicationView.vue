<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api, { type HostingAccessApplication } from '@/api'
import { useToast } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'

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
  <main class="application-page">
    <section class="application-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">{{ t('hosting.application.eyebrow') }}</p>
          <h1>{{ t('hosting.application.title') }}</h1>
        </div>
        <span class="status" :data-status="application?.status || 'none'">{{ loading ? t('hosting.application.loading') : statusText }}</span>
      </div>
      <p class="description">{{ t('hosting.application.description') }}</p>
      <div v-if="application?.reviewReason" class="review-message">
        <strong>{{ t('hosting.application.reviewReason') }}</strong>
        <p>{{ application.reviewReason }}</p>
      </div>
      <button v-if="loadFailed" type="button" @click="loadApplication">{{ t('hosting.application.retry') }}</button>
      <form v-else-if="!loading && (!application || application.status === 'rejected')" class="application-form" @submit.prevent="submitApplication">
        <label for="reason">{{ t('hosting.application.reasonLabel') }}</label>
        <textarea id="reason" v-model="reason" maxlength="1000" rows="7" :placeholder="t('hosting.application.reasonPlaceholder')" />
        <button type="submit" :disabled="submitting">{{ submitting ? t('hosting.application.submitting') : application ? t('hosting.application.resubmit') : t('hosting.application.submit') }}</button>
      </form>
      <nav v-else-if="application?.status === 'approved'" class="approved-links" :aria-label="t('hosting.application.management')">
        <RouterLink to="/resources/hosts">{{ t('hosting.application.manageHosts') }}</RouterLink>
        <RouterLink to="/resources/packages">{{ t('hosting.application.managePackages') }}</RouterLink>
        <RouterLink to="/hosting-wallet">{{ t('hosting.application.hostingWallet') }}</RouterLink>
      </nav>
      <div v-else-if="!loading" class="pending-message">
        <p>{{ t('hosting.application.pendingMessage') }}</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.application-page {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 24px;
}
.application-panel {
  padding: 28px;
  background: var(--bg-primary, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 8px;
}
.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.eyebrow {
  margin: 0 0 6px;
  color: var(--color-text-secondary, #64748b);
  font-size: 13px;
}
h1 {
  margin: 0;
  font-size: 24px;
}
.status {
  padding: 6px 10px;
  border-radius: 6px;
  background: #e2e8f0;
  color: #334155;
  font-size: 13px;
}
.status[data-status='approved'] { background: #dcfce7; color: #166534; }
.status[data-status='pending'] { background: #fef3c7; color: #92400e; }
.status[data-status='rejected'] { background: #fee2e2; color: #991b1b; }
.description, .pending-message p, .review-message p { color: var(--color-text-secondary, #64748b); line-height: 1.6; }
.review-message { margin-top: 20px; padding: 14px; border-left: 3px solid #f59e0b; background: #fffbeb; }
.review-message p { margin: 6px 0 0; }
.application-form { display: grid; gap: 10px; margin-top: 24px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 12px; border: 1px solid var(--color-border, #cbd5e1); border-radius: 6px; font: inherit; }
button { justify-self: start; padding: 10px 18px; border: 0; border-radius: 6px; background: var(--text-primary, #171717); color: var(--bg-primary, #fff); cursor: pointer; }
button:disabled { cursor: wait; opacity: .6; }
.approved-links { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 24px; }
</style>
