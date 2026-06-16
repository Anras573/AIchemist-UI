import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useIpcQuery, _resetIpcQueryCache } from "./useIpcQuery";

beforeEach(() => {
  _resetIpcQueryCache();
});

describe("useIpcQuery", () => {
  it("fetches on mount and exposes data", async () => {
    const fetcher = vi.fn().mockResolvedValue("hello");
    const { result } = renderHook(() => useIpcQuery("k", fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.data).toBe("hello"));
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ force: false });
  });

  it("does not fetch when the key is null", async () => {
    const fetcher = vi.fn().mockResolvedValue("x");
    const { result } = renderHook(() => useIpcQuery(null, fetcher));

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("dedupes concurrent fetches for the same key (in-flight)", async () => {
    const fetcher = vi.fn().mockResolvedValue("shared");

    const a = renderHook(() => useIpcQuery("dedupe", fetcher));
    const b = renderHook(() => useIpcQuery("dedupe", fetcher));

    await waitFor(() => {
      expect(a.result.current.data).toBe("shared");
      expect(b.result.current.data).toBe("shared");
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves cached value within the TTL without re-fetching", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);

    const first = renderHook(() => useIpcQuery("ttl", fetcher, { ttl: 10_000 }));
    await waitFor(() => expect(first.result.current.data).toBe(1));

    // A fresh mount within the TTL reads the cache immediately, no second call.
    const second = renderHook(() => useIpcQuery("ttl", fetcher, { ttl: 10_000 }));
    expect(second.result.current.data).toBe(1);
    expect(second.result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let now = 1_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn().mockResolvedValue("v");
    try {
      const first = renderHook(() => useIpcQuery("expiry", fetcher, { ttl: 100 }));
      await waitFor(() => expect(first.result.current.data).toBe("v"));
      expect(fetcher).toHaveBeenCalledTimes(1);

      now += 1_000; // advance past the TTL
      renderHook(() => useIpcQuery("expiry", fetcher, { ttl: 100 }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    } finally {
      spy.mockRestore();
    }
  });

  it("refetch forces a new fetch and passes force:true", async () => {
    const fetcher = vi.fn().mockResolvedValue("a");
    const { result } = renderHook(() => useIpcQuery("refetch", fetcher, { ttl: 10_000 }));
    await waitFor(() => expect(result.current.data).toBe("a"));

    fetcher.mockResolvedValue("b");
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toBe("b");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ force: true });
  });

  it("keeps stale data visible while a forced refetch is in flight", async () => {
    let resolveSecond!: (v: string) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockImplementationOnce(() => new Promise<string>((r) => { resolveSecond = r; }));

    const { result } = renderHook(() => useIpcQuery("stale", fetcher, { ttl: 10_000 }));
    await waitFor(() => expect(result.current.data).toBe("first"));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.refetch();
    });

    // Data stays put; only `fetching` reflects the in-flight refresh.
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(result.current.data).toBe("first");
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveSecond("second");
      await pending;
    });
    expect(result.current.data).toBe("second");
  });

  it("exposes errors and recovers on refetch", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useIpcQuery("err", fetcher, { ttl: 10_000 }));

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect((result.current.error as Error).message).toBe("boom");
    expect(result.current.data).toBeUndefined();

    fetcher.mockResolvedValueOnce("ok");
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.data).toBe("ok");
  });

  it("isolates entries by key", async () => {
    const fa = vi.fn().mockResolvedValue("A");
    const fb = vi.fn().mockResolvedValue("B");

    const a = renderHook(() => useIpcQuery("key-a", fa));
    const b = renderHook(() => useIpcQuery("key-b", fb));

    await waitFor(() => {
      expect(a.result.current.data).toBe("A");
      expect(b.result.current.data).toBe("B");
    });
  });
});
