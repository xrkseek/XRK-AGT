<script setup lang="ts">
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
  borderRadius: '8px',
  fontFamily: 'var(--font)',
  fontSize: '12.5px',
  heightTiny: '22px',
  heightSmall: '26px',
  heightMedium: '30px',
};

const lightThemeOverrides = {
  common: {
    ...denseCommon,
    primaryColor: '#ff6b9d',
    primaryColorHover: '#ff4f8a',
    primaryColorPressed: '#e8457c',
    infoColor: '#3ecfff',
    successColor: '#5ad67d',
    warningColor: '#ffd24a',
    errorColor: '#ff5a5a',
    textColorBase: '#1a1510',
    bodyColor: '#fff8e7',
    cardColor: '#fffdf6',
    borderColor: '#1a1510',
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
    primaryColor: '#d96b92',
    primaryColorHover: '#e883a6',
    primaryColorPressed: '#c45a80',
    infoColor: '#3aabd0',
    successColor: '#52b86c',
    warningColor: '#c9a035',
    errorColor: '#d95a5a',
    textColorBase: '#c4b8a8',
    textColor1: '#c4b8a8',
    textColor2: '#a89c8e',
    textColor3: '#8a8074',
    bodyColor: '#12100e',
    cardColor: '#1a1612',
    modalColor: '#1a1612',
    popoverColor: '#221c17',
    borderColor: '#4f473f',
    dividerColor: 'rgba(196, 184, 168, 0.16)',
    inputColor: '#1a1612',
    actionColor: '#221c17',
    hoverColor: 'rgba(217, 107, 146, 0.14)',
  },
  Button: {
    ...lightThemeOverrides.Button,
    textColorPrimary: '#1a1510',
    textColor: '#c4b8a8',
    border: '1.5px solid #4f473f',
    borderHover: '1.5px solid #6a6158',
  },
  Input: {
    ...lightThemeOverrides.Input,
    color: '#1a1612',
    colorFocus: '#221c17',
    textColor: '#c4b8a8',
    placeholderColor: '#8a8074',
    border: '1.5px solid #4f473f',
    borderHover: '1.5px solid #6a6158',
    borderFocus: '1.5px solid #d96b92',
  },
  Tag: lightThemeOverrides.Tag,
  Select: lightThemeOverrides.Select,
  Code: {
    textColor: '#c4b8a8',
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
