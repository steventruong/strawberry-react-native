# strawberry-react-native

Strawberry analytics SDK for React Native. Zero external dependencies beyond React Native itself.

## Installation

```bash
npm install strawberry-react-native
```

## Quick Start

```typescript
import Strawberry from 'strawberry-react-native';

Strawberry.configure({
  apiKey: 'berry_your_api_key',
  host: 'https://straw.berryagents.com',
});

Strawberry.track('$purchase', { revenue: 49.99 });
Strawberry.identify('user-123', { email: 'user@example.com' });
Strawberry.screen('HomeScreen');
Strawberry.captureError(new Error('Something went wrong'), { screen: 'Checkout' });
await Strawberry.flush();
Strawberry.reset();
```

## React Navigation Integration

Track screen views automatically by calling `trackNavigation` on navigation state changes.

```typescript
import { NavigationContainer } from '@react-navigation/native';
import { useRef } from 'react';
import Strawberry from 'strawberry-react-native';

function App() {
  const navigationRef = useRef(null);
  return (
    <NavigationContainer
      ref={navigationRef}
      onStateChange={() => Strawberry.trackNavigation(navigationRef)}>
      {/* Your screens */}
    </NavigationContainer>
  );
}
```

## Auto-Captured Events

All enabled by default. Disable any via the `autocapture` config option.

| Event | Trigger |
|-------|---------|
| `$app_opened` | App comes to foreground |
| `$app_backgrounded` | App goes to background |
| `$crash` | Unhandled JS error via ErrorUtils |
| `$unhandled_rejection` | Unhandled promise rejection |
| `$network_request` | Any fetch or XHR call (Strawberry endpoint excluded) |
| `$deep_link` | App opened via a deep link URL |

```typescript
Strawberry.configure({
  apiKey: 'sbk_...',
  autocapture: {
    app_lifecycle: false,
    crashes: false,
    unhandled_rejections: false,
    network_requests: false,
    deep_links: false,
  },
});
```

## Manual Tracking

```typescript
Strawberry.track('button_pressed', { button: 'signup' });
Strawberry.screen('Settings');
Strawberry.identify('user-456', { plan: 'pro' });
Strawberry.captureError(error, { context: 'payment_flow' });
```

## Device Properties

Every event automatically includes device properties gathered from React Native built-ins.

- `platform` (ios / android)
- `os_version`
- `device_model`
- `screen_width` and `screen_height`
- `locale`
- `timezone`

## Configuration Options

```typescript
Strawberry.configure({
  apiKey: 'sbk_...',            // Required
  host: 'https://...',          // Default: https://straw.berryagents.com
  flushInterval: 5000,          // Flush every 5s (default)
  batchSize: 20,                // Flush at 20 events (default)
  maxQueueSize: 5000,           // Max queued events (default)
});
```

## Session Management

Sessions expire after 30 minutes of inactivity. Events are batched and flushed every 5 seconds or when 20 events accumulate. Events flush immediately when the app goes to background.

## API

- `Strawberry.configure(config)` - Initialize the SDK
- `Strawberry.track(event, properties?)` - Track a custom event
- `Strawberry.identify(distinctId, properties?)` - Identify a user
- `Strawberry.screen(screenName, properties?)` - Track a screen view
- `Strawberry.captureError(error, properties?)` - Capture and send an error
- `Strawberry.trackNavigation(navigationRef)` - Track React Navigation screen changes
- `Strawberry.flush()` - Force flush the event queue
- `Strawberry.reset()` - Reset identity and session (call on logout)
- `Strawberry.shutdown()` - Clean up listeners and flush remaining events
