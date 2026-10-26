// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZcodeCliSetupSection } from './ZcodeCliSetupSection'

const mocks = vi.hoisted(() => ({
  settings: { agentCmdOverrides: { zcode: '' } },
  capability: vi.fn(),
  setupInvocation: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks)
}))
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    description,
    prepareCommandForShell
  }: {
    command: string
    description: string
    prepareCommandForShell?: (command: string, shell?: string) => string
  }) => (
    <div data-testid="setup-terminal">
      <output>{prepareCommandForShell?.(command, undefined) ?? command}</output>
      <p>{description}</p>
    </div>
  )
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

beforeEach(() => {
  mocks.settings.agentCmdOverrides.zcode = ''
  mocks.capability.mockReset().mockResolvedValue('interactive')
  mocks.setupInvocation.mockReset().mockImplementation(async ({ cliArgs }: { cliArgs: string[] }) => ({
    command: 'zcode',
    args: cliArgs,
    env: {}
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: {
        zcodeInteractiveCapability: mocks.capability,
        zcodeSetupInvocation: mocks.setupInvocation
      }
    }
  })
})
afterEach(() => cleanup())

describe('ZCode CLI-owned sign-in setup', () => {
  it('starts no terminal until the user opens a supported flow', () => {
    render(<ZcodeCliSetupSection />)
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(screen.getByText(/ZCode’s masked API-key setup/)).toBeInTheDocument()
    expect(screen.getByText(/use \/model to choose a GLM model/)).toBeInTheDocument()
  })

  it.each([
    ['Z.AI browser sign-in', "'zcode' 'login' 'zai' '--no-browser'"],
    ['BigModel browser sign-in', "'zcode' 'login' 'bigmodel' '--no-browser'"],
    ['ZCode API-key setup', "'zcode' 'tui'"]
  ])('delegates %s to the supported upstream CLI command', async (label, command) => {
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(command)
    expect(screen.getByRole('button', { name: 'Z.AI browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'BigModel browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'ZCode API-key setup' })).toBeDisabled()
    if (label === 'ZCode API-key setup') {
      expect(screen.getByText(/enter \/login.*masked prompt/)).toBeInTheDocument()
    } else {
      expect(screen.getByText(/authorization URL printed by ZCode/)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close setup terminal' }))
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeEnabled()
  })

  it('runs browser sign-in through the resolved desktop bundle invocation', async () => {
    mocks.setupInvocation.mockResolvedValue({
      command: '/opt/ZCode/zcode',
      args: ['/opt/ZCode/resources/glm/zcode.cjs', 'login', 'bigmodel', '--no-browser'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'BigModel browser sign-in' }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(
      "ELECTRON_RUN_AS_NODE='1' '/opt/ZCode/zcode' '/opt/ZCode/resources/glm/zcode.cjs' 'login' 'bigmodel' '--no-browser'"
    )
    expect(mocks.setupInvocation).toHaveBeenCalledWith({
      cliArgs: ['login', 'bigmodel', '--no-browser']
    })
  })

  it('passes a configured multi-token CLI command to main for safe resolution', async () => {
    mocks.settings.agentCmdOverrides.zcode = 'node "C:\\ZCode CLI\\zcode.cjs"'
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'BigModel browser sign-in' }))
    await screen.findByTestId('setup-terminal')
    expect(mocks.setupInvocation).toHaveBeenCalledWith({
      commandOverride: 'node "C:\\ZCode CLI\\zcode.cjs"',
      cliArgs: ['login', 'bigmodel', '--no-browser']
    })
  })

  it('refuses API-key setup when the installed bundle has no TUI', async () => {
    mocks.capability.mockResolvedValue('missing-tui')
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'ZCode API-key setup' }))
    await vi.waitFor(() => expect(mocks.capability).toHaveBeenCalled())
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(mocks.setupInvocation).not.toHaveBeenCalled()
  })
})
