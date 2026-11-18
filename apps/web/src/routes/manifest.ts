import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { GateId } from '@knowstudio/contracts';

/**
 * SPEC §2.5 的 19 个页面 + 两个域入口重定向，顺序与 SPEC 表格一致。
 * gate 取自架构 §11.1；页面级只做「读服务端信封后决定是否渲染锁定态」，不做本地闸门判断。
 */
export interface PageRoute {
  kind: 'page';
  pageId: string;
  path: string;
  title: string;
  /** 顶栏面包屑的领域段。 */
  section: string;
  /** bare 用于登录/引导：不套工作台外壳（架构 §11.1 独立入口 chunk）。 */
  shell: 'app' | 'bare';
  gate?: GateId;
  component: LazyExoticComponent<ComponentType>;
}

export interface RedirectRoute {
  kind: 'redirect';
  path: string;
  title: string;
}

export const PAGE_ROUTES: readonly PageRoute[] = [
  {
    kind: 'page',
    pageId: 'page-home',
    path: '/',
    title: '工作台首页',
    section: '工作台',
    shell: 'app',
    component: lazy(() => import('../pages/HomePage')),
  },
  {
    kind: 'page',
    pageId: 'page-works',
    path: '/works',
    title: '作品列表',
    section: '作品',
    shell: 'app',
    component: lazy(() => import('../pages/WorksPage')),
  },
  {
    kind: 'page',
    pageId: 'page-work-detail',
    path: '/works/:id',
    title: '作品详情',
    section: '作品',
    shell: 'app',
    component: lazy(() => import('../pages/WorkDetailPage')),
  },
  {
    kind: 'page',
    pageId: 'page-discover',
    path: '/discover',
    title: '素材搜索',
    section: '选题',
    shell: 'app',
    component: lazy(() => import('../pages/DiscoverPage')),
  },
  {
    kind: 'page',
    pageId: 'page-trends',
    path: '/discover/trends',
    title: '热点雷达',
    section: '选题',
    shell: 'app',
    component: lazy(() => import('../pages/TrendsPage')),
  },
  {
    kind: 'page',
    pageId: 'page-topics',
    path: '/discover/topics',
    title: '选题脑暴',
    section: '选题',
    shell: 'app',
    component: lazy(() => import('../pages/TopicsPage')),
  },
  {
    kind: 'page',
    pageId: 'page-script',
    path: '/studio/:id/script',
    title: '文案编辑器',
    section: '创作',
    shell: 'app',
    component: lazy(() => import('../pages/ScriptPage')),
  },
  {
    kind: 'page',
    pageId: 'page-video',
    path: '/studio/:id/video',
    title: '视频生成预览',
    section: '创作',
    shell: 'app',
    gate: 'G2',
    component: lazy(() => import('../pages/VideoPage')),
  },
  {
    kind: 'page',
    pageId: 'page-render',
    path: '/studio/:id/render',
    title: '渲染任务中心',
    section: '创作',
    shell: 'app',
    gate: 'G2',
    component: lazy(() => import('../pages/RenderPage')),
  },
  {
    kind: 'page',
    pageId: 'page-publish',
    path: '/publish/:id',
    title: '多平台派生',
    section: '发布',
    shell: 'app',
    // A1 派生二分：metadata 只需 G2，media 动作再由服务端校验 G3（架构 §5.4）。
    gate: 'G2',
    component: lazy(() => import('../pages/PublishPage')),
  },
  {
    kind: 'page',
    pageId: 'page-export',
    path: '/publish/:id/export',
    title: '导出与合规',
    section: '发布',
    shell: 'app',
    gate: 'G4',
    component: lazy(() => import('../pages/ExportPage')),
  },
  {
    kind: 'page',
    pageId: 'page-library',
    path: '/library',
    title: '素材库',
    section: '素材库',
    shell: 'app',
    component: lazy(() => import('../pages/LibraryPage')),
  },
  {
    kind: 'page',
    pageId: 'page-library-detail',
    path: '/library/:id',
    title: '素材详情',
    section: '素材库',
    shell: 'app',
    component: lazy(() => import('../pages/LibraryDetailPage')),
  },
  {
    kind: 'page',
    pageId: 'page-settings',
    path: '/settings',
    title: '设置',
    section: '设置',
    shell: 'app',
    component: lazy(() => import('../pages/SettingsPage')),
  },
  {
    kind: 'page',
    pageId: 'page-settings-style',
    path: '/settings/style',
    title: '风格样本',
    section: '设置',
    shell: 'app',
    component: lazy(() => import('../pages/SettingsStylePage')),
  },
  {
    kind: 'page',
    pageId: 'page-settings-quota',
    path: '/settings/quota',
    title: '配额与成本',
    section: '设置',
    shell: 'app',
    component: lazy(() => import('../pages/SettingsQuotaPage')),
  },
  {
    kind: 'page',
    pageId: 'page-settings-sources',
    path: '/settings/sources',
    title: '素材源配置',
    section: '设置',
    shell: 'app',
    component: lazy(() => import('../pages/SettingsSourcesPage')),
  },
  {
    kind: 'page',
    pageId: 'page-login',
    path: '/login',
    title: '登录',
    section: '账户',
    shell: 'bare',
    component: lazy(() => import('../pages/login/LoginPage')),
  },
  {
    kind: 'page',
    pageId: 'page-welcome',
    path: '/welcome',
    title: '首次引导',
    section: '账户',
    shell: 'bare',
    component: lazy(() => import('../pages/WelcomePage')),
  },
];

/** 无 [id] 的域入口：重定向到最近活跃 Work 的 step 续作路径（SPEC §2.5 脚注）。 */
export const REDIRECT_ROUTES: readonly RedirectRoute[] = [
  { kind: 'redirect', path: '/studio', title: '创作域入口' },
  { kind: 'redirect', path: '/publish', title: '发布域入口' },
];

export const ROUTES: readonly (PageRoute | RedirectRoute)[] = [...PAGE_ROUTES, ...REDIRECT_ROUTES];

/** 侧边栏主导航 6 项（SPEC §2.5，≤7 上限）。 */
export const NAV_ITEMS = [
  { to: '/', label: '工作台' },
  { to: '/discover', label: '选题' },
  { to: '/studio', label: '创作' },
  { to: '/publish', label: '发布' },
  { to: '/library', label: '素材库' },
  { to: '/settings', label: '设置' },
] as const;
