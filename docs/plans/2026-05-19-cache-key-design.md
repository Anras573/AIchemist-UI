# Cache Key Improvement Design (Copilot Plugin Skills)

## Goal
Improve `scanCopilotPluginSkills()` cache-key precision so cache invalidation detects:
- plugin add/remove/move changes
- direct edits to existing `SKILL.md` files

while preserving the 30s TTL performance optimization.

## Scope
- File: `electron/main.ts`
- Function: `scanCopilotPluginSkills()`
- Cache type: `copilotPluginSkillsCache`

Out of scope:
- file watchers
- changes to Claude plugin cache behavior

## Current Problem
The current cache key uses only the mtime of `~/.copilot/installed-plugins` root.
Nested changes inside existing scope/plugin directories may not update that root mtime,
which can allow stale cache hits within the TTL window.

## Chosen Approach
Use a composite snapshot key captured during full scan and validated on cache-hit path.

### Snapshot contents
1. Root directory metadata:
   - `~/.copilot/installed-plugins` mtime
2. Directory metadata for each discovered:
   - scope directory
   - plugin directory
   - `skills` directory
3. File metadata for each discovered `SKILL.md`:
   - mtime
   - size

### Cache-hit validation
On each lookup:
1. Check TTL first (30s).
2. If TTL-valid and cache exists, re-stat tracked paths from snapshot.
3. If all metadata matches, return cached results.
4. If any path is missing or metadata changed, invalidate cache and rescan.

## Error Handling
- Snapshot validation failures are treated as invalid cache (rescan).
- Missing/unreadable root remains `[]` (existing behavior).
- No silent stale reuse when tracked metadata check fails.

## Performance Expectations
- Cache-hit path remains fast and bounded (stat-only checks on tracked paths).
- No subprocesses and no recursive hashing over unknown files.
- Full scan remains unchanged and only occurs on invalidation/TTL expiry.

## Testing Plan
Add focused tests for:
1. cache hit when no metadata changes
2. invalidation on `SKILL.md` mtime/size change
3. invalidation on plugin directory topology change
4. invalidation when tracked path disappears

Run:
- `bun run typecheck`
- `bun run test`

## Acceptance Criteria
- Edits to existing `SKILL.md` invalidate cache before TTL-based stale return.
- Plugin add/remove/move invalidates cache.
- Existing API/output shape and provider behavior remain unchanged.
