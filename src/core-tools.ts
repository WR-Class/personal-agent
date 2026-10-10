import { createBatchFilesTool, createCreateFileTool, createDeleteFileTool, createEditFileTool, createInspectFileTool, createObsRecallTool, createPatchFileTool, createJobKillTool, createJobOutputTool, createReadFileTool, createRenameFileTool, createRunCommandTool, createUpdateTaskStateTool } from './tools.ts';
import { createReadRemoteTool, createRunRemoteTool } from './infra-remote.ts';
import type { Tool } from './tools.ts';
import type { SessionStore } from './session-store.ts';

/** One registration point shared by CLI and desktop; state-changing tools stay session-bound. */
export function createCoreTools(names: readonly string[], session?: { store: SessionStore; id: string }, agentHome?: { readonly home: string }): Tool[] {
  const homeProvider = () => {
    if (!agentHome) throw new Error('infra tools require an agent home directory');
    return agentHome.home;
  };
  const factories = {
    read_file: createReadFileTool, inspect_file: createInspectFileTool,
    run_command: createRunCommandTool, job_output: createJobOutputTool, job_kill: createJobKillTool,
    edit_file: createEditFileTool, patch_file: createPatchFileTool, create_file: createCreateFileTool,
    delete_file: createDeleteFileTool, rename_file: createRenameFileTool, batch_files: createBatchFilesTool,
    read_remote: () => createReadRemoteTool(homeProvider),
    run_remote: () => createRunRemoteTool(homeProvider),
    update_task_state: () => {
      if (!session) throw new Error('update_task_state requires a trusted session store and id');
      return createUpdateTaskStateTool(session.store, session.id);
    },
    // Session-bound for the same reason as `update_task_state`: its whole job is
    // reading one session's own log, so the store and id come from the runtime
    // and never from the model's arguments (D52).
    obs_recall: () => {
      if (!session) throw new Error('obs_recall requires a trusted session store and id');
      return createObsRecallTool(session.store, session.id);
    },
  };
  return names.map(name => {
    const factory = factories[name as keyof typeof factories];
    if (!factory) throw new Error(`Tool ${JSON.stringify(name)} has no core factory; available: ${Object.keys(factories).join(', ')}`);
    return factory();
  });
}
