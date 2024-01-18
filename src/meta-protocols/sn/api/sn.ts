import { NOSTR_MESSAGE, Subscription } from '../pg/types';
import { formatEvent, formatEose, formatNotice, formatOk, formatNotOk } from '../pg/helpers';
import { DbSnEvent } from '../pg/types';


const baseUri = process.env.BASE_URI;

export const SnRoutes: FastifyPluginCallback<
  Record<never, never>,
  Server,
  TypeBoxTypeProvider
> = (fastify, options, done) => {
  fastify.get('/', { websocket: true }, (ws /* SocketStream */, req /* FastifyRequest */) => {
    ws.socket.on('message', async message => {
      try {
        const event = JSON.parse(message);
        console.log('New handler event: ', event)
        const key = event?.[0] || '';
        const subscriptionId = event?.[1] || '';
        // const filters = event?.[2] || {};
    
        const filters = [];
    
        for (let i = 2; i < event.length; i ++) {
          const iterator = i;
          const filter = event?.[2] || {};
          filters.push(event?.[i]);
        }
    
        switch (key) {
          case NOSTR_MESSAGE.REQ:
            // If the query has changed for this subscription, update it
            const active = subs.get(subscriptionId);
            const activeQuery = active?.query || '';
            const updated = activeQuery != '' && activeQuery !== query;
            if (!active || updated) {
              const sub = new Subscription(JSON.stringify(event), 0);
              subs.set(subscriptionId, sub);
              if (!updated) {
                prom_active_subscriptions.inc();
              }
            }
    
            // Then, handle request
            prom_number_of_reqs.inc();
    
            // Fetch events from PostgreSQL
            await getReq(ws, filters, subscriptionId);
            break;
          case NOSTR_MESSAGE.EVENT:
            prom_number_of_events.inc();
    
            await putEvent(ws, event[1]);
            break;
          case NOSTR_MESSAGE.CLOSE:
            subs.delete(subscriptionId);
            prom_active_subscriptions.dec();
            console.log(`[CLOSED]: subscription ${subscriptionId}`);
            break;
          default:
            console.error('Unsupported message type!');
            ws.send(
              formatNotice(
                '[ERROR]: Unsupported message type! Use one of the following supported keys: "REQ", "EVENT"'
              )
            );
        }
      } catch (err) {
        console.error(
          `[NOTICE]: Failed to parse Nostr message! Message: ${
            err?.data?.message || ''
          }`
        );
        ws.send(formatNotice('[ERROR]: Failed to parse Nostr message!'));
      };
    })
  })
}

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

const putEvent = async (ws: WebSocket, event: DbSnEvent) => {
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