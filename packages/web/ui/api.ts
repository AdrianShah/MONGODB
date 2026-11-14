import type { PipelineMessage, TicketCard, TimelineEvent } from '../src/types.js';

export type { ReviewCard, Stage, TicketCard, TimelineEvent } from '../src/types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  me: () => call<{ approver_id: string }>('GET', '/api/me'),
  login: (approver_id: string, password: string) => call<{ approver_id: string }>('POST', '/api/login', { approver_id, password }),
  logout: () => call<{ ok: true }>('POST', '/api/logout', {}),
  decide: (reviewId: string, action: 'approve' | 'reject') =>
    call<{ outcome: string }>('POST', `/api/reviews/${reviewId}/${action}`, {}),
  pipeline: () => call<{ tickets: TicketCard[] }>('GET', '/api/pipeline'),
  timeline: (traceId: string) => call<{ events: TimelineEvent[] }>('GET', `/api/timeline/${encodeURIComponent(traceId)}`),
};

export type FeedStatus = 'connecting' | 'live' | 'reconnecting';

/** The live pipeline over WebSocket. Reconnects forever; each (re)connect starts with the full pipeline (U9). */
export function subscribePipeline(onTickets: (t: TicketCard[]) => void, onStatus: (s: FeedStatus) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/pipeline`);
    ws.onopen = () => onStatus('live');
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as PipelineMessage;
      if (msg.type === 'pipeline') onTickets(msg.tickets);
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('reconnecting');
      retry = setTimeout(connect, 1000);
    };
  };
  onStatus('connecting');
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}

export const dollars = (cents: number | undefined) =>
  cents === undefined ? '' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
