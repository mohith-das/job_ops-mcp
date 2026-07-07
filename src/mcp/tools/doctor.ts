// doctor — read-only server health check exposed to chat. Runs the SAME checks as the CLI
// `doctor` subcommand (shared core/doctor.ts), tuned for the running-server context, and
// returns a structured report. No mutations.

import { defineTool, okResult } from '../define.js';
import { runDoctorChecks } from '../../core/doctor.js';

export const doctorTool = defineTool({
  name: 'doctor',
  title: 'Server health check (read-only)',
  description:
    'Read-only diagnostics for the running jobops server. Returns a structured report: '
    + 'server identity (pid, uptime, transport, DB path + fingerprint, MCP clients seen — '
    + 'verifies all your clients share this one instance + DB), career_packet ↔ cv.md sync '
    + 'state (incl. chat-edited / cv-edited-after-reseed), LLM provider + key, MCP sampling '
    + 'posture, auth posture, active resume template, modes (bundled vs project-root '
    + 'overrides), visa scoring, public base URL, Chromium, Node, and config files. Mutates '
    + 'nothing — safe to call anytime to see how the server is wired.',
  inputSchema: {},
  handler: async (_args, ctx) => {
    // Report the LIVE sampling state negotiated with THIS connected client, not a guess.
    const b = ctx?.bridge;
    const sampling = b
      ? { clientConnected: b.clientConnected(), advertised: b.clientAdvertisedSampling(), usable: b.canSample() }
      : undefined;
    const report = await runDoctorChecks({ context: 'server', sampling });
    return okResult(report);
  },
mutates: false,
  });
