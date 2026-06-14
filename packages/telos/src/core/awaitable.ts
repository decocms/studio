// A value returned either synchronously or as a promise — lets ports (ledger,
// proposer, …) have async or sync implementations behind one signature.
export type Awaitable<T> = T | Promise<T>;
