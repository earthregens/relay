export type DbSnEvent = {
  id: string;
  created_at: number;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export class Subscription {
  query: string;
  lastEvent: number;

  constructor(query?: string, lastEvent?: number) {
    this.query = query ?? '';
    this.lastEvent = lastEvent ?? 0;
  }
}

// Nostr event types

export const SOCKET = {
  CONNECTION: 'connection',
  MESSAGE: 'message',
  ERROR: 'error'
};

export const NOSTR_MESSAGE = {
  OK: 'OK',
  REQ: 'REQ',
  EOSE: 'EOSE',
  EVENT: 'EVENT',
  CLOSE: 'CLOSE',
  NOTICE: 'NOTICE'
};

export const CLOSE_CODES = {
  SERVICE_RESTART: 1012
};