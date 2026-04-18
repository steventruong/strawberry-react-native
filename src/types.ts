export interface StrawberryConfig {
  apiKey: string;
  host?: string;
  flushInterval?: number;
  batchSize?: number;
  maxQueueSize?: number;
  releaseVersion?: string;
  autocapture?: {
    app_lifecycle?: boolean;
    crashes?: boolean;
    network_requests?: boolean;
    deep_links?: boolean;
    unhandled_rejections?: boolean;
  };
}

export interface StrawberryEvent {
  event_type: string;
  properties: Record<string, unknown>;
  timestamp: string;
  distinct_id: string;
  session_id: string;
  uuid: string;
}

export interface DeviceInfo {
  platform: string;
  os_version: string;
  device_model: string;
  screen_width: number;
  screen_height: number;
  locale?: string;
  timezone?: string;
}

export interface ErrorPayload {
  api_key: string;
  error_message: string;
  error_stack: string;
  is_fatal: boolean;
  timestamp: string;
  distinct_id: string;
  session_id: string;
  uuid: string;
  properties: Record<string, unknown>;
}

export interface NavigationRef {
  current: {
    getRootState: () => NavigationState | undefined;
  } | null;
}

export interface NavigationState {
  index: number;
  routes: Array<{
    name: string;
    state?: NavigationState;
  }>;
}
