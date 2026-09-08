// Root package entry: preserve the existing shared client and expose the
// live-account client through the package root for Metro workspace consumers.
export * from './index';
export { createLiveAccountApi } from './live-account';
export type { LiveAccountApi } from './live-account';
