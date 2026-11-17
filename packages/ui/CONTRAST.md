# 对比度实测记录（架构 §11.5 / SPEC §10）

SPEC §2.4 给的 `--muted` 原值在两套主题下都**不满足 WCAG 2.x AA 正文 4.5:1**，已按架构 §11.5「不达标则提亮」处理。
本文件的每个数字都由 `src/contrast.ts` 的公式算出，并被 `test/contrast.test.ts` 断言锁定。

## 复现方式

```bash
# 在仓库根目录
pnpm vitest run packages/ui/test/contrast.test.ts
```

39 个用例：公式自检 3 + 原值不达标 2 + 提亮后实测 4 + 「2 主题 × 3 前景 × 5 容器」矩阵 30。
任一 token 被改回不达标值，矩阵用例立即失败并打印实际比值。
另有步进器阶段色底用例 17 个（见下文第二处发现），本文件合计 56 个用例。

公式：`L = 0.2126·R + 0.7152·G + 0.0722·B`，其中通道 `c ≤ 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`；
比值 `(L_hi + 0.05) / (L_lo + 0.05)`。自检锚点：`#000` vs `#fff` = 21:1、`#767676` on `#fff` = 4.5422:1。

## 结论：两个主题的 `--muted`

| 主题 | 原值（SPEC §2.4） | 原值 on `--surface` | 提亮/压暗后 | 现值 on `--surface` | 最不利容器 | 最不利容器比值 |
| --- | --- | --- | --- | --- | --- | --- |
| 深色 | `#6b7690` | **3.7857:1 ❌** | **`#8a93a8`** | **5.5890:1 ✅** | `--overlay #232c40` | **4.5290:1 ✅** |
| 浅色 | `#8b93a7` | **3.0750:1 ❌** | **`#646d84`** | **5.1692:1 ✅** | `--bg #eef1f6` | **4.5657:1 ✅** |

**为什么不止提亮到刚好 4.5**：`--muted` 会被用在侧边栏、卡片、表头、浮层等多种容器上。
若只按 `--surface` 求解（深色得 `#78839b`，on surface 4.5226:1），同一个色值落到 `--surface-2 #1c2333` 只有 4.1257:1、
落到 `--overlay #232c40` 只有 3.6649:1，后续任务很容易在不知情的情况下踩中。
因此约束取「该主题下最不利的容器」：深色 `--overlay`、浅色 `--bg`。这样 `--muted` 在**任意容器**上都达标，不需要额外的使用限制。

求解方式：保持色相与饱和度不变，只沿 HSL 明度轴移动（深色 +0.002/步，浅色 −0.002/步），
每步按量化后的 8bit hex 重算比值，取第一个达标值。深色 54 步、浅色 72 步。见 `meetContrast()`。

## 全矩阵实测（现值，单位 :1）

### 深色

| 前景 | `--bg` #0d1017 | `--bg-2` #11151f | `--surface` #161b27 | `--surface-2` #1c2333 | `--overlay` #232c40 |
| --- | --- | --- | --- | --- | --- |
| `--muted` #8a93a8 | 6.1794 | 5.9255 | 5.5890 | 5.0984 | 4.5290 |
| `--text-2` #aab3c8 | 9.0533 | 8.6814 | 8.1883 | 7.4696 | 6.6353 |
| `--text` #eef1f8 | 16.8294 | 16.1380 | 15.2215 | 13.8854 | 12.3346 |

### 浅色

| 前景 | `--bg` #eef1f6 | `--bg-2` #f6f8fc | `--surface` #ffffff | `--surface-2` #f4f6fb | `--overlay` #ffffff |
| --- | --- | --- | --- | --- | --- |
| `--muted` #646d84 | 4.5657 | 4.8618 | 5.1692 | 4.7808 | 5.1692 |
| `--text-2` #475069 | 7.0812 | 7.5404 | 8.0172 | 7.4147 | 8.0172 |
| `--text` #141a26 | 15.3865 | 16.3844 | 17.4203 | 16.1112 | 17.4203 |

## 第二处实测发现：步进器序号（本轮自查并修复）

四段步进器的圆形序号最初用「阶段色写在同色 dim 底上」，浏览器截图里浅色主题几乎看不见。实测：

