# Changelog — @watchupltd/react-native

## 0.2.0

### Added
- Offline queue persisted to AsyncStorage (or any `storage` adapter) and restored on the next launch, including retries with their original idempotency keys.
- NetInfo integration: delivery pauses offline (without using retry attempts) and resumes on reconnect; AppState background/active flushes.
- Unhandled promise rejection capture (Hermes and JSC), `setScreen()`, `useScreen()` and `useNavigationTracking()` for React Navigation.
- Byte-aware chunking, truncation, redaction and idempotent retries from the shared core.

### Fixed
- `AbortSignal.timeout` is not available on Hermes; requests now use an AbortController timeout.
- Optional native modules are loaded with literal `require()` calls that Metro accepts.
- The provider no longer shuts its client down during a StrictMode remount.
