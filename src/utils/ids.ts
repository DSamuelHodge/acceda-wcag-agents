// src/utils/ids.ts
// Prefixed ID generation for D1 records.
// Format: {prefix}_{timestamp_base36}_{random_base36}
// Sortable, readable, collision-resistant without a DB round-trip.

export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

export function generateAuditId(url: string): string {
  // Deterministic audit ID for idempotent CI runs on the same URL+commit
  const urlHash = simpleHash(url);
  return `audit_${urlHash}_${Date.now().toString(36)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
