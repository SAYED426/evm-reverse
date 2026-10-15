/**
 * Minimal JSON-RPC client with endpoint fallback.
 *
 * The caller supplies a preferred endpoint (--rpc or ETH_RPC_URL); the public
 * endpoints below are only used as a last resort so a plain `evm-reverse <addr>`
 * still works. They are rate-limited and not guaranteed.
 */

export const FALLBACK_RPCS: readonly string[] = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://rpc.flashbots.net",
];

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class Rpc {
  readonly endpoints: string[];
  private readonly timeoutMs: number;

  constructor(endpoints: string[], timeoutMs = 25_000) {
    const list = endpoints.filter((url) => url.trim().length > 0);
    this.endpoints = list.length > 0 ? list : [...FALLBACK_RPCS];
    this.timeoutMs = timeoutMs;
  }

  /** Build from an optional user URL, appending public fallbacks. */
  static fromUrl(url?: string): Rpc {
    const preferred = url ?? process.env.ETH_RPC_URL ?? process.env.RPC_URL;
    return new Rpc(preferred ? [preferred, ...FALLBACK_RPCS] : [...FALLBACK_RPCS]);
  }

  /** Try each endpoint in order until one answers. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const errors: string[] = [];
    for (const url of this.endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          errors.push(`${url}: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as JsonRpcResponse<T>;
        if (body.error) {
          errors.push(`${url}: ${body.error.message}`);
          continue;
        }
        if (body.result === undefined) {
          errors.push(`${url}: empty result`);
          continue;
        }
        this.selected = url;
        return body.result;
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    throw new RpcError(`all RPC endpoints failed:\n  ${errors.join("\n  ")}`);
  }

  /** The endpoint that last answered successfully. */
  selected?: string;

  async getCode(address: string, block = "latest"): Promise<string> {
    return this.call<string>("eth_getCode", [address, block]);
  }

  async getStorageAt(address: string, slot: string, block = "latest"): Promise<string> {
    return this.call<string>("eth_getStorageAt", [address, slot, block]);
  }

  async call0(address: string, data: string, block = "latest"): Promise<string> {
    return this.call<string>("eth_call", [{ to: address, data }, block]);
  }

  async chainId(): Promise<number> {
    const hex = await this.call<string>("eth_chainId", []);
    return Number.parseInt(hex, 16);
  }

  async blockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return Number.parseInt(hex, 16);
  }
}
