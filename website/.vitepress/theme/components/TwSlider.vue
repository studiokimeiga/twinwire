<script setup lang="ts">
const props = defineProps<{ label: string; modelValue: number; min: number; max: number; step?: number; unit?: string; percent?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const id = 'tw-' + Math.random().toString(36).slice(2, 9);
const shown = () => props.percent ? `${Math.round(props.modelValue * 100)}%` : `${props.modelValue}${props.unit ?? ''}`;
</script>

<template>
  <label class="tw-control" :for="id">
    <span class="row"><span>{{ label }}</span><span class="value">{{ shown() }}</span></span>
    <input :id="id" type="range" :min="min" :max="max" :step="step ?? 1" :value="modelValue"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))" />
  </label>
</template>
