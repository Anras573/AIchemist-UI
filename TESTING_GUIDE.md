# Testing Guide for Performance Improvements

## Overview
This guide provides instructions for manually testing the caching improvements made to plugin skills and MCP server listing.

## What Was Changed

### 1. Plugin Skills Caching
- `scanPluginSkills()` - Claude plugins
- `scanCopilotPluginSkills()` - Copilot plugins
- Both now cache results for 30 seconds

### 2. MCP Server Listing Caching
- `getCachedClaudeServers()` - Claude MCP list output
- Cached for 30 seconds

## Manual Testing

### Test 1: Skills Panel Cache Performance

**Objective:** Verify that opening the Skills panel multiple times is fast after the first load.

**Steps:**
1. Start the application
2. Open the Skills panel (first time - cache miss)
   - Expected: Normal loading time (50-500ms depending on plugins)
3. Close the Skills panel
4. Immediately reopen the Skills panel (within 30s - cache hit)
   - Expected: Instant loading (<5ms)
5. Wait 31+ seconds
6. Open the Skills panel again (cache expired - cache miss)
   - Expected: Normal loading time again

**Success Criteria:**
- Second open is noticeably faster than first open
- Skills list is identical between first and second open
- After 30s, the panel loads fresh data

### Test 2: MCP Servers Panel Cache Performance

**Objective:** Verify that the MCP Servers panel loads quickly on subsequent opens.

**Steps:**
1. Start the application
2. Open the MCP Servers panel (first time - cache miss)
   - Expected: Normal loading time (100-300ms)
3. Close the panel
4. Immediately reopen the panel (within 30s - cache hit)
   - Expected: Instant loading (<5ms)
5. Wait 31+ seconds
6. Open the panel again (cache expired - cache miss)
   - Expected: Normal loading time again

**Success Criteria:**
- Second open is significantly faster
- Server list is identical
- Status indicators (connected/disconnected) are correct

### Test 3: Manual Refresh Bypasses Cache

**Objective:** Verify that the manual refresh button bypasses the cache.

**Steps:**
1. Open the MCP Servers panel
2. Note the list of servers
3. Modify `~/.claude.json` to add/remove an MCP server
4. Click the refresh button in the panel
   - Expected: New server appears immediately (doesn't wait for 30s)

**Success Criteria:**
- Refresh button forces a fresh load
- Changes to MCP config are visible immediately after refresh

### Test 4: Plugin Installation Detection

**Objective:** Verify that installing a plugin invalidates the cache properly.

**Steps:**
1. Open the Skills panel
2. Note the list of skills
3. Install a new plugin that has skills (or modify `installed_plugins.json` mtime)
4. Wait 1 second (cache should still be valid based on time)
5. Close and reopen the Skills panel
   - Expected: Still shows cached results (mtime check should invalidate though)
6. Wait 30 seconds
7. Open the panel again
   - Expected: New plugin skills appear

**Success Criteria:**
- New skills appear after cache expiry
- Modifying plugin files updates the cache on next load

### Test 5: Performance Measurement (Optional)

**Objective:** Measure actual performance improvement.

**Steps:**
1. Open browser DevTools console
2. Add timing code to `src/components/session/SkillsPanel.tsx`:
   ```typescript
   const loadSkills = useCallback(() => {
     if (!projectPath) return;
     setSkills(null);
     const start = performance.now();
     ipc
       .listSkills(projectPath, provider ?? undefined)
       .then((skills) => {
         const elapsed = performance.now() - start;
         console.log(`Skills loaded in ${elapsed.toFixed(2)}ms`);
         setSkills(skills);
       })
       .catch(() => setSkills([]));
   }, [projectPath, provider, ipc]);
   ```
3. Open the Skills panel and check console for timing
4. Close and immediately reopen - check timing again
5. Compare the two measurements

**Success Criteria:**
- Second load is 10-100x faster than first load
- Example: 200ms → 2ms

## Performance Benchmarks

Expected performance improvements (approximate):

| Scenario | Before | After (cached) | Improvement |
|----------|--------|----------------|-------------|
| 5 plugins, first load | 200ms | 200ms | 0% (cache miss) |
| 5 plugins, second load | 200ms | 2ms | 99% (cache hit) |
| 10 plugins, first load | 500ms | 500ms | 0% (cache miss) |
| 10 plugins, second load | 500ms | 3ms | 99.4% (cache hit) |
| MCP list, first load | 150ms | 150ms | 0% (cache miss) |
| MCP list, second load | 150ms | 1ms | 99.3% (cache hit) |

## Troubleshooting

### Cache Not Working
- Verify files aren't being modified between loads (check mtimes)
- Ensure 30s hasn't elapsed between tests
- Check console for any errors

### Stale Data
- Wait for 30s TTL to expire
- Use manual refresh button
- Restart the application (clears in-memory cache)

### Performance Not Improved
- Check if you have many plugins (more plugins = more improvement)
- Verify the panel is actually remounting (not just staying open)
- Check system performance (slow disk I/O might mask improvements)

## Automated Testing (Future Work)

The following test cases should be added to the test suite:

1. **Unit tests for cache logic:**
   - Test cache hit/miss behavior
   - Test cache expiration (30s TTL)
   - Test mtime-based invalidation
   - Test force parameter bypasses cache

2. **Integration tests:**
   - Test full IPC flow with caching
   - Test concurrent requests (shouldn't spawn multiple processes)
   - Test cache consistency across multiple calls

3. **Performance tests:**
   - Benchmark first vs. second load times
   - Verify cache reduces subprocess spawns
   - Measure actual latency improvements

Example test structure (not implemented):
```typescript
// electron/main.test.ts
describe("plugin skills caching", () => {
  it("returns cached results on second call within 30s", async () => {
    const first = scanPluginSkills();
    const second = scanPluginSkills();
    expect(first).toEqual(second);
    // Verify second call didn't re-read files
  });

  it("invalidates cache after 30s", async () => {
    const first = scanPluginSkills();
    await sleep(31_000);
    const second = scanPluginSkills();
    // Verify second call did re-read files
  });
});
```