| 阶段 | 深色：阶段色 on dim | 浅色：阶段色 on dim | 改后深色：`--text` on dim | 改后浅色：`--text` on dim |
| --- | --- | --- | --- | --- |
| 搜 teal | 5.0901 ✅ | **1.6024 ❌** | 8.3801 ✅ | 14.9957 ✅ |
| 想 amber | 5.7491 ✅ | **1.7757 ❌** | 10.3769 ✅ | 15.1576 ✅ |
| 做 violet | **4.3529 ❌** | **2.1689 ❌** | 10.4770 ✅ | 13.8834 ✅ |
| 发 coral | 5.0774 ✅ | **2.1960 ❌** | 12.0861 ✅ | 14.2135 ✅ |

修复：序号前景改为 `var(--text)`，阶段色只保留在圆环描边与 dim 底色上（`src/components.css`）。
完成态是「阶段色实底 + 深墨色 `#0d1017` 序号」，实测 10.2222 / 9.3240 / 6.9922 / 7.0701:1，均达标。
这两组也已进入单测，改回去会失败。

## 第三处实测发现：AntD 浮层底色不在矩阵里（协调者独立复核发现并修复）

复核用 headless Chrome 在 599px 打开侧边栏抽屉，沿 DOM 向上取第一个不透明背景，发现
`.ant-drawer-content` 的底色**不是**本文矩阵里的任何一个容器：

| 主题 | 修复前 Drawer 实测底色 | `--overlay` 应有值 | 修复前 `--muted` on Drawer |
| --- | --- | --- | --- |
| 深色 | `rgb(27,40,70)` = `#1b2846` | `#232c40` | 4.7406（矩阵外，此前从未实测） |
| 浅色 | `rgb(242,242,242)` = `#f2f2f2` | `#ffffff` | 4.6175（矩阵外，此前从未实测） |

成因：AntD 5 会从 `colorBgBase` 自行推导 `colorBgElevated`，Drawer / Popover / Dropdown / Select
都用它。原 token 表只钉了 `colorBgBase` 与 `colorBgContainer`，于是浮层落到推导值上。
两个推导值当时**恰好**都过 4.5，但「`--muted` 在任意容器上都达标」这句话在修复前是不成立的——
矩阵只覆盖了五个声明容器，AntD 会造出第六个。

修复：`antdTokenOf` 增加 `colorBgElevated: p.overlay`（`src/tokens.ts`），一处收口全部浮层。
修复后浏览器复测，抽屉内每一处 `--muted` 的比值都落回矩阵已有格：

| 主题 | Drawer 底色 | 抽屉内 `--muted` 实测（品牌副标 / 当前作品 / 阶段标签 / 本月额度 / 额度说明） |
| --- | --- | --- |
| 深色 | `rgb(35,44,64)` = `--overlay` ✅ | 4.5290 / 5.9255 / 5.0984 / 4.5290 / 4.5290 |
| 浅色 | `rgb(255,255,255)` = `--overlay` ✅ | 5.1692 / 4.8618 / 4.7808 / 5.1692 / 5.1692 |

回归锁：`test/theme-tokens.test.ts`「浮层底色钉到 --overlay」。

## 复核方式（协调者独立执行，不采信本文件的自述）

本文全部数字已被独立重算一遍：另写一份 WCAG 公式（不 import `src/contrast.ts`），
核对 30 格矩阵 + 20 个步进器数字 + 4 个阶段色 on surface + 2 个 SPEC 原值 + 3 个「只按 surface 求解」陷阱值
+ 2 个公式锚点，共 61 个数字，**全部一致**。
另用 headless Chrome（CDP 驱动，`Emulation.setDeviceMetricsOverride` 精确设宽）实测：
1440/960→`wide`、959/600→`medium`、599→`narrow`；`.page-grid` 列数 3/3/2/2/1；
≥960 侧边栏常驻、<960 抽屉化且可开出 6 个导航项；五档宽度均无横向滚动；
阶段色只出现在 `.sidebar` 容器（w1→violet、w2→amber、w3→coral），`:root` 恒为 teal；
步进器序号 24 个采样最小 6.9922:1；全程 0 个 JS 异常。

## 与 SPEC 的偏差声明

