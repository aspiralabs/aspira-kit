// Shared, lazily connected Redis client, written by `kit add auth`. Importing
// this during build or on the Edge runtime opens no socket; the first command does.
import IORedis, { type Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedis(): Redis {
    if (!client) {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('REDIS_URL is not set');
        // family 0 resolves IPv6-only hosts (Railway private networking) as well as IPv4.
        client = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true, family: 0 });
    }
    return client;
}
