import NOSTR from '../../enum/nostr';

const formatEvent = (subscriptionId: string, event: object) =>
  JSON.stringify([NOSTR.EVENT, subscriptionId, event]);

const formatEose = (subscriptionId: string) =>
  JSON.stringify([NOSTR.EOSE, subscriptionId]);

const formatNotice = (message) => JSON.stringify([NOSTR.NOTICE, message]);

const formatOk = (eventId: String) =>
  JSON.stringify([NOSTR.OK, eventId, true, '']);

const formatNotOk = (eventId: String, error: String) =>
  JSON.stringify([NOSTR.OK, eventId, false, error]);

export { formatEvent, formatNotice, formatOk, formatNotOk, formatEose };
