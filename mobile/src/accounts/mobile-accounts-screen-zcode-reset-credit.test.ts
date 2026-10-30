import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmModal } from '../components/ConfirmModal'
import { MobileAccountsScreen } from './MobileAccountsScreen'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  loadHosts: vi.fn(),
  resetRequest: vi.fn(),
  statusCapabilities: vi.fn()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    },
    useLocalSearchParams: () => ({ hostId: 'host-1' })
  }
})

vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: dependencies.back })
}))

vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User'
}))

vi.mock('../transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))

vi.mock('../transport/host-client-hooks', () => {
  const client = {
    sendRequest: async (method: string, params?: unknown, options?: unknown) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { capabilities: dependencies.statusCapabilities() },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'accounts.consumeZcodeResetCredit') {
        return dependencies.resetRequest(params, options)
      }
      if (method === 'accounts.list') {
        return { id: 'list', ok: true, result: AVAILABLE_SNAPSHOT }
      }
      throw new Error(`Unexpected request: ${method}`)
    },
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      onData({ type: 'ready', snapshot: AVAILABLE_SNAPSHOT })
      return vi.fn()
    }
  }
  return {
    useHostClient: () => ({ client, state: 'connected' })
  }
})

vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

const AVAILABLE_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    zcode: {
      provider: 'zcode',
      session: {
        usedPercent: 90,
        windowMinutes: 300,
        resetsAt: 2_000_000_000_000,
        resetDescription: null
      },
      weekly: null,
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: null,
        weekAvailableCount: 1,
        weekNextExpiresAt: null
      },
      updatedAt: 100,
      error: null,
      status: 'ok'
    },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
} as const

const RESET_SNAPSHOT = {
  ...AVAILABLE_SNAPSHOT,
  rateLimits: {
    ...AVAILABLE_SNAPSHOT.rateLimits,
    zcode: {
      ...AVAILABLE_SNAPSHOT.rateLimits.zcode,
      session: { ...AVAILABLE_SNAPSHOT.rateLimits.zcode.session, usedPercent: 0 },
      rateLimitResetCredits: {
        availableCount: 0,
        nextExpiresAt: null,
        weekAvailableCount: 0,
        weekNextExpiresAt: null
      }
    }
  }
} as const

async function renderAccountsRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(MobileAccountsScreen))
    await Promise.resolve()
  })
  return renderer!
}

function resetButtons(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.props.accessibilityLabel === 'Use GLM rate-limit reset'
  )
}

async function findResetButton(renderer: ReactTestRenderer) {
  await vi.waitFor(() => expect(resetButtons(renderer)).toHaveLength(1))
  return resetButtons(renderer)[0]!
}

function openDialog(renderer: ReactTestRenderer) {
  const open = renderer.root
    .findAllByType(ConfirmModal)
    .map((node) => node.props)
    .filter((props) => props.visible)
  if (open.length > 1) {
    throw new Error(`expected at most one open dialog, found ${open.length}`)
  }
  return open[0] ?? null
}

async function confirmReset(renderer: ReactTestRenderer): Promise<void> {
  const button = await findResetButton(renderer)
  await act(async () => button.props.onPress())
  const dialog = openDialog(renderer)
  if (dialog?.title !== 'Use a rate-limit reset?') {
    throw new Error('Reset-card confirmation not open')
  }
  await act(async () => {
    dialog.onConfirm()
    dialog.onCancel()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('accounts route zcode rate-limit reset', () => {
  beforeEach(() => {
    dependencies.loadHosts.mockReset().mockResolvedValue([
      {
        id: 'host-1',
        name: 'Desk',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        lastConnected: 1
      }
    ])
    dependencies.back.mockReset()
    dependencies.statusCapabilities.mockReset().mockReturnValue(['accounts.zcode-reset-credit.v1'])
    dependencies.resetRequest.mockReset().mockImplementation(() => ({
      id: 'reset',
      ok: true,
      result: { snapshot: RESET_SNAPSHOT },
      _meta: { runtimeId: 'runtime-1' }
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hides the action when an older host does not advertise the capability', async () => {
    dependencies.statusCapabilities.mockReturnValue([])
    const renderer = await renderAccountsRoute()
    await act(async () => {
      await Promise.resolve()
    })

    expect(resetButtons(renderer)).toHaveLength(0)
    expect(dependencies.resetRequest).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('sends the card window with the host-owned key policy and shows the refreshed snapshot', async () => {
    const renderer = await renderAccountsRoute()
    await confirmReset(renderer)

    expect(dependencies.resetRequest).toHaveBeenCalledOnce()
    expect(dependencies.resetRequest.mock.calls[0]?.[0]).toEqual({ resetType: 'FIVE_HOUR' })
    expect(dependencies.resetRequest.mock.calls[0]?.[1]).toEqual({ timeoutMs: 90_000 })

    // The spend has one outcome; its notice doubles as the refreshed-state confirmation.
    const dialog = openDialog(renderer)
    expect(dialog).toMatchObject({
      title: 'Rate limits reset',
      message: 'The five-hour usage window has been reset.'
    })
    act(() => renderer.unmount())
  })

  it('puts a failed spend on screen without losing the confirm flow', async () => {
    dependencies.resetRequest.mockRejectedValueOnce(new Error('gateway 502'))
    const renderer = await renderAccountsRoute()
    await confirmReset(renderer)

    expect(openDialog(renderer)).toMatchObject({
      title: 'Could not use the rate-limit reset',
      message: 'gateway 502'
    })
    act(() => renderer.unmount())
  })

  it('spends the weekly pool through its own row and confirmation', async () => {
    const renderer = await renderAccountsRoute()
    const weeklyButtons = renderer.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.props.accessibilityLabel === 'Use GLM weekly rate-limit reset'
    )
    await vi.waitFor(() => expect(weeklyButtons).toHaveLength(1))
    await act(async () => weeklyButtons[0]!.props.onPress())
    const dialog = openDialog(renderer)
    expect(dialog).toMatchObject({ title: 'Use a weekly rate-limit reset?' })
    await act(async () => {
      dialog?.onConfirm()
      dialog?.onCancel()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.resetRequest).toHaveBeenCalledOnce()
    expect(dependencies.resetRequest.mock.calls[0]?.[0]).toEqual({ resetType: 'WEEK' })
    act(() => renderer.unmount())
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const renderer = await renderAccountsRoute()
    const button = await findResetButton(renderer)
    await act(async () => button.props.onPress())
    act(() => openDialog(renderer)?.onCancel())

    expect(openDialog(renderer)).toBeNull()
    expect(dependencies.resetRequest).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
