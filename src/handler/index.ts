import NOSTR from '../enum/nostr';
import Subscription from '../model/subscription';
import socialService from '../../meta-protocols/sn/api/sn.ts';

const { formatNotice } = require('../helper/format-event');

const handler = async (
  ws: WebSocket,
  query: string,
  subs: Map<string, Subscription>,
  prom_active_subscriptions: any,
  prom_number_of_reqs: any,
  prom_number_of_events: any
) => {
  try {
    const event = JSON.parse(query);
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
      case NOSTR.REQ:
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
        await socialService.getReq(ws, filters, subscriptionId);
        break;
      case NOSTR.EVENT:
        prom_number_of_events.inc();

        await socialService.putEvent(ws, event[1]);
        break;
      case NOSTR.CLOSE:
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
  }
};

export default handler;
