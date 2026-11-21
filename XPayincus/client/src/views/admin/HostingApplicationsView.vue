<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api, { type HostingAccessApplication } from '@/api/admin'
import { useToast } from '@/stores/toast'

const toast = useToast()
const { t } = useI18n()
const applications = ref<HostingAccessApplication[]>([])
const loading = ref(true)
const busyId = ref<number | null>(null)
const filter = ref<'pending' | 'approved' | 'rejected'>('pending')

async function loadApplications() {
  loading.value = true
  try {
    applications.value = (await api.admin.getHostingApplications(filter.value)).applications
  } catch {
    applications.value = []
    toast.error(t('hosting.applications.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function approve(application: HostingAccessApplication) {
  busyId.value = application.id
  try {
    await api.admin.approveHostingApplication(application.id)
    toast.success(t('hosting.applications.approved'))
    await loadApplications()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('hosting.applications.approveFailed'))
  } finally {
    busyId.value = null
  }
}

async function reject(application: HostingAccessApplication) {
  const reviewReason = window.prompt(t('hosting.applications.rejectPrompt'))?.trim()
  if (!reviewReason) return
  busyId.value = application.id
  try {
    await api.admin.rejectHostingApplication(application.id, reviewReason)
    toast.success(t('hosting.applications.rejected'))
    await loadApplications()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('hosting.applications.rejectFailed'))
  } finally {
    busyId.value = null
  }
}

onMounted(loadApplications)
</script>

<template>
  <main class="applications-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">{{ t('hosting.applications.eyebrow') }}</p>
        <h1>{{ t('hosting.applications.title') }}</h1>
      </div>
      <select v-model="filter" @change="loadApplications">
        <option value="pending">{{ t('hosting.applications.status.pending') }}</option>
        <option value="approved">{{ t('hosting.applications.status.approved') }}</option>
        <option value="rejected">{{ t('hosting.applications.status.rejected') }}</option>
      </select>
    </div>
    <div v-if="loading" class="empty">{{ t('hosting.applications.loading') }}</div>
    <div v-else-if="applications.length === 0" class="empty">{{ t('hosting.applications.empty') }}</div>
    <section v-else class="application-list">
      <article v-for="item in applications" :key="item.id" class="application-item">
        <div class="item-heading">
          <div>
            <strong>{{ item.user?.username || t('hosting.applications.userFallback', { id: item.userId }) }}</strong>
            <span>{{ item.user?.email || t('hosting.applications.noEmail') }}</span>
          </div>
          <small>{{ new Date(item.createdAt).toLocaleString() }}</small>
        </div>
        <p class="reason">{{ item.reason }}</p>
        <p v-if="item.reviewReason" class="review-reason">{{ t('hosting.applications.reviewReason') }} {{ item.reviewReason }}</p>
        <div v-if="item.status === 'pending'" class="actions">
          <button :disabled="busyId === item.id" @click="approve(item)">{{ t('hosting.applications.approve') }}</button>
          <button class="danger" :disabled="busyId === item.id" @click="reject(item)">{{ t('hosting.applications.reject') }}</button>
        </div>
      </article>
    </section>
  </main>
</template>

<style scoped>
.applications-page { max-width: 1080px; margin: 0 auto; padding: 32px 24px; }
.page-heading, .item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow { margin: 0 0 6px; color: #64748b; font-size: 13px; }
h1 { margin: 0 0 24px; font-size: 24px; }
select { min-width: 120px; padding: 8px; border: 1px solid var(--color-border, #cbd5e1); border-radius: 6px; background: var(--bg-primary, #fff); color: var(--text-primary, #171717); }
.application-list { display: grid; gap: 12px; }
.application-item { padding: 20px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: var(--bg-primary, #fff); }
.item-heading span, .item-heading small { display: block; margin-top: 5px; color: #64748b; font-size: 13px; }
.reason { margin: 18px 0; white-space: pre-wrap; line-height: 1.6; }
.review-reason { color: #92400e; }
.actions { display: flex; gap: 8px; }
button { padding: 8px 14px; border: 0; border-radius: 6px; background: var(--text-primary, #171717); color: var(--bg-primary, #fff); cursor: pointer; }
button.danger { background: #dc2626; }
button:disabled { cursor: wait; opacity: .6; }
.empty { padding: 48px 0; color: #64748b; text-align: center; }
</style>
