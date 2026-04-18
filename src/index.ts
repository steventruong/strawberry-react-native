import { Platform, Dimensions, AppState, Linking } from 'react-native';
import type {
  StrawberryConfig,
  StrawberryEvent,
  DeviceInfo,
  ErrorPayload,
  NavigationRef,
  NavigationState,
} from './types';
import { redact, redactString } from './redactor';
import { diagnosticsState, diagnosticsSnapshot } from './diagnostics';
import type { DiagnosticsSnapshot } from './diagnostics';
import { Backoff } from './backoff';

export type {
  StrawberryConfig,
  StrawberryEvent,
  DeviceInfo,
  ErrorPayload,
  NavigationRef,
  NavigationState,
} from './types';
export type { DiagnosticsSnapshot } from './diagnostics';

const DEFAULT_HOST = 'https://straw.berryagents.com';
const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// In-memory storage (zero external deps)
const _memoryStore: Record<string, string> = {};

const storage = {
  async getItem(key: string): Promise<string | null> {
    return _memoryStore[key] || null;
  },
  async setItem(key: string, value: string): Promise<void> {
    _memoryStore[key] = value;
  },
  async removeItem(key: string): Promise<void> {
    delete _memoryStore[key];
  },
};

function getDeviceInfo(): DeviceInfo {
  try {
    const dim = Dimensions.get('window');
    const info: DeviceInfo = {
      platform: Platform.OS,
      os_version: Platform.Version ? String(Platform.Version) : 'unknown',
      device_model: Platform.select({
        ios: 'iPhone',
        android: 'Android Device',
        default: 'unknown',
      }) as string,
      screen_width: dim.width,
      screen_height: dim.height,
    };

    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      info.timezone = resolved.timeZone || 'unknown';
      info.locale = resolved.locale || 'unknown';
    }

    return info;
  } catch (_) {
    return {
      platform: 'unknown',
      os_version: 'unknown',
      device_model: 'unknown',
      screen_width: 0,
      screen_height: 0,
    };
  }
}

function getActiveRouteName(state: NavigationState | undefined): string | null {
  try {
    if (!state) return null;
    const route = state.routes[state.index];
    if (route.state) {
      return getActiveRouteName(route.state);
    }
    return route.name || null;
  } catch (_) {
    return null;
  }
}

class StrawberryClient {
  private apiKey: string;
  private host: string;
  private flushInterval: number;
  private batchSize: number;
  private maxQueueSize: number;
  private releaseVersion: string;

  private queue: StrawberryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private distinctId: string = '';
  private sessionId: string = '';
  private sessionLastActivity: number = 0;
  private userProperties: Record<string, unknown> = {};
  private deviceInfo: DeviceInfo;
  private batchBackoff = new Backoff();
  private errorBackoff = new Backoff();

  private appStateSubscription: { remove: () => void } | null = null;
  private linkingSubscription: { remove: () => void } | null = null;
  private prevErrorHandler: ((error: Error, isFatal: boolean) => void) | null = null;
  private prevPromiseRejectionHandler: ((id: string, error: Error) => void) | null = null;
  private prevNavigationRoute: string | null = null;

  private originalFetch: typeof fetch | null = null;
  private originalXHROpen: ((...args: unknown[]) => unknown) | null = null;
  private originalXHRSend: ((...args: unknown[]) => unknown) | null = null;

  private autocapture: {
    app_lifecycle: boolean;
    crashes: boolean;
    network_requests: boolean;
    deep_links: boolean;
    unhandled_rejections: boolean;
  };

