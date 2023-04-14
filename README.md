# trpc-webrtc

A set of [tRPC](https://trpc.io/) adapters to enable type-safe communication via [`RTCDataChannel`](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) in the browser.

- Compatible with tRPC `>=10.20.0`.
- Use any [`RTCDataChannel`](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) as an in-browser tRPC server.
- Full support for queries, mutations, and subscriptions.

## Installation

```
# Using pnpm
pnpm add trpc-webrtc

# Using yarn
yarn add trpc-webrtc

# Using npm
npm install --save trpc-webrtc
```

## Getting Started

1. Initialize [tRPC](https://trpc.io/), with `allowOutsideOfServer: true`:

```
import { initTRPC } from "@trpc/server";
const t = initTRPC.create({ allowOutsideOfServer: true });
```

2. Create a router, [as usual](https://trpc.io/docs/quickstart):

```
const appRouter = t.router({
  testQuery: t.procedure.query(() => ({ hello: "world" })),
});
type AppRouter = typeof appRouter;
```

3. Invoke `applyDataChannelHandler` on an [`RTCDataChannel`](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) (`rx`) to act as the server:

```
import { applyDataChannelHandler } from "trpc-webrtc"
const handler = applyDataChannelHandler({
  dataChannel: rx,
  router: appRouter,
});
```

4. Create a client, using `dataChannelLink` with an [`RTCDataChannel`](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) (`tx`):

```
import { createTRPCProxyClient } from "@trpc/client";
import { createDataChannelClient, dataChannelLink } from "trpc-webrtc"

const client = createTRPCProxyClient<AppRouter>({
  links: [
    dataChannelLink({
      client: createDataChannelClient({ dataChannel: tx }),
    }),
  ],
});
```
