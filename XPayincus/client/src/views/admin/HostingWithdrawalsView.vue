<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/admin'
import { useToast } from '@/stores/toast'

const { t } = useI18n()
const toast = useToast()
const rows = ref<Array<{ id: number; username?: string; amount: number; target: string; status: string; paymentMethod?: string | null; paymentReference?: string | null; paymentProof?: string | null; failureReason?: string | null; createdAt: string }>>([])
const loading = ref(false)
const busyId = ref<number | null>(null)
const forms = ref<Record<number, { paymentMethod: string; paymentReference: string; paymentProof: string; reason: string }>>({})

async function load() {
  loading.value = true
  try {
    const response = await api.admin.getHostingWithdrawals({ page: 1, pageSize: 100 })
    rows.value = response.withdrawals
    for (const row of rows.value) forms.value[row.id] ||= { paymentMethod: '', paymentReference: '', paymentProof: '', reason: '' }
  } catch (error: any) {
    toast.error(error?.message || t('admin.hostingWithdrawals.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function update(row: (typeof rows.value)[number], status: 'processing' | 'paid' | 'failed') {
  const form = forms.value[row.id]
  if (status === 'paid' && (!form.paymentMethod.trim() || !form.paymentReference.trim() || !form.paymentProof.trim())) {
    toast.error(t('admin.hostingWithdrawals.proofRequired'))
    return
  }
  if (status === 'failed' && !form.reason.trim()) {
    toast.error(t('admin.hostingWithdrawals.reasonRequired'))
    return
  }
  if (!window.confirm(t('admin.hostingWithdrawals.confirm', { status: t(`admin.hostingWithdrawals.status_${status}`), id: row.id }))) return
  busyId.value = row.id
  try {
    await api.admin.updateHostingWithdrawalPayment(row.id, { status, ...form })
    toast.success(t('admin.hostingWithdrawals.updateSuccess'))
    await load()
  } catch (error: any) {
    toast.error(error?.message || t('admin.hostingWithdrawals.updateFailed'))
  } finally {
    busyId.value = null
  }
}

async function approve(row: (typeof rows.value)[number]) {
  if (!window.confirm(t('admin.hostingWithdrawals.confirm', { status: t('admin.hostingWithdrawals.status_approved'), id: row.id }))) return
  busyId.value = row.id
  try {
    await api.admin.approveHostingWithdrawal(row.id)
    toast.success(t('admin.hostingWithdrawals.updateSuccess'))
    await load()
  } catch (error: any) {
    toast.error(error?.message || t('admin.hostingWithdrawals.updateFailed'))
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="page-title">{{ t('admin.hostingWithdrawals.title') }}</h1>
        <p class="mt-1 text-sm text-themed-muted">{{ t('admin.hostingWithdrawals.description') }}</p>
      </div>
      <button class="btn btn-secondary" :disabled="loading" @click="load">{{ t('common.refresh') }}</button>
    </header>
    <p v-if="loading && !rows.length" class="text-sm text-themed-muted">{{ t('common.loading') }}</p>
    <div v-else-if="!rows.length" class="py-12 text-center text-sm text-themed-muted">{{ t('admin.hostingWithdrawals.empty') }}</div>
    <div v-else class="divide-y divide-themed">
      <article v-for="row in rows" :key="row.id" class="grid gap-4 py-5 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.2fr)]">
        <div class="space-y-1 text-sm">
          <h2 class="font-semibold text-themed">#{{ row.id }} · {{ row.username || row.id }}</h2>
          <p class="font-mono">¥{{ Number(row.amount).toFixed(2) }} · {{ row.target }}</p>
          <p>{{ t(`admin.hostingWithdrawals.status_${row.status}`) }} · {{ new Date(row.createdAt).toLocaleString() }}</p>
          <p v-if="row.paymentReference" class="break-all">{{ row.paymentReference }}</p>
          <p v-if="row.paymentProof" class="break-words">{{ row.paymentProof }}</p>
        </div>
        <div v-if="row.target === 'usdt' && row.status === 'pending'" class="flex items-start">
          <button class="btn btn-secondary" :disabled="busyId === row.id" @click="approve(row)">{{ t('admin.hostingWithdrawals.action_approve') }}</button>
        </div>
        <div v-else-if="row.target === 'usdt' && ['approved', 'processing'].includes(row.status)" class="grid gap-2 sm:grid-cols-2">
          <input v-model="forms[row.id].paymentMethod" class="input" :placeholder="t('admin.hostingWithdrawals.paymentMethod')" />
          <input v-model="forms[row.id].paymentReference" class="input" :placeholder="t('admin.hostingWithdrawals.paymentReference')" />
          <textarea v-model="forms[row.id].paymentProof" class="input min-h-20 sm:col-span-2" :placeholder="t('admin.hostingWithdrawals.paymentProof')" />
          <input v-model="forms[row.id].reason" class="input sm:col-span-2" :placeholder="t('admin.hostingWithdrawals.failureReason')" />
          <div class="flex flex-wrap gap-2 sm:col-span-2">
            <button v-if="row.status === 'approved'" class="btn btn-secondary" :disabled="busyId === row.id" @click="update(row, 'processing')">{{ t('admin.hostingWithdrawals.action_processing') }}</button>
            <button class="btn btn-primary" :disabled="busyId === row.id" @click="update(row, 'paid')">{{ t('admin.hostingWithdrawals.action_paid') }}</button>
            <button class="btn btn-danger" :disabled="busyId === row.id" @click="update(row, 'failed')">{{ t('admin.hostingWithdrawals.action_failed') }}</button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
