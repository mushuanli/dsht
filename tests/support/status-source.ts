/** Assemble the plain status source for tests, mirroring the composition root's builder. */
import { costText } from '../../src/ui/status/model.ts';
import type { CostTotal } from '../../src/contracts.ts';
import type { Controller } from '../../src/controller/controller.ts';
import type { StatusSource } from '../../src/ui/chat/status.tsx';
import { string } from '../../src/json.ts';

/** Build a `StatusSource` from a controller, exactly as `ui/app.tsx` does. */
export function statusSource(controller: Controller): StatusSource {
  const state = controller.state;
  const view = controller.queries.telemetry.view(state.sessionId);
  const ledger = controller.costs;
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const line = (total: CostTotal) => ({ text: costText(total), amount: total.amount, unknown: total.unknown });
  const session = ledger !== undefined && ledger.hasSession(state.sessionId!) ? ledger.total(state.sessionId!) : undefined;
  const activity = controller.queries.activity;
  return {
    host: controller.base, online: state.online, status: state.status,
    running: controller.queries.running,
    ...(activity === undefined ? {} : { activity }),
    sessionId: state.sessionId, sessionMode: controller.queries.sessionMode,
    workspaceLabel: workspace ? `${string(workspace.title)} · ${string(workspace.path)}` : 'none selected',
    activeTurnStartedAt: state.session.record.activeTurnStartedAt,
    pendingCount: state.pending.length,
    ...(state.session.record.livePhase === undefined ? {} : { livePhase: state.session.record.livePhase }),
    values: view.values, queued: view.queued, jobs: view.jobs,
    ...(state.defaultModel === undefined ? {} : { defaultModel: state.defaultModel }),
    ...(ledger === undefined ? {} : { cost: {
      sessionText: session === undefined ? '?' : costText(session),
      today: () => line(ledger.today()),
      session: () => session === undefined ? undefined : line(session),
      coverage: ledger.coverage,
      ...(ledger.error === undefined ? {} : { error: ledger.error }),
    } }),
    ...(state.controlError === undefined ? {} : { controlError: state.controlError }),
    ...(state.presetError === undefined ? {} : { presetError: state.presetError }),
    ...(state.modelError === undefined ? {} : { modelError: state.modelError }),
  };
}
