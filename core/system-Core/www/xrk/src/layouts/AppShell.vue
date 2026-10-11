<script setup lang="ts">
import { useViewport } from '@/composables/useViewport';
import DesktopShell from '@/layouts/DesktopShell.vue';
import MobileShell from '@/layouts/MobileShell.vue';

const { isMobile } = useViewport();
</script>

<template>
  <MobileShell v-if="isMobile" />
  <DesktopShell v-else />
</template>
