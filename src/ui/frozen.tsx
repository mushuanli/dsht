/** Retain rendered subtrees while the display is paused for reading or selection. */
import { memo, type ReactNode } from 'react';

/** Retain rendered children while frozen; local dialog interactions remain outside this wrapper. */
export const Frozen = memo(function Frozen({ children }: { children: ReactNode; frozen: boolean; identity: string }) {
  return <>{children}</>;
}, (previous, next) => previous.frozen && next.frozen && previous.identity === next.identity);
