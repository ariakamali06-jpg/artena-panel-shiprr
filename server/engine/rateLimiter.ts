import type { ActiveConnection, ServiceRecord } from '../types';

const MIN_RATE_BPS = 1024; // 1 KB/s floor to avoid division-by-zero
const MIN_BURST_BYTES = 16 * 1024; // 16 KB minimum burst window

interface Bucket {
  rate: number;
  capacity: number;
  tokens: number;
  lastMs: number;
}

/**
 * Per-service non-blocking token-bucket rate limiter.
 * Services with speedLimitBytes <= 0 bypass allocation and return immediately.
 */
export class SpeedLimiter {
  private buckets = new Map<string, Bucket>();

  private getOrCreate(serviceId: string, rateBytesPerSec: number): Bucket {
    const clampedRate = Math.max(rateBytesPerSec, MIN_RATE_BPS);
    const existing = this.buckets.get(serviceId);
    if (existing && existing.rate === clampedRate) {
      return existing;
    }
    const capacity = Math.max(clampedRate, MIN_BURST_BYTES);
    const bucket: Bucket = {
      rate: clampedRate,
      capacity,
      tokens: capacity,
      lastMs: performance.now(),
    };
    this.buckets.set(serviceId, bucket);
    return bucket;
  }

  private refill(bucket: Bucket, nowMs: number): void {
    const elapsedSec = (nowMs - bucket.lastMs) / 1000;
    if (elapsedSec > 0) {
      bucket.lastMs = nowMs;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.rate);
    }
  }

  async throttle(serviceId: string, bytes: number, rateBytesPerSec: number): Promise<void> {
    if (bytes <= 0 || rateBytesPerSec <= 0) return;

    while (true) {
      const bucket = this.getOrCreate(serviceId, rateBytesPerSec);
      this.refill(bucket, performance.now());
      if (bucket.tokens >= bytes) {
        bucket.tokens -= bytes;
        return;
      }
      const deficit = bytes - bucket.tokens;
      const waitMs = Math.min(Math.max((deficit / bucket.rate) * 1000, 4), 500);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  reset(serviceId: string): void {
    this.buckets.delete(serviceId);
  }

  clear(): void {
    this.buckets.clear();
  }
}

export const speedLimiter = new SpeedLimiter();

export function isServiceExpired(service: Pick<ServiceRecord, 'expiresAt'>, nowMs = Date.now()): boolean {
  if (!service.expiresAt) return false;
  const parsed = Date.parse(service.expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed <= nowMs;
}

export function isServiceQuotaExceeded(service: Pick<ServiceRecord, 'limitBytes' | 'usedBytes'>): boolean {
  return service.limitBytes > 0 && service.usedBytes >= service.limitBytes;
}

export function isServiceAllowed(service: ServiceRecord | undefined | null, nowMs = Date.now()): boolean {
  if (!service) return false;
  if (!service.active) return false;
  if (isServiceExpired(service, nowMs)) return false;
  if (isServiceQuotaExceeded(service)) return false;
  return true;
}

export function evaluateIpAndConnectionLimit(
  service: Pick<ServiceRecord, 'id' | 'ipLimit' | 'connectionLimit'>,
  incomingIp: string,
  activeConnections: Iterable<Pick<ActiveConnection, 'serviceId' | 'ip'>>
): { allowed: boolean; reason?: string } {
  let serviceConnCount = 0;
  const uniqueIps = new Set<string>();

  for (const conn of activeConnections) {
    if (conn.serviceId === service.id) {
      serviceConnCount += 1;
      if (conn.ip) uniqueIps.add(conn.ip);
    }
  }

  if (service.connectionLimit > 0 && serviceConnCount >= service.connectionLimit) {
    return { allowed: false, reason: 'connection_limit_reached' };
  }

  if (service.ipLimit > 0 && incomingIp && !uniqueIps.has(incomingIp) && uniqueIps.size >= service.ipLimit) {
    return { allowed: false, reason: 'ip_limit_reached' };
  }

  return { allowed: true };
}