  constructor(config: StrawberryConfig) {
    this.apiKey = config.apiKey;
    this.host = (config.host || DEFAULT_HOST).replace(/\/+$/, '');
    this.flushInterval = config.flushInterval || DEFAULT_FLUSH_INTERVAL;
    this.batchSize = config.batchSize || DEFAULT_BATCH_SIZE;
    this.maxQueueSize = config.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.releaseVersion = config.releaseVersion || '';
    this.deviceInfo = getDeviceInfo();

    this.autocapture = {
      app_lifecycle: config.autocapture?.app_lifecycle !== false,
      crashes: config.autocapture?.crashes !== false,
      network_requests: config.autocapture?.network_requests !== false,
      deep_links: config.autocapture?.deep_links !== false,
      unhandled_rejections: config.autocapture?.unhandled_rejections !== false,
    };

    this.init();
  }

  private async init(): Promise<void> {
    try {
      const storedId = await storage.getItem('strawberry_distinct_id');
      if (storedId) {
        this.distinctId = storedId;
      } else {
        this.distinctId = uuid4();
        await storage.setItem('strawberry_distinct_id', this.distinctId);
      }

      this.ensureSession();
      this.startFlushTimer();

      if (this.autocapture.app_lifecycle) {
        this.setupAppStateTracking();
      }
      if (this.autocapture.crashes) {
        this.setupCrashTracking();
      }
      if (this.autocapture.unhandled_rejections) {
        this.setupUnhandledRejectionTracking();
      }
      if (this.autocapture.network_requests) {
        this.setupNetworkTracking();
      }
      if (this.autocapture.deep_links) {
        this.setupDeepLinkTracking();
      }
    } catch (err) {
      // Never crash the host app
    }
  }

  private ensureSession(): void {
    const now = Date.now();
    if (!this.sessionId || now - this.sessionLastActivity > SESSION_TIMEOUT_MS) {
      this.sessionId = uuid4();
    }
    this.sessionLastActivity = now;
  }

