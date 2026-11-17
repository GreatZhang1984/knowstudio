import { Skeleton } from 'antd';

/** 懒加载 chunk 到达前的占位。统一异常态基座属 T-08，这里只保证不白屏。 */
export function PageFallback() {
  return (
    <div aria-busy="true" aria-live="polite">
      <Skeleton active paragraph={{ rows: 6 }} />
    </div>
  );
}