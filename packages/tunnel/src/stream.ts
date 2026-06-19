const BINARY_STRING_CHUNK_SIZE = 0x8000;

const base64ToBase64Url = (value: string): string => {
  return value.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const base64UrlToBase64 = (value: string): string => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;

  return base64 + "=".repeat(paddingLength);
};

const bytesToBinaryString = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BINARY_STRING_CHUNK_SIZE
  ) {
    chunks.push(
      String.fromCharCode(
        ...bytes.subarray(offset, offset + BINARY_STRING_CHUNK_SIZE),
      ),
    );
  }

  return chunks.join("");
};

const binaryStringToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length);
  for (
    let offset = 0;
    offset < value.length;
    offset += BINARY_STRING_CHUNK_SIZE
  ) {
    const chunk = value.slice(offset, offset + BINARY_STRING_CHUNK_SIZE);
    bytes.set(
      Uint8Array.from(chunk, (character) => character.charCodeAt(0)),
      offset,
    );
  }
  return bytes;
};

export const base64UrlEncode = (bytes: Uint8Array): string => {
  return base64ToBase64Url(btoa(bytesToBinaryString(bytes)));
};

export const base64UrlDecode = (value: string): Uint8Array => {
  return binaryStringToBytes(atob(base64UrlToBase64(value)));
};

export interface AsyncFrameQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  fail(error: Error): void;
}

type Waiter<T> = {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: Error) => void;
};

class DefaultAsyncFrameQueue<T> implements AsyncFrameQueue<T> {
  #buffer: T[] = [];
  #error: Error | undefined;
  #isClosed = false;
  #waiters = new Set<Waiter<T>>();

  push(value: T): void {
    if (this.#isClosed) {
      return;
    }

    const waiter = this.#shiftWaiter();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.#buffer.push(value);
  }

  close(): void {
    if (this.#isClosed) {
      return;
    }

    this.#isClosed = true;
    this.#resolveWaitersWithEnd();
  }

  fail(error: Error): void {
    if (this.#isClosed) {
      return;
    }

    this.#error = error;
    this.#isClosed = true;
    this.#rejectWaiters(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let isIteratorClosed = false;
    const pendingWaiters = new Set<Waiter<T>>();

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (isIteratorClosed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        if (this.#buffer.length > 0) {
          return Promise.resolve({
            value: this.#buffer.shift() as T,
            done: false,
          });
        }

        if (this.#error) {
          return Promise.reject(this.#error);
        }

        if (this.#isClosed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve, reject) => {
          let waiter: Waiter<T>;
          waiter = {
            resolve: (result) => {
              pendingWaiters.delete(waiter);
              resolve(result);
            },
            reject: (error) => {
              pendingWaiters.delete(waiter);
              reject(error);
            },
          };
          pendingWaiters.add(waiter);
          this.#waiters.add(waiter);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        isIteratorClosed = true;
        for (const waiter of pendingWaiters) {
          this.#waiters.delete(waiter);
          waiter.resolve({ value: undefined, done: true });
        }
        pendingWaiters.clear();

        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  #shiftWaiter(): Waiter<T> | undefined {
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      return waiter;
    }
    return undefined;
  }

  #resolveWaitersWithEnd(): void {
    for (const waiter of this.#waiters) {
      waiter.resolve({ value: undefined, done: true });
    }
    this.#waiters.clear();
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

export const createAsyncFrameQueue = <T>(): AsyncFrameQueue<T> => {
  return new DefaultAsyncFrameQueue<T>();
};
