# Tool Approval UI — Confirmation Component

Date: 2026-03-31

## Problem

The current `ApprovalGate` component in `TimelinePanel.tsx` is hand-rolled with custom
amber styling, a raw JSON `<pre>` args dump, and plain `<button>` elements. The AI
Elements `Confirmation` component provides a purpose-built, polished approval UI that
fits the overall design system and includes accepted/rejected state feedback.

## Approach

Pure UI swap — no IPC, store, or backend changes. Replace the custom `ApprovalGate`
internals with the `Confirmation` component family while keeping the full three-scope
approval logic (once / session / project) intact.

## Design

### Component Mapping

| Current element | Replacement |
|---|---|
| Amber `div` container | `Confirmation` (wraps `Alert`) |
| Header with tool name | `ConfirmationTitle` |
| JSON `<pre>` args block | `ConfirmationRequest` with formatted key-value pairs |
| Allow/Deny `<button>` row | `ConfirmationActions` with `ConfirmationAction` items |
| (nothing — disappears) | `ConfirmationAccepted` — brief feedback before removal |
| (nothing — disappears) | `ConfirmationRejected` — brief feedback before removal |

### Local State Machine

`ApprovalGate` maintains local state to drive the `Confirmation` component:

```
"pending"   → state="approval-requested"   approval={ id }
"approved"  → state="approval-responded"   approval={ id, approved: true }
"denied"    → state="approval-responded"   approval={ id, approved: false }
```

On decision (allow or deny):
1. Call `onDecide(approvalId, approved, scope)` immediately (unblocks the agent)
2. Set local state to `"approved"` or `"denied"` (shows feedback)
3. After 1.5 s, the approval is removed from the Zustand store (card disappears)

Scope tracking: a `scope` local state (`"once" | "session" | "project"`) is set
alongside the decision so `ConfirmationAccepted` can read e.g. "Approved for session".

### Args Formatting

Instead of `JSON.stringify(args, null, 2)` in a `<pre>`:
- Render a compact key → value list (`<dl>` or simple rows)
- Truncate long values (e.g. file contents passed as args) to ~200 chars with a
  "show more" toggle
- Raw JSON fallback for args that are themselves complex objects

### No Changes To

- IPC channels
- Zustand store
- `useSessionEvents` hook
- `onDecide` call signature

## Error Handling

- If `onDecide` throws, revert local state to `"pending"` and surface an error inline
  (same pattern as save errors elsewhere in the app).

## Testing

- Render test: `ApprovalGate` in `"pending"` state renders tool name, args, and all
  four buttons.
- Interaction test: clicking "Allow for session" fires `onDecide` with correct args and
  transitions to accepted state.
- Interaction test: clicking "Deny" transitions to rejected state.
- Snapshot: accepted and rejected states render their feedback text.

## Out of Scope

- Adding a fourth scope or changing scope semantics
- Showing approval history in the session timeline
- Changing the approval trigger logic in `useSessionEvents` or the main process