  private startFlushTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drainQueue();
    }, this.flushInterval);
  }

  // -- Auto-capture --

  private setupAppStateTracking(): void {
    try {
      let currentState = AppState.currentState;
      this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
        try {
          if (currentState === 'background' && nextState === 'active') {
            this.track('$app_opened');
          } else if (currentState === 'active' && (nextState === 'background' || nextState === 'inactive')) {
            this.track('$app_backgrounded');
            this.drainQueue();
          }
          currentState = nextState;
        } catch (_) {}
      });
    } catch (_) {}
  }

  private setupCrashTracking(): void {
    try {
      if (typeof global !== 'undefined' && (global as any).ErrorUtils) {
        this.prevErrorHandler = (global as any).ErrorUtils.getGlobalHandler();
        (global as any).ErrorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
          try {
            this.track('$crash', {
              error_message: error?.message || String(error),
              error_stack: error?.stack || '',
              is_fatal: !!isFatal,
            });
            this.sendErrorEnvelope(
              error?.name || 'Error',
              redactString(error?.message || String(error)),
              redactString(error?.stack || ''),
              { is_fatal: !!isFatal },
              {}
            );
            this.drainQueue();
          } catch (_) {}

          if (this.prevErrorHandler) {
            this.prevErrorHandler(error, isFatal);
          }
        });
      }
    } catch (_) {}
  }

  private setupUnhandledRejectionTracking(): void {
    try {
      if (typeof global !== 'undefined') {
        const tracking = (global as any).__strawberry_rejection_tracking;
        if (!tracking) {
          const handler = (_id: string, error: Error) => {
            try {
              this.track('$unhandled_rejection', {
                error_message: error?.message || String(error),
                error_stack: error?.stack || '',
              });
              this.sendErrorEnvelope(
                error?.name || 'UnhandledRejection',
                redactString(error?.message || String(error)),
                redactString(error?.stack || ''),
                { type: 'unhandled_rejection' },
                {}
              );
            } catch (_) {}
          };

          if ((global as any).HermesInternal?.enablePromiseRejectionTracker) {
            (global as any).HermesInternal.enablePromiseRejectionTracker({
              allRejections: true,
              onUnhandled: handler,
            });
          }

          (global as any).__strawberry_rejection_tracking = true;
        }
      }
    } catch (_) {}
  }

  private setupNetworkTracking(): void {
    try {
      this.patchFetch();
      this.patchXHR();
    } catch (_) {}
  }

  private patchFetch(): void {
    if (typeof global === 'undefined' || !(global as any).fetch) return;
    this.originalFetch = (global as any).fetch;
    const self = this;

    (global as any).fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as any)?.url || String(input);
      const method = init?.method || ((input as any)?.method ? (input as any).method : 'GET');
      const startTime = Date.now();

      if (url.indexOf(self.host) === 0) {
        return self.originalFetch!.apply(this, [input, init]);
      }

      return self.originalFetch!.apply(this, [input, init])
        .then((response: Response) => {
          try {
            self.track('$network_request', {
              url,
              method: method.toUpperCase(),
              status_code: response.status,
              duration_ms: Date.now() - startTime,
            });
          } catch (_) {}
          return response;
        })
        .catch((err: Error) => {
          try {
            self.track('$network_request', {
              url,
              method: method.toUpperCase(),
              status_code: 0,
              duration_ms: Date.now() - startTime,
              error: err?.message || String(err),
            });
          } catch (_) {}
          throw err;
        });
    };
  }

  private patchXHR(): void {
    if (typeof global === 'undefined' || !(global as any).XMLHttpRequest) return;
    const XHR = (global as any).XMLHttpRequest;
    const self = this;

    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    this.originalXHROpen = origOpen;
    this.originalXHRSend = origSend;

    XHR.prototype.open = function (method: string, url: string) {
      (this as any)._strawberry = { method, url };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        const info = (this as any)._strawberry;
        if (info && info.url && info.url.indexOf(self.host) === -1) {
          const startTime = Date.now();
          const xhr = this;

          const origHandler = xhr.onreadystatechange;
          xhr.onreadystatechange = function () {
            try {
              if (xhr.readyState === 4) {
                self.track('$network_request', {
                  url: info.url,
                  method: (info.method || 'GET').toUpperCase(),
                  status_code: xhr.status || 0,
                  duration_ms: Date.now() - startTime,
                });
              }
            } catch (_) {}
            if (origHandler) {
              return origHandler.apply(this, arguments);
            }
          };
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  private setupDeepLinkTracking(): void {
    try {
      Linking.getInitialURL()
        .then((url) => {
          if (url) {
            this.track('$deep_link', { url });
          }
        })
        .catch(() => {});

      this.linkingSubscription = Linking.addEventListener('url', (event) => {
        try {
          if (event?.url) {
            this.track('$deep_link', { url: event.url });
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // -- Public API --

  track(
    eventType: string,
    properties?: Record<string, unknown>,
    raw: boolean = false
  ): void {
    try {
      this.ensureSession();
      const cleaned = redact(properties, raw);

      const event: StrawberryEvent = {
        event_type: eventType,
        properties: {
          ...this.deviceInfo,
          ...this.userProperties,
          ...cleaned,
          ...(this.releaseVersion
            ? { $release_version: this.releaseVersion }
            : {}),
        },
        timestamp: new Date().toISOString(),
        distinct_id: this.distinctId || 'anonymous',
        session_id: this.sessionId,
        uuid: uuid4(),
      };

      if (this.queue.length >= this.maxQueueSize) {
        diagnosticsState.recordDrop();
        this.queue.shift();
      }

      this.queue.push(event);
      diagnosticsState.setQueueDepth(this.queue.length);

      if (this.queue.length >= this.batchSize) {
        this.drainQueue();
      }
    } catch (_) {}
  }

  identify(
    distinctId: string,
    properties?: Record<string, unknown>,
    raw: boolean = false
  ): void {
    try {
      this.distinctId = String(distinctId);
      storage.setItem('strawberry_distinct_id', this.distinctId).catch(() => {});

      const cleaned = redact(properties, raw);
      if (cleaned && typeof cleaned === 'object') {
        this.userProperties = { ...cleaned };
      }

      this.track('$identify', cleaned, true); // already redacted
    } catch (_) {}
  }

  screen(
    screenName: string,
    properties?: Record<string, unknown>,
    raw: boolean = false
  ): void {
    try {
      const cleaned = redact(properties, raw);
      this.track(
        '$screen_view',
        { screen_name: screenName, ...cleaned },
        true // already redacted
      );
    } catch (_) {}
  }

  /**
   * Capture an error. Matches the server-SDK signature:
   *   captureError(error, context = {})
   *
   * POSTs to /api/v1/errors/ingest with {error_type, message, stack_trace,
   * context, tags, release_version} and Authorization: Bearer <apiKey>.
   */
  captureError(
    error: Error,
    context: Record<string, unknown> = {},
    raw: boolean = false
  ): void {
    try {
      const cleanContext = redact(context, raw);
      const message = redactString(error?.message || String(error));
      const stack = redactString(error?.stack || '');
      const errorType = error?.name || 'Error';

      this.sendErrorEnvelope(errorType, message, stack, cleanContext, {});

      this.track(
        '$error',
        {
          $error_type: errorType,
          $error_message: message,
          $error_stack: stack,
          ...cleanContext,
        },
        true // already redacted
      );
    } catch (_) {}
  }

  diagnostics(): DiagnosticsSnapshot {
    diagnosticsState.setQueueDepth(this.queue.length);
    return diagnosticsSnapshot();
  }

  trackNavigation(navigationRef: NavigationRef): void {
    try {
      if (!navigationRef || !navigationRef.current) return;

      const currentRoute = getActiveRouteName(
        navigationRef.current.getRootState()
      );

      if (currentRoute && currentRoute !== this.prevNavigationRoute) {
        this.screen(currentRoute, {
          previous_screen: this.prevNavigationRoute || undefined,
        });
      }

      this.prevNavigationRoute = currentRoute;
    } catch (_) {}
  }

  async reset(): Promise<void> {
    try {
      this.distinctId = uuid4();
      this.sessionId = uuid4();
      this.sessionLastActivity = Date.now();
      this.userProperties = {};
      await storage.setItem('strawberry_distinct_id', this.distinctId);
    } catch (_) {}
  }

  flush(): Promise<void> {
    return this.drainQueue();
  }

  shutdown(): Promise<void> {
    try {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      if (this.appStateSubscription) {
        this.appStateSubscription.remove();
        this.appStateSubscription = null;
      }

      if (this.linkingSubscription) {
        this.linkingSubscription.remove();
        this.linkingSubscription = null;
      }

      if (this.prevErrorHandler && typeof global !== 'undefined' && (global as any).ErrorUtils) {
        (global as any).ErrorUtils.setGlobalHandler(this.prevErrorHandler);
        this.prevErrorHandler = null;
      }

      if (this.originalFetch && typeof global !== 'undefined') {
        (global as any).fetch = this.originalFetch;
        this.originalFetch = null;
      }

      if (this.originalXHROpen && typeof global !== 'undefined') {
        const XHR = (global as any).XMLHttpRequest;
        if (XHR) {
          XHR.prototype.open = this.originalXHROpen;
          XHR.prototype.send = this.originalXHRSend;
        }
        this.originalXHROpen = null;
        this.originalXHRSend = null;
      }

      return this.drainQueue();
    } catch (_) {
      return Promise.resolve();
    }
  }

  // -- Internal --

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      if (batch.length > 0) {
        await this.sendBatch(batch);
      }
    }
  }

  private async sendBatch(events: StrawberryEvent[], attempt: number = 0): Promise<void> {
    try {
      const payload = JSON.stringify({
        api_key: this.apiKey,
        events,
      });

      const response = await fetch(this.host + '/api/v1/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: payload,
      });

      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        diagnosticsState.recordRetry();
        const delay = this.batchBackoff.nextMs();
        await new Promise<void>((r) => setTimeout(r, delay));
        return this.sendBatch(events, attempt + 1);
      }

      if (!response.ok) {
        diagnosticsState.recordFailure();
      } else {
        this.batchBackoff.reset();
      }
    } catch (_) {
      if (attempt < MAX_RETRIES - 1) {
        diagnosticsState.recordRetry();
        const delay = this.batchBackoff.nextMs();
        await new Promise<void>((r) => setTimeout(r, delay));
        return this.sendBatch(events, attempt + 1);
      }
      diagnosticsState.recordFailure();
    }
  }

  private async sendErrorEnvelope(
    errorType: string,
    message: string,
    stackTrace: string,
    context: Record<string, unknown>,
    tags: Record<string, string>,
    attempt: number = 0
  ): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        error_type: errorType,
        message,
        stack_trace: stackTrace,
        context,
        tags,
        distinct_id: this.distinctId || 'anonymous',
        session_id: this.sessionId,
        uuid: uuid4(),
        timestamp: new Date().toISOString(),
      };
      if (this.releaseVersion) {
        body.release_version = this.releaseVersion;
      }

      const response = await fetch(this.host + '/api/v1/errors/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        diagnosticsState.recordRetry();
        const delay = this.errorBackoff.nextMs();
        await new Promise<void>((r) => setTimeout(r, delay));
        return this.sendErrorEnvelope(
          errorType, message, stackTrace, context, tags, attempt + 1
        );
      }

      if (!response.ok) {
        diagnosticsState.recordFailure();
      } else {
        this.errorBackoff.reset();
      }
    } catch (_) {
      if (attempt < MAX_RETRIES - 1) {
        diagnosticsState.recordRetry();
        const delay = this.errorBackoff.nextMs();
        await new Promise<void>((r) => setTimeout(r, delay));
        return this.sendErrorEnvelope(
          errorType, message, stackTrace, context, tags, attempt + 1
        );
      }
      diagnosticsState.recordFailure();
    }
  }
}

// -- Singleton API --

let _instance: StrawberryClient | null = null;

function configure(config: StrawberryConfig): StrawberryClient {
  if (_instance) {
    try {
      _instance.shutdown();
    } catch (_) {}
  }
  _instance = new StrawberryClient(config);
  return _instance;
}

function getInstance(): StrawberryClient {
  if (!_instance) {
    throw new Error('Strawberry not configured. Call Strawberry.configure({ apiKey }) first.');
  }
  return _instance;
}

function track(eventType: string, properties?: Record<string, unknown>): void {
  getInstance().track(eventType, properties);
}

function identify(distinctId: string, properties?: Record<string, unknown>): void {
  getInstance().identify(distinctId, properties);
}

function screen(screenName: string, properties?: Record<string, unknown>): void {
  getInstance().screen(screenName, properties);
}

function captureError(
  error: Error,
  context: Record<string, unknown> = {},
  raw: boolean = false
): void {
  getInstance().captureError(error, context, raw);
}

function diagnostics(): DiagnosticsSnapshot {
  return getInstance().diagnostics();
}

function trackNavigation(navigationRef: NavigationRef): void {
  getInstance().trackNavigation(navigationRef);
}

function reset(): Promise<void> {
  return getInstance().reset();
}

function flush(): Promise<void> {
  return getInstance().flush();
}

function shutdown(): Promise<void> {
  if (_instance) {
    const p = _instance.shutdown();
    _instance = null;
    return p;
  }
  return Promise.resolve();
}

const Strawberry = {
  configure,
  track,
  identify,
  screen,
  captureError,
  trackNavigation,
  diagnostics,
  reset,
  flush,
  shutdown,
  StrawberryClient,
};

export default Strawberry;
export {
  configure,
  track,
  identify,
  screen,
  captureError,
  trackNavigation,
  diagnostics,
  reset,
  flush,
  shutdown,
  StrawberryClient,
};
