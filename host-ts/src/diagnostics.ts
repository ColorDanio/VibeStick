import type { HostCore } from "./core.js";
import type { DashboardEnvironment } from "./dashboard.js";

export interface DiagnosticSystem { platform: string; arch: string; runtime: string; }

/**
 * Support artifact deliberately limited to operational metadata. Do not add
 * transcript content, session names, paths, commands, bindings, audio, or
 * credentials here: users must be able to attach it to a bug report safely.
 */
export function diagnosticsReport(core: HostCore, environment: DashboardEnvironment, system: DiagnosticSystem): Record<string, unknown> {
  const snapshot = core.snapshot();
  const states: Record<string, number> = {};
  const tools: Record<string, number> = {};
  for (const session of snapshot.sessions.list) {
    states[session.state] = (states[session.state] ?? 0) + 1;
    tools[session.tool] = (tools[session.tool] ?? 0) + 1;
  }
  return {
    schema: "vibestick-host-diagnostics/v1",
    generated_at: new Date().toISOString(),
    implementation: environment.implementation,
    system,
    ownership: { host_2: environment.owner, python_1: environment.traditional_owner.state },
    runtime: { state: environment.runtime, ...(environment.error ? { error: environment.error.slice(0, 240) } : {}) },
    capabilities: environment.capabilities,
    configuration: {
      asr_engine: environment.config.asr_engine,
      asr_model: environment.config.asr_model,
      online_asr_configured: environment.config.online_asr_configured,
      session_launcher: environment.config.session_launcher,
      tools: environment.config.tools.map((tool) => tool.id),
    },
    sessions: { total: snapshot.sessions.list.length, by_state: states, by_tool: tools, selected_tool: snapshot.selected_tool, active: Boolean(snapshot.active_session), queued: snapshot.queued },
    redacted: ["api_key", "config_path", "working_directory", "command", "binding", "session_name", "transcript", "tail", "audio"],
  };
}