1. `--muted` 两套主题的色值**有意偏离 SPEC §2.4**，依据是架构 §11.5 的实测要求；SPEC 的语义（第三级弱化文本）不变。
2. 浅色主题的 `--bg-2 / --surface-2 / --overlay / --line` SPEC 未定义，按深色的层级次序（bg 最暗 → surface 最亮）推导，属 [推断]。
3. 阶段签名色（teal/amber/violet/coral）未改动，on `--surface` 分别为 9.2456 / 8.4332 / 6.3241 / 6.3946:1，均达 AA。
4. 本轮只实测了**文本前景 × 容器背景**。图标/边框等非文本对比度（AA 3:1）与 focus 描边未实测，留给 T-66 a11y 审计。

## 第四处实测记录：T-08 异常态基座（本轮追加，上文一字未改）

### 方法

- headless Chrome（`--headless=new` + CDP，`Emulation.setDeviceMetricsOverride` 1280×900）打开 `packages/ui/` 下的临时预览入口（5174 端口，**验证后已删除**）。
- 探针逐文本叶子取色：背景沿祖先链做 alpha 合成直到第一个不透明层；前景再按自身 alpha 与祖先 opacity 合成到该背景上；然后按本文公式算比值。
  **不合成 alpha 会读错**：第一版探针把 `rgba(0,0,0,0.45)` 当成 `#000000`，报出 18.5:1 的假绿；合成后才暴露浅色 `Result.subTitle` 的 3.2855:1。
- 第一轮探针在离线横幅渲染前采样（`phase=online` 时横幅返回 `null`），漏测了横幅；已补第二轮：6 场景 × 2 主题 = 12 组读数 + 12 张截图。
- 原始读数与截图：`packages/ui/artifacts/t08-state/`（`report.json` 第一轮、`offline-contrast.json` 第二轮、`*-banner-*.png` 补测截图）。

### T-08 组件实际踩到的「前景 × 容器」格（浏览器实测，单位 :1）

| 前景 | 容器 | 深色实测 | 浅色实测 | 使用位置 |
| --- | --- | --- | --- | --- |
| `--muted` | `--surface-2` | 5.0984 | 4.7808 | `.ks-partial__detail` |
| `--muted` | `--surface` | 5.5890 | 5.1692 | `.ks-state__notice` |
| `--muted` | `--bg` | 6.1794 | 4.5657 | `.ks-loading__hint`（页面底） |
| `--text-2` | `--overlay` | 6.6353 | 8.0172¹ | `.ks-partial__badge` |
| `--text-2` | `--surface-2` | 7.4696 | 7.4147 | `.ks-state__desc`（section 外壳） |
| `--text-2` | `--surface` | 8.1883 | 8.0172 | `.ks-state__icon`、默认按钮描边内文本 |
| `--text` | `--overlay` | 12.3346 | 17.4203¹ | `.ks-partial__badge`（失败态） |
| `--text` | `--surface-2` | 13.8854 | 16.1112 | `.ks-offline__text`、banner 级外壳标题 |
| `--text` | `--surface` | 15.2215 | 17.4203 | `.ks-state__title`、`.ks-partial__label`、AntD 默认按钮文本 |
| `--text` | `--bg` | 16.8294 | 15.3865 | `.ks-sr-only` 播报文本 |

¹ 浅色 `--overlay` 与 `--surface` 同为 `#ffffff`，故两格同值；深色 `--overlay #232c40` 单独成格。
全部 ≥ 4.5:1。深色最不利格 5.0984、浅色最不利格 4.5657，与本文「全矩阵实测」一节的矩阵完全吻合——**T-08 没有踩到矩阵外的格子**。

### 离线横幅六场景（第二轮补测）

| 场景 | phase / tone / role | 深色文本 | 浅色文本 | 深色按钮 | 浅色按钮 |
| --- | --- | --- | --- | --- | --- |
| 断网且已暂存 | offline / warning / status | 13.8854 | 16.1112 | — | — |
| 断网且暂存失败 | offline / danger / alert | 13.8854 | 16.1112 | 15.2215 | 17.4203 |
| 恢复但同步失败 | sync-failed / danger / alert | 13.8854 | 16.1112 | 15.2215 | 17.4203 |
| 恢复且已同步 | synced / success / status | 13.8854 | 16.1112 | 15.2215 | 17.4203 |
| 已同步但副本没清掉 | synced / success / status | 13.8854 | 16.1112 | 15.2215 | 17.4203 |
| 断网且未接暂存端口 | offline / warning / status | 13.8854 | 16.1112 | — | — |

