import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'
import { buildAgentStartupPlan, agentPromptRidesLaunchCommand } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { recognizeAgentProcess } from './agent-process-recognition'

describe('ZCode orchestration and send-to-agent contract', () => {
  it('is dispatchable: its foreground process resolves back to the zcode agent', () => {
    // Why this matters: ZCode sets `process.title = 'zcode-cli'`, so without this mapping
    // `dispatch --inject` refuses the pane with no_agent_detected.
    expect(TUI_AGENT_CONFIG.zcode.expectedProcess).toBe('zcode-cli')
    expect(recognizeAgentProcess('zcode-cli')?.agent).toBe('zcode')
  })

  it('refuses worker --model rather than swallowing it', () => {
    // Why: zcode's CLI takes no model launch flag — the catalog exists only for mid-session
    // `/model` and `/effort` command delivery, and declares no launch application, so an
    // orchestration `--model` still meets a clear refusal instead of a silently dropped flag.
    expect(getAgentSessionOptionCatalog('zcode')?.models).toEqual([])
    expect(
      checkAgentLaunchModelPreferences({ agent: 'zcode', model: 'zai/glm-5.3' })
    ).toMatchObject({
      refusal: {
        code: 'invalid_argument',
        message: expect.stringContaining('does not support launch-time model selection')
      }
    })
  })

  it("bypasses permissions with ZCode's own yolo mode, not a --yolo flag", () => {
    expect(YOLO_TUI_AGENT_ARGS.zcode).toBe('--mode yolo')
  })

  it('delivers prompts over stdin, never as argv', () => {
    // Why: ZCode reads positionals[0] as a SUBCOMMAND, so an argv prompt exits with
    // "Unknown command"; `-p` is headless-only and quits after one turn.
    expect(TUI_AGENT_CONFIG.zcode.promptInjectionMode).toBe('stdin-after-start')
    expect(agentPromptRidesLaunchCommand('zcode')).toBe(false)
  })

  it('keeps the prompt out of the launch command and hands it back as a follow-up', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'refactor the parser',
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(plan?.launchCommand).toBe('zcode')
    expect(plan?.launchCommand).not.toContain('refactor the parser')
    expect(plan?.followupPrompt).toBe('refactor the parser')
  })

  it('carries a mode chosen through agent args onto the launch command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--mode plan'
    })
    // Args are shell-quoted into the launch command, so assert the quoted form.
    expect(plan?.launchCommand).toBe("zcode '--mode' 'plan'")
  })

  it('waits for the composer instead of a quiet window before pasting a draft', () => {
    // Why: ZCode repaints its ASCII banner forever, so the default quiet-render window
    // never settles — see zcode-readiness-transcript.test.ts for the captured evidence.
    expect(TUI_AGENT_CONFIG.zcode.draftPasteReadySignal).toBe('zcode-composer-prompt')
  })
})
