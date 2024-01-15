import { formatEvent, formatNotice, formatOk, formatNotOk } from '../../../helper/format-event';
import Event from '../../../model/event';

import { getEvents } from '../../../nostr/postgres';
import { storeEvent } from '../../../nostr/postgres';
import { formatEose } from '../helper/format-event';

const baseUri = process.env.BASE_URI;

// TODO: Implement NIP-42

const getReq = async (ws: WebSocket, filters: any, subscriptionId: string) => {
  console.log('Sending...');

  const rows = [];
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i];
    const result = await getEvents(filter);
    // TypeScript is getting confused about the return types, but
    // we can still treat the result as an array. Maybe a cleaner fix is doable.
    // @ts-ignore
    rows.push(...result);
  }

  // Convert the PostgreSQL rows to the format expected by the client
  const events = rows.map(row => {
    const tags = [];
    if (row.e_ref) {
      tags.push(['e', row.e_ref]);
    }
    if (row.p_ref) {
      tags.push(['p', row.p_ref]);
    }
    const event = {
      id: row.id,
      pubkey: row.pubkey,
      created_at: new Date(row.created_at).getTime() / 1000,
      kind: row.kind,
      tags: tags.concat(row.tags ? JSON.parse(row.tags) : []),
      content: row.content,
      sig: row.sig
    };
    return event;
  });

  // Sort the events by timestamp
  events.sort((a, b) => a.created_at - b.created_at);

  events.forEach((row) => {
    console.log(formatEvent(subscriptionId, row));
    ws.send(formatEvent(subscriptionId, row));
  });

  // Finally, send the end-of-stored-events message (NIP 15)
  ws.send(formatEose(subscriptionId));
};

const putEvent = async (ws: WebSocket, event: Event) => {
  try {
    // Store the event in the DB
    const response = await storeEvent(event);

    // send nip01 result
    ws.send(formatOk(event.id));

    return response;
  } catch (err) {
    console.error(
      `[ERROR]: Error when persisting event to Relay! Status: ${err.response?.status}, Message: ${err.response?.data?.message}`
    );

    if (err.response) {
      ws.send(formatNotice(`[ERROR]: ${err?.message}`));
      ws.send(formatNotOk(event.id, err?.message));
    } else {
      ws.send(
        formatNotOk(
          event.id,
          'error: Failed to persist event to Relay!'
        )
      );
    }
  }
};

export default {
  getReq,
  putEvent
};
