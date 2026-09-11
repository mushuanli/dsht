/** Whether copy mode froze the display for native terminal selection. */
import { createContext, useContext } from 'react';

/** True while copy mode keeps pickers and the composer inactive. */
export const CopyMode = createContext(false);

/** @returns Whether the surrounding application is in copy mode. */
export function useCopyMode(): boolean { return useContext(CopyMode); }
