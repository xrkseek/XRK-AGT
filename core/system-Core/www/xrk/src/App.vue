<script setup>
import { computed } from 'vue';
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  darkTheme,
  zhCN,
  dateZhCN,
} from 'naive-ui';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/layouts/AppShell.vue';

const auth = useAuthStore();

const denseCommon = {
  borderRadius: '4px',
  fontFamily: 'var(--font)',
  fontSize: '12.5px',
  heightTiny: '22px',
  heightSmall: '26px',
  heightMedium: '30px',
};

const lightThemeOverrides = {
  common: {
    ...denseCommon,
    primaryColor: '#00c2a8',
    primaryColorHover: '#00a892',
    primaryColorPressed: '#008f7c',
    infoColor: '#1a9bb8',
    successColor: '#2f9e6b',
    warningColor: '#c9a227',
    errorColor: '#c44b4b',
    textColorBase: '#0e1419',
    bodyColor: '#e8eef2',
    cardColor: '#f4f7f9',
    borderColor: '#9aabba',
  },
  Button: {
    heightTiny: '22px',
    heightSmall: '26px',
    heightMedium: '30px',
    paddingTiny: '0 8px',
    paddingSmall: '0 10px',
    fontSizeTiny: '11px',
    fontSizeSmall: '12px',
  },
  Input: {
    heightSmall: '26px',
    heightMedium: '30px',
    fontSizeSmall: '12px',
    paddingSmall: '0 8px',
  },
  Tag: {
    heightSmall: '20px',
    heightMedium: '22px',
    fontSizeSmall: '11px',
    padding: '0 6px',
    borderRadius: '3px',
  },
  Select: {
    peers: {
      InternalSelection: {
        heightSmall: '26px',
        heightMedium: '30px',
      },
    },
  },
};

const darkThemeOverrides = {
  common: {
    ...denseCommon,
    primaryColor: '#2dd4bf',
    primaryColorHover: '#5eead4',
    primaryColorPressed: '#14b8a6',
    infoColor: '#38bdf8',
    successColor: '#4ade80',
    warningColor: '#b89a3a',
    errorColor: '#f87171',
    textColorBase: '#d2dde6',
    textColor1: '#d2dde6',
    textColor2: '#a8b6c4',
    textColor3: '#8a9aab',
    bodyColor: '#0b1014',
    cardColor: '#121820',
    modalColor: '#121820',
    popoverColor: '#141b22',
    borderColor: '#3d4d5c',
    dividerColor: 'rgba(210, 221, 230, 0.14)',
    inputColor: '#121820',
    actionColor: '#141b22',
    hoverColor: 'rgba(45, 212, 191, 0.12)',
  },
  Button: {
    ...lightThemeOverrides.Button,
    textColorPrimary: '#041016',
    textColor: '#d2dde6',
    border: '1px solid #3d4d5c',
    borderHover: '1px solid #5a6b78',
  },
  Input: {
    ...lightThemeOverrides.Input,
    color: '#121820',
    colorFocus: '#141b22',
    textColor: '#d2dde6',
    placeholderColor: '#8a9aab',
    border: '1px solid #3d4d5c',
    borderHover: '1px solid #5a6b78',
    borderFocus: '1px solid #2dd4bf',
  },
  Tag: lightThemeOverrides.Tag,
  Select: lightThemeOverrides.Select,
  Code: {
    textColor: '#d2dde6',
  },
};

const theme = computed(() => (auth.dark ? darkTheme : null));
const overrides = computed(() => (auth.dark ? darkThemeOverrides : lightThemeOverrides));
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <AppShell />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
