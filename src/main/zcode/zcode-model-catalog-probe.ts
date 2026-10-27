// Listing a ZCode chat's models before one runs: a scratch session on the same launch a chat
// would get, reading the model table its snapshot reports, then closing without a trace
// (`persistence: 'deferred'`).

import { homedir } from 'node:os'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type {
  AgentModelCatalogDiscovery,
  AgentModelCatalogProbe
} from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registrations'
import { createZcodeAgentConnection } from './zcode-protocol-connection'
import { resolveZcodeLaunchInvocation } from './zcode-structured-launch-resolution'
import { syncZcodeAccountConfig } from './zcode-account-config-sync'
import {
  configuredModelIdOf,
  zcodeCatalogSnapshotSchema,
  zcodeModelOptionsOf
} from './zcode-session-snapshot-facts'

export function zcodeModelCatalogDiscovery(
  context: StructuredAgentModelCatalogContext
): AgentModelCatalogDiscovery {
  const { deps, environment } = context
  const probe: AgentModelCatalogProbe = async (accountHome, options) => {
    const home = requireLegacyAgentSessionAccountHome(accountHome).path
    const cwd = options?.cwd
    const invocation = await resolveZcodeLaunchInvocation(home, {
      resolveEnvironment: environment.resolveBaseEnvironment,
      ...(deps.resolveAgentLaunchEnv ? { resolveLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
      ...(deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
        : {}),
      refreshEnvironmentAfterMiss: environment.refreshAfterMissingProgram,
      ...(cwd ? { resolveWorkingDirectory: () => cwd } : {})
    })
    const workspace = cwd ?? homedir()
    const listing = await runAgentModelCatalogSession(
      () =>
        createZcodeAgentConnection({
          command: invocation.command,
          args: invocation.args,
          cwd: workspace,
          env: invocation.env,
          envToDelete: invocation.envToDelete
        }),
      async (connection) => {
        // The model listing must see the user's GLM Coding Plan providers, so the probe
        // pushes the same Account Config the session open does (degrades to the factory
        // default listing when it fails). The deferred session is closed unread below.
        await syncZcodeAccountConfig(connection, invocation.env).catch(() => undefined)
        const snapshot = zcodeCatalogSnapshotSchema.parse(
          await connection.request('session/create', {
            workspace: { workspacePath: workspace, workspaceKey: workspace },
            persistence: 'deferred',
            titleGenerationEnabled: false
          })
        )
        await connection
          .request('session/close', { sessionId: snapshot.session.sessionId })
          .catch(() => undefined)
        const models = zcodeModelOptionsOf(snapshot)
        const configuredModel = configuredModelIdOf(snapshot)
        return {
          models,
          origin: 'probe',
          complete: true,
          ...(configuredModel ? { configured: { model: configuredModel } } : {})
        } satisfies AgentModelCatalogSuccess
      },
      {
        label: 'zcode model listing',
        ...(options?.signal ? { signal: options.signal } : {})
      }
    )
    return listing
  }
  return { kind: 'probe', probe, listingNamesConfiguredModel: true }
}
