/** UI-owned dialog state and the keyboard traits shared by routing and rendering. */
import { useEffect, useState, type SetStateAction } from 'react';
import type { HistoryPanel, ModelState, PanelName, RemovalTarget, SearchPanel } from '../../contracts.ts';

type SurfaceName = PanelName | 'peek';

interface PanelState {
  thoughts: boolean;
  queue: boolean;
  prompts: boolean;
  help: boolean;
  cost: boolean;
  status: boolean;
  model?: ModelState;
  history?: HistoryPanel;
  search?: SearchPanel;
  removal?: RemovalTarget;
  loop?: { name: string };
}

interface Surface {
  name: SurfaceName;
  open: boolean;
  arrows?: boolean;
  blocksKeys?: boolean;
  reserved?: readonly string[];
}

const EMPTY: PanelState = { thoughts: false, queue: false, prompts: false, help: false, cost: false, status: false };
const TRAITS: readonly (Omit<Surface, 'open' | 'name'> & { name: PanelName })[] = [
  { name: 'queue', reserved: ['d'] },
  { name: 'prompts', arrows: true, blocksKeys: true, reserved: ['d', 'e'] },
  ...(['removal', 'model', 'loop', 'thoughts', 'history', 'search'] as const).map(name => ({ name, arrows: true, blocksKeys: true })),
  ...(['help', 'cost', 'status'] as const).map(name => ({ name, blocksKeys: true })),
];

/** The externally owned peek view participates in routing without duplicating its state. */
export function usePanels(options: { sessionId: string | undefined; pendingId: string | undefined; peekOpen: boolean; closePeek(): void }) {
  const [state, setState] = useState<PanelState>(EMPTY);
  const setter = <K extends keyof PanelState>(key: K) => (value: SetStateAction<PanelState[K]>) => {
    setState(current => {
      const next = typeof value === 'function' ? value(current[key]) : value;
      return current[key] === next ? current : { ...current, [key]: next };
    });
  };
  useEffect(() => {
    // Read-only client panels and a chosen removal target survive navigation as before.
    setState(current => ({ ...EMPTY, help: current.help, cost: current.cost, status: current.status, removal: current.removal }));
  }, [options.sessionId]);
  useEffect(() => {
    setState(current => ({ ...current, queue: false, loop: options.pendingId === undefined ? current.loop : undefined }));
  }, [options.sessionId, options.pendingId]);

  const surfaces: readonly Surface[] = [
    { name: 'peek', open: options.peekOpen, arrows: true, blocksKeys: true },
    ...TRAITS.map(trait => ({ ...trait, open: trait.name === 'queue' ? state.queue && options.pendingId === undefined
      : !!state[trait.name] })),
  ];
  const openSurfaces = surfaces.filter(surface => surface.open);
  function close(name: SurfaceName) {
    if (name === 'peek') options.closePeek();
    else setState(current => ({ ...current, [name]: EMPTY[name] }));
  }
  function closeExcept(keep?: SurfaceName) {
    if (keep !== 'peek') options.closePeek();
    setState(current => keep === undefined || keep === 'peek' ? EMPTY : { ...EMPTY, [keep]: current[keep] });
  }
  return {
    state, openSurfaces, close, closeExcept,
    reservedKeys: [...new Set(openSurfaces.flatMap(surface => surface.reserved ?? []))],
    openThoughts: setter('thoughts'), openQueue: setter('queue'), openPrompts: setter('prompts'),
    setModelPanel: setter('model'), setHistoryPanel: setter('history'), setSearchPanel: setter('search'),
    setRemoval: setter('removal'), setLoopForm: setter('loop'),
    setHelp: setter('help'), setCostExpanded: setter('cost'), setStatusExpanded: setter('status'),
  };
}
