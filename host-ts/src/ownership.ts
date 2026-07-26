/** Read-only discovery of the optional Python 1.x dashboard on loopback.
 *
 * The two hosts deliberately share an advisory BLE-owner lock. This probe
 * never breaks that lock or stops Python: it makes a user-approved handoff
 * understandable in the desktop UI.
 */
export type TraditionalOwner = { state: "running" | "unavailable"; detail?: string };
export type OwnerFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function probeTraditionalOwner(fetcher: OwnerFetch = fetch): Promise<TraditionalOwner> {
  try {
    const response = await fetcher("http://127.0.0.1:7860/api/status", { signal: AbortSignal.timeout(700) });
    if (!response.ok) return { state: "unavailable" };
    const status: unknown = await response.json();
    const connected = typeof status === "object" && status !== null && "connected" in status && (status as { connected?: unknown }).connected === true;
    return { state: "running", detail: connected ? "Python 1.x is connected to the Stick." : "Python 1.x is running and may reconnect to the Stick." };
  } catch {
    return { state: "unavailable" };
  }
}