横幅底 = `--surface-2`；横幅里的 AntD **默认**按钮底 = `--surface`（`colorBgContainer`），两者都在五容器矩阵里。
补测同时录到端口调用序列：`save → load → sync(失败) → load → sync(成功) → clear → save(失败) → load(null) → sync → save → load → sync → clear(失败) → sync(无端口)`，
与 `test/state-offline.test.ts` 的断言一致：同步失败绝不清副本，清理失败不算同步失败。

### 容器纪律（浏览器 + 单测双锁）

- `src/state/state.css` 零 hex / rgb / hsl 字面量；所有 `background` 只取 `--bg / --bg-2 / --surface / --surface-2 / --overlay`（装饰圆点除外，圆点不承载文本）。
- 浏览器侧确认：T-08 组件文本之下的不透明底色只出现深色 `{#0d1017, #161b27, #1c2333, #232c40}`、浅色 `{#eef1f6, #ffffff, #f4f6fb}`，**没有第六个表面**。
- tone 只染 `border-left` 与圆点；正文永远 `--text / --text-2 / --muted`，语义色不写正文。
- 骨架条不承载文本，不参与 4.5:1 判定；浅色下 `--surface-2` 与 `--surface` 差值小，用 `--line` 内描边保形状可辨（非文本 3:1 与 focus 描边仍留给 T-66）。

### 矩阵外实测到的三个底色（均非 T-08 新造的表面）

| 底色（深 / 浅） | 来源 | 前景 | 深色比值 | 浅色比值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `#29b7a5` / `#2dd4bf` | AntD primary Button（`GateLocked` 的「回到上一门」） | `#ffffff` | **2.4967 不达标** | **1.8615 不达标** | 白字落 teal，两主题都不达标 |
| `#7a7c7f` / `#838587` | AntD `colorTextDescription`（`Result.subTitle`，alpha 0.45 合成后） | 同色 | 4.5262 达标 | **3.2855 不达标** | 浅色不达标 |
| `#171a20` / `#e9ecf1` | 既有 `GateLocked` 提示条的半透明层（T-07 `components.css`） | `--text-2` | 8.3210 达标 | 6.7814 达标 | 合成值在矩阵外但达标，属 T-07 既有表面 |

### 两处不达标的归属与修法建议（T-08 不改共享 token）

两处都落在**既有 `GateLocked`（T-07）**经 AntD 默认值渲染的部分；`ErrorState` 只在 page 级闸门错误复用它，其余 14 个码走 T-08 自建外壳。
T-08 自己的所有按钮一律用 AntD **默认**类型，主行动只加字重与描边（`state.css` 的 `.ks-state__btn[data-primary='true']`），因此不踩白字 teal。
不在本轮顺手改共享 token 的原因：`tokens.ts` / `GateLocked.tsx` 是 T-07 已交付面，且并行 agent 正在改 `apps/web/**`，改全局 token 会同时动到两边的截图基线。

建议（各一行，归 T-07 / T-66 落地，数字已实算）：

1. `token.colorTextLightSolid = PALETTE[mode].bg`：primary 按钮文字改深墨 `#0d1017`，on `#2dd4bf` = **10.2222**、on hover `#29b7a5` = **7.6214**，两主题均达标。
2. `token.colorTextDescription = PALETTE[mode].muted`：`Result.subTitle` 改走已提亮的 `--muted`，on `--bg` = 6.1794 / 4.5657、on `--surface` = 5.5890 / 5.1692，任意容器达标。

### 回归锁

- `test/state-styles.test.ts`（25 例）：token 纪律 6 例 + 「9 组合 × 2 主题」18 例对比度 + 骨架底色 1 例。
- `test/state-components.test.ts`（38 例）：SSR markup 锁 role / aria-live / 文案 / 恢复动作。
- 任何一处改回不达标值、或造出第六个表面，上述用例立即失败并打印实际比值。