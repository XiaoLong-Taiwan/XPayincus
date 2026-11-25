<script setup lang="ts">
import { computed } from 'vue'

interface Step {
  id: number
  label: string
}

const props = withDefaults(defineProps<{
  activeStep: number
  steps?: Step[]
  canContinue?: boolean
  canSubmit?: boolean
  submitting?: boolean
  status?: 'idle' | 'creating' | 'success' | 'failure'
}>(), {
  steps: () => [
    { id: 1, label: '套餐' },
    { id: 2, label: '設定' },
    { id: 3, label: '確認' },
    { id: 4, label: '付款' }
  ],
  canContinue: true,
  canSubmit: false,
  submitting: false,
  status: 'idle'
})

const emit = defineEmits<{
  'update:activeStep': [step: number]
  next: []
  previous: []
  submit: []
}>()

const isCreating = computed(() => props.status === 'creating' || props.submitting)
const isComplete = computed(() => props.status === 'success')
const isFailed = computed(() => props.status === 'failure')

function goToStep(step: Step): void {
  if (isCreating.value || step.id > props.activeStep) return
  emit('update:activeStep', step.id)
}
</script>

<template>
  <div class="purchase-stepper" data-instance-purchase-stepper>
    <div v-if="isCreating" class="mb-4 rounded-lg border border-themed bg-themed-tertiary p-4 text-sm text-themed-secondary" data-state="creating">
      <div class="flex items-center gap-2">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-themed border-t-transparent" />
        <span>正在建立實例，請勿重複提交</span>
      </div>
    </div>
    <div v-else-if="isComplete" class="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-700 dark:text-green-300" data-state="success">
      實例建立請求已送出。
    </div>
    <div v-else-if="isFailed" class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300" data-state="failure">
      建立實例失敗，請檢查錯誤資訊後重試。
    </div>

    <slot />

    <div v-if="!isCreating && !isComplete" class="purchase-stepper-footer border-t border-themed px-2 pb-3 pt-3 sm:px-4 sm:pt-4">
      <nav aria-label="購買步驟" class="grid grid-cols-4 gap-2 pb-3">
        <button
          v-for="step in props.steps"
          :key="step.id"
          type="button"
          class="flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-center text-xs transition-colors sm:flex-row sm:justify-start sm:px-2 sm:text-left sm:text-sm"
          :class="step.id === props.activeStep ? 'border-themed font-semibold text-themed' : step.id < props.activeStep ? 'border-themed text-themed-secondary' : 'border-transparent text-themed-muted'"
          :disabled="isCreating || step.id > props.activeStep"
          :aria-current="step.id === props.activeStep ? 'step' : undefined"
          :aria-label="`${step.label}${step.id < props.activeStep ? '，已完成' : step.id === props.activeStep ? '，目前步驟' : '，尚未完成'}`"
          @click="goToStep(step)"
        >
          <span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-themed font-mono text-[10px]">{{ step.id < props.activeStep ? '✓' : step.id }}</span>{{ step.label }}
        </button>
      </nav>
      <div class="purchase-stepper-actions flex gap-2">
        <button v-if="props.activeStep > 1" type="button" class="btn btn-secondary" :disabled="isCreating" @click="emit('previous')">上一步</button>
        <span v-else />
        <button v-if="props.activeStep < props.steps.length" type="button" class="btn-primary" :disabled="!props.canContinue || isCreating" @click="emit('next')">下一步</button>
        <button v-else type="button" class="btn-primary" data-action="submit" :disabled="!props.canSubmit || isCreating" @click="emit('submit')">
          {{ props.submitting ? '建立中…' : '確認付款並建立' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.purchase-stepper-footer {
  background: var(--kawaii-surface);
}

.purchase-stepper-footer button.btn-primary {
  margin-left: auto;
}

@media (max-width: 639px) {
  .purchase-stepper-actions > button {
    min-height: 2.75rem;
    flex: 1;
    justify-content: center;
  }
}
</style>
