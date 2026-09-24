import { StateStore } from "../state.js";

export interface CancelOptions {
  paneId?: string;
  contextPaneId?: string;
}

export interface CancelResult {
  invoked: boolean;
  reason: string;
  paneId?: string;
}

export async function cancelResume(stateDir: string, opts: CancelOptions): Promise<CancelResult> {
  const paneId = opts.paneId ?? opts.contextPaneId;
  if (!paneId) return { invoked: false, reason: "no pane id provided" };
  const store = new StateStore(stateDir);
  const state = await store.load();
  const entry = state.entries[paneId];
  if (!entry) return { invoked: false, reason: `no pending auto-resume for ${paneId}`, paneId };
  await store.writeIntent({ kind: "cancel", paneId, atMs: Date.now() });
  return { invoked: true, reason: "intent_cancelled", paneId };
}
