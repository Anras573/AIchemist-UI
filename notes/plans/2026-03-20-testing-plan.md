# Testing Plan — AIchemist-UI

**Goal:** Introduce a regression-preventing test suite focused on unit and component tests. Start incrementally from pure logic outwards toward the Electron boundary.

---

## Framework Decisions

| Concern | Choice | Reason |
|---|---|---|
| Test runner | **Vitest** | ESM-native, no Jest transform config overhead, shares Vite config, works seamlessly with electron-vite setup |
| DOM environment | **jsdom** (via `vitest` `environment: 'jsdom'`) | Sufficient for renderer-layer tests; no real browser needed |
| Component tests | **React Testing Library** + **@testing-library/jest-dom** | Standard, discourages implementation testing |
| User interaction | **@testing-library/user-event** | Realistic event simulation vs `fireEvent` |
| Mocking | **Vitest built-ins** (`vi.fn`, `vi.mock`, `vi.spyOn`) | No extra libraries needed |
| Coverage | **@vitest/coverage-v8** | Zero-config V8 coverage via Vitest |

**No Playwright / E2E in scope for now.** That requires the full Electron binary and is a separate initiative.

---

## The Core Mocking Challenge: `window.electronAPI`

Every hook and component that calls `ipc.*` indirectly calls `window.electronAPI`. In a jsdom environment this object does not exist. The strategy:

1. Create a **shared mock factory** at `src/test/mocks/electronAPI.ts` that returns a complete typed stub where every method is `vi.fn()` returning resolved Promises.
2. In `vitest.setup.ts`, assign `window.electronAPI = createElectronAPIMock()` before every test.
3. Individual tests override specific methods: `vi.mocked(window.electronAPI.listProjects).mockResolvedValue([...])`.

This cleanly decouples all renderer tests from Electron without patching the `ipc` module itself.

---

## Project Structure

```
src/
  test/
    mocks/
      electronAPI.ts     ← shared window.electronAPI stub
      ipc.ts             ← (optional) ipc module-level mock helpers
    utils/
      renderWithProviders.tsx  ← wrapper with TooltipProvider + store reset
    setup.ts             ← global beforeEach: assign window.electronAPI mock
```

Tests live **colocated** with the source:

```
src/lib/utils.test.ts
src/lib/models.test.ts
src/lib/store/useSessionStore.test.ts
src/lib/store/useProjectStore.test.ts
src/lib/hooks/useTheme.test.ts
src/lib/hooks/useSessionEvents.test.ts
src/lib/hooks/useAgentTurn.test.ts
src/components/ui/button.test.tsx
src/components/session/StatusDot.test.tsx
...
```

---

## Vitest Configuration

Add to `vite.config.ts` (or a separate `vitest.config.ts`):

```ts
/// <reference types="vitest" />
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    alias: {
      '@/': new URL('./src/', import.meta.url).pathname,
    },
  },
})
```

**Note:** electron-vite controls the main-process build; renderer tests run through plain Vitest, not electron-vite. The `@/` alias needs to be replicated in the Vitest config since `electron.vite.config.ts` is not used by the test runner.

---

## Dependencies to Add

```json
"devDependencies": {
  "vitest": "^3.x",
  "@vitest/coverage-v8": "^3.x",
  "@testing-library/react": "^16.x",
  "@testing-library/user-event": "^14.x",
  "@testing-library/jest-dom": "^6.x",
  "jsdom": "^26.x"
}
```

And add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

---

## Phase 1 — Pure Functions & Store Logic (no DOM)

These have zero external dependencies and are the fastest wins.

### `src/lib/utils.test.ts`

`cn()` wraps clsx + tailwind-merge. Test cases:

- Single class string passes through unchanged
- Falsy values (`false`, `undefined`, `null`) are dropped
- Conflicting Tailwind classes resolve to the last one (`p-2 p-4` → `p-4`)
- Array and object syntax are handled

### `src/lib/models.test.ts`

`getModelLabel(provider, modelId)`:

- Returns the exact `label` for each entry in `ANTHROPIC_MODELS`
- Transforms an unknown ID: `gpt-4o-mini` → `Gpt 4o Mini`
- Handles digits immediately after a dash: `claude-3-5` → `Claude 3 5`
- Empty string doesn't throw

`getLogoProvider(provider)`:

- `"copilot"` → `"github-copilot"`
- `"anthropic"` → `"anthropic"` (pass-through)
- Unknown string → passes through unchanged

### `src/lib/store/useSessionStore.test.ts`

Test each action in isolation by calling the store's action and asserting on `useSessionStore.getState()`. Reset store between tests with `useSessionStore.setState(initialState)`.

Key cases:

**mergeSessions:**
- Adding new sessions without touching existing ones
- Preserves existing messages when incoming has `messages: []` (the critical regression case — `listSessions` returns empty arrays)
- Overwrites metadata (title, status) but not messages

**hydrateSession:**
- Replaces messages with the hydrated set
- Preserves other session fields (status, streaming state)

**commitMessage:**
- Appends message and clears streaming text in a single state update
- Deduplicates: calling with same message ID twice is a no-op

**appendStreamingDelta:**
- Concatenates deltas correctly across multiple calls
- Does not touch other sessions

**removeSession:**
- Clears `activeSessionId` when the removed session was active
- Leaves `activeSessionId` unchanged when removing a different session

**clearPendingApprovals:**
- Calls `resolve(false)` on each pending approval before removing it (unblocks agent loop)

**resolveApproval:**
- Calls `resolve(true/false)` on the matching approval
- Removes the resolved approval from the list

### `src/lib/store/useProjectStore.test.ts`

