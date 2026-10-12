// Minimal JSON-RPC 2.0 request/response/notification shapes used by the
// daemon<->extension protocol. Framing is newline-delimited JSON (NDJSON)
// over a Unix domain socket / Windows named pipe — a deliberately simpler
// transport than the architecture doc's suggested LSP-style
// Content-Length framing, tracked as a follow-up (see README).

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const SERVICE_VERSION = "0.1.0";
export const SCHEMA_VERSION = 1;
