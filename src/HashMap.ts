
import { nArray } from "./util";

// Jenkins One-at-a-Time hash from http://www.burtleburtle.net/bob/hash/doobs.html
export function hashCodeNumbers(key: number[]): number {
    const n = key.length;
    let hash: number = 0;
    for (let i = 0; i < n; i++) {
        hash += key[i];
        hash += hash << 10;
        hash += hash >>> 6;
    }
    hash += hash << 3;
    hash ^= hash >>> 11;
    hash += hash << 15;
    return hash;
}

export function hashCodeString(key: string): number {
    const n = key.length;
    const numbers = Array(n);
    for (let i = 0; i < n; i++)
        numbers[i] = key.charCodeAt(i);
    return hashCodeNumbers(numbers);
}

export type EqualFunc<K> = (a: K, b: K) => boolean;
export type HashFunc<K> = (a: K) => number;

class HashBucket<K, V> {
    public keys: K[] = [];
    public values: V[] = [];
}

export function nullHashFunc<T>(k: T): number { return 0; }

const NUM_BUCKETS = 16;
export class HashMap<K, V> {
    public buckets: HashBucket<K, V>[] = nArray(NUM_BUCKETS, () => new HashBucket<K, V>());

    constructor(private keyEqualFunc: EqualFunc<K>, private keyHashFunc: HashFunc<K>) {
    }

    private findBucketIndex(bucket: HashBucket<K, V>, k: K): number {
        for (let i = bucket.keys.length - 1; i >= 0; i--)
            if (this.keyEqualFunc(k, bucket.keys[i]))
                return i;
        return -1;
    }

    private findBucket(k: K): HashBucket<K, V> {
        return this.buckets[this.keyHashFunc(k) % NUM_BUCKETS];
    }

    public get(k: K): V | null {
        const bucket = this.findBucket(k);
        const bi = this.findBucketIndex(bucket, k);
        if (bi < 0) return null;
        return bucket.values[bi];
    }

    public insert(k: K, v: V) {
        const bucket = this.findBucket(k);
        let bi = this.findBucketIndex(bucket, k);
        if (bi === -1) bi = bucket.keys.length;
        bucket.keys[bi] = k;
        bucket.values[bi] = v;
    }

    public delete(k: K): void {
        const bucket = this.findBucket(k);
        const bi = this.findBucketIndex(bucket, k);
        if (bi === -1) return;
        bucket.keys.splice(bi, 1);
        bucket.values.splice(bi, 1);
    }

    public* entries(): IterableIterator<[K, V]> {
        for (let i = 0; i < this.buckets.length; i++) {
            const bucket = this.buckets[i];
            for (let j = bucket.keys.length; j >= 0; j--)
                yield [bucket.keys[j], bucket.values[j]];
        }
    }
}