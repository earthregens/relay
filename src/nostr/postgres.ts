import knex from 'knex';
import 'pg-query-stream';
import Event from '../model/event';

const getConnection = async () => {
  return knex({
    client: 'pg',
    connection: process.env.POSTGRES_URI ? process.env.POSTGRES_URI : {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    },
    pool: {
      min: process.env.POSTGRES_MIN_POOL_SIZE ? Number(process.env.POSTGRES_MIN_POOL_SIZE) : 0,
      max: process.env.POSTGRES_MAX_POOL_SIZE ? Number(process.env.POSTGRES_MAX_POOL_SIZE) : 3,
      idleTimeoutMillis: 60000,
      propagateCreateError: false,
      acquireTimeoutMillis: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
      ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
      : 60000,
    },
    acquireConnectionTimeout: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
      ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
      : 60000,
  });
}

// {
//   "ids": <a list of event ids or prefixes>,
//   "authors": <a list of pubkeys or prefixes, the pubkey of an event must be one of these>,
//   "kinds": <a list of a kind numbers>,
//   "#e": <a list of event ids that are referenced in an "e" tag>,
//   "#p": <a list of pubkeys that are referenced in a "p" tag>,
//   "since": <an integer unix timestamp in seconds, events must be newer than this to pass>,
//   "until": <an integer unix timestamp in seconds, events must be older than this to pass>,
//   "limit": <maximum number of events to be returned in the initial query>
// }

export const getEvents = async (filters: any) => {
  console.log('GET event from DB: ', filters);
  // TODO: create read replicas
  const readClient = await getConnection();
  try {
    const results = await readClient.raw('SELECT * from events');
    return results?.[0] || [];
  } catch (error) {
    console.log(error);
  }
}

export const storeEvent = async (event: Event) => {
  console.log('STORE event to DB: ', event);
  const writeClient = await getConnection();
  const date = new Date();
  const postgresTimestamp = date.toISOString().replace('T', ' ').substring(0, 19);
  try {
    var results = await writeClient('events').insert({
      content: event.content,
      created_at: postgresTimestamp,
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      tags: event.tags,
      sig: event.sig,
    });
    return results?.[0] || [];
  } catch (error) {
    console.log(error);
  }
}
