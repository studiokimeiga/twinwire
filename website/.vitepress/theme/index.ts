import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { h } from 'vue';
import './style.css';
import SiteFooter from './components/SiteFooter.vue';
import HomeHero from './components/HomeHero.vue';
import FeatureGrid from './components/FeatureGrid.vue';
import WiresDemo from './components/demos/WiresDemo.vue';
import SessionsDemo from './components/demos/SessionsDemo.vue';
import InterpolationDemo from './components/demos/InterpolationDemo.vue';
import PredictionDemo from './components/demos/PredictionDemo.vue';
import DeltaDemo from './components/demos/DeltaDemo.vue';
import InterestDemo from './components/demos/InterestDemo.vue';
import LobbyDemo from './components/demos/LobbyDemo.vue';

export default {
  extends: DefaultTheme,
  // VitePress shows its footer only on pages without a sidebar; the docs get the same one under their content
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-after': () => h(SiteFooter) }),
  enhanceApp({ app }) {
    for (const [name, c] of Object.entries({ HomeHero, FeatureGrid, WiresDemo, SessionsDemo, InterpolationDemo, PredictionDemo, DeltaDemo, InterestDemo, LobbyDemo }))
      app.component(name, c);
  },
} satisfies Theme;
