// pio.ts names NodeJS.Timeout; boady builds rp2040js without Node types.
declare namespace NodeJS {
  type Timeout = ReturnType<typeof setTimeout>;
}
