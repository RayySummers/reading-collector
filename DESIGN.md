# Reading Collector · 设计规范

参照 **Radix / shadcn 的中性体系**，只取最小集；所有值写成 CSS 变量，扩展里不许出现裸色值。

## Tokens

```css
:root {
  /* 背景与表面 */
  --rc-bg: #ffffff;
  --rc-surface: #f6f6f7;
  --rc-border: #e4e4e7;

  /* 文字 */
  --rc-text: #18181b;
  --rc-text-2: #52525b;
  --rc-text-3: #a1a1aa;

  /* 语义色（与三类标记一一对应） */
  --rc-vocab: #22c55e;   /* 生词 */
  --rc-idea:  #eab308;   /* 想法 */
  --rc-fact:  #3b82f6;   /* 事实 */

  /* 标记底纹（浅） */
  --rc-vocab-bg: #dcfce7;
  --rc-idea-bg:  #fef9c3;
  --rc-fact-bg:  #dbeafe;

  /* 深色（浮层/工具栏） */
  --rc-dark: #111113;
  --rc-dark-border: rgba(255, 255, 255, 0.14);
  --rc-dark-btn: rgba(255, 255, 255, 0.06);
  --rc-dark-btn-hover: rgba(255, 255, 255, 0.16);

  /* 间距：4 的倍数 */
  --rc-1: 4px;
  --rc-2: 8px;
  --rc-3: 12px;
  --rc-4: 16px;
  --rc-5: 20px;

  /* 圆角 */
  --rc-r-sm: 8px;
  --rc-r-md: 12px;
  --rc-r-full: 999px;

  /* 字号 */
  --rc-fs-sm: 12px;
  --rc-fs-md: 13px;
  --rc-fs-lg: 15px;

  /* 阴影 */
  --rc-shadow-bar: 0 8px 28px rgba(0, 0, 0, 0.35);
  --rc-shadow-pop: 0 12px 36px rgba(0, 0, 0, 0.28);
}
```

## 规则

1. **间距只用 4 的倍数**（4/8/12/16/20），不许出现 7px、11px 这种。
2. **圆角只有三档**：8（按钮）、12（浮层/工具栏）、999（胶囊）。
3. **文字只有三档**：12 / 13 / 15；不使用 14px。
4. **颜色只从变量取**，三类标记色就是三个语义色，别的地方不许再用绿/黄/蓝。
5. **深色只用于浮层与工具栏**，页面内文字浮层用白底（阅读时对比更稳）。
6. 字体栈统一：`-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`。
7. 动效 ≤ 150ms，`prefers-reduced-motion` 时关闭。