**removeProject:**
- Filters out the project by ID
- Clears `activeProjectId` when removed project was active

**updateProject:**
- Replaces matching project in the array
- Does not affect other projects

---

## Phase 2 — React Components

Setup: `renderWithProviders` wraps components in `<TooltipProvider>` (required by many ui/ components) and resets Zustand stores before each test.

### `src/components/ui/` — Basic UI primitives

These are mostly shadcn wrappers. Light smoke tests are sufficient:

- `button.test.tsx` — renders, calls `onClick`, disabled state blocks click
- `input.test.tsx` — renders, typing updates value, disabled blocks input
- `badge.test.tsx` — renders text, applies variant class
- `textarea.test.tsx` — renders, resizable, onChange fires

### `src/components/session/StatusDot.test.tsx`

- Renders the correct color/aria-label for each `SessionStatus` value
- No IPC dependency, fully isolated

### `src/components/session/SessionTabBar.test.tsx`

Mock `ipc.getCopilotModels` to return `[]`. Assert:

- Model picker button renders the current model label
- Status dot reflects session status
- (future) Model change calls `ipc.updateSessionModel`

### `src/components/layout/AppShell.test.tsx`

Heavy component, test at smoke level initially:

- Renders without crashing given no active project
- Renders without crashing given an active project with sessions

---

## Phase 3 — Custom Hooks

Use `renderHook` from RTL. The `window.electronAPI` mock is already in place via setup.ts.

### `src/lib/hooks/useTheme.test.ts`

- Default theme is `"system"` when localStorage is empty
- Setting theme updates localStorage and `document.documentElement` class
- `settingsWrite` is called when theme changes

### `src/lib/hooks/useSessionEvents.test.ts`

This hook wires `window.electronAPI.on(channel, listener)` to store actions. Strategy: capture the listener registered for each channel, then call it directly with test payloads.

Key cases:

- `session:status` → calls `updateSessionStatus`; also calls `clearStreamingText` when status is `"idle"` or `"error"`
- `session:delta` → calls `appendStreamingDelta` with the text delta
- `session:message` → calls `commitMessage`
- `session:tool_call` for a shell tool with a `command` field → calls `appendTerminalOutput` with `$ <command>\n`
- `session:tool_result` for a shell tool → formats output and appends to terminal
- `session:tool_result` with MCP nested format (`{ content: [{type, text}] }`) → extracts text correctly
- `session:approval_required` → calls `addPendingApproval` with a `resolve` that calls `ipc.approveToolCall`
- Cleanup: listeners are removed on unmount (verify `window.electronAPI.off` is called)

`formatBashOutput` (exported for testing or tested via the hook):

- Valid JSON with stdout + stderr + exit_code=0 → stdout only
- Valid JSON with non-zero exit code → includes `[exit code: N]`
- Invalid JSON → returns the raw string as-is

### `src/lib/hooks/useAgentTurn.test.ts`

Setup: populate the store with an active session and project, mock `ipc.saveMessage`, `ipc.agentSend`, `ipc.updateSessionTitle`.

Key cases:

- `sendMessage` returns early if `activeSessionId` is null
- Calls `ipc.saveMessage` and appends result to store
- Sets session status to `"running"` before calling `ipc.agentSend`
- Auto-titles session (calls `ipc.updateSessionTitle`) when it is the first message
- Does **not** auto-title for subsequent messages (session already has messages)
- Truncates title at 60 chars with ellipsis
- On `ipc.agentSend` rejection: sets status to `"error"`, clears streaming and tool calls
- Clears live tool calls and pending approvals after `agentSend` resolves

---

## Phase 4 — IPC / Main Process (Future)

Explicitly out of scope for now. When approached:

- Use an **in-memory SQLite** instance (pass `:memory:` to `better-sqlite3`) rather than mocking it
- Test `electron/sessions.ts` and `electron/projects.ts` as pure Node modules (no Electron runtime needed)
- Test `electron/config.ts` by injecting environment variables via `process.env` in test setup
- Agent runners (`claude.ts`, `copilot.ts`) require mocking the Anthropic/Copilot SDKs — use `vi.mock('@anthropic-ai/claude-agent-sdk')` etc.
- `electron/main.ts` IPC handler integration tests need `electron-mock-ipc` or a test harness — defer until the above layers have coverage

---

## Zustand Store Reset Pattern

Zustand stores use `persist` middleware writing to localStorage. Tests must reset both:

```ts
// In beforeEach
import { useSessionStore } from '@/lib/store/useSessionStore'
import { useProjectStore } from '@/lib/store/useProjectStore'

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState())
  useProjectStore.setState(useProjectStore.getInitialState())
  localStorage.clear()
})
```

If `getInitialState()` is not available (older Zustand API), destructure the initial state object manually.

---

## What Intentionally Has No Tests (for now)

| Area | Reason |
|---|---|
| `electron/main.ts` | Requires Electron runtime or heavy mocking |
| `electron/agent/` | Requires streaming SDK mocks — complex, deferred to Phase 4 |
| `electron/db.ts` | DB migration tests are valuable but need separate setup; Phase 4 |
| `src/components/ai-elements/` | Thin wrappers — tested indirectly via session components |
| E2E flows | Needs Playwright + Electron binary; separate initiative |

---

## Execution Order

1. Install dependencies and wire Vitest config
2. Write `electronAPI` mock + `renderWithProviders` helper
3. Phase 1 tests (utils, models, stores) — establish baseline, get CI green
4. Phase 2 lightweight component tests (ui/ primitives, StatusDot)
5. Phase 3 hook tests — `useSessionEvents` is the highest-value target
6. Expand component tests to layout/session as features are added
