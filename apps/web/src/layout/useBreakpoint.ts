import { useEffect, useState } from 'react';

/** SPEC §2.1 / 架构 §11.5 的两个断点：960 侧边栏抽屉化，600 单列。 */
export type Breakpoint = 'wide' | 'medium' | 'narrow';

const WIDE = '(min-width: 960px)';
const MEDIUM = '(min-width: 600px)';

const read = (): Breakpoint => {
  if (globalThis.matchMedia(WIDE).matches) return 'wide';
  return globalThis.matchMedia(MEDIUM).matches ? 'medium' : 'narrow';
};

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(read);

  useEffect(() => {
    const wide = globalThis.matchMedia(WIDE);
    const medium = globalThis.matchMedia(MEDIUM);
    const update = () => setBp(read());
    update();
    wide.addEventListener('change', update);
    medium.addEventListener('change', update);
    return () => {
      wide.removeEventListener('change', update);
      medium.removeEventListener('change', update);
    };
  }, []);

  return bp;
}