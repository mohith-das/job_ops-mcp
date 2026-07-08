// MCP tool for checking jobops updates.
//
// update_jobops — checks npm registry for the latest version and reports the update command.

import { defineTool, okResult, errResult } from '../define.js';
import { checkForUpdate } from '../../core/updater.js';

export const updateJobopsTool = defineTool({
  name: 'update_jobops',
  title: 'Check for jobops updates',
  description:
    'Check the npm registry for the latest version of @mohith_das/jobops. ' +
    'Compares with the current running version and reports the exact update command ' +
    'if a mismatch is found. Does NOT auto-update (a running server can\'t safely replace ' +
    'its own files). Returns the update command for the user to run manually.',
  mutates: false,
  inputSchema: {},
  handler: async () => {
    try {
      const result = await checkForUpdate();

      if (result.updateAvailable) {
        return okResult({
          up_to_date: false,
          current: result.current,
          latest: result.latest,
          update_command: result.updateCommand,
          release_notes: result.releaseNotes,
          checked_at: result.checkedAt,
          note: `Update available: v${result.current} → v${result.latest}. Run the update_command to upgrade.`,
        });
      } else {
        return okResult({
          up_to_date: true,
          current: result.current,
          latest: result.latest,
          checked_at: result.checkedAt,
          note: `jobops is up to date (v${result.current}).`,
        });
      }
    } catch (e: any) {
      return errResult(`Failed to check for updates: ${e?.message ?? e}`);
    }
  },
});
