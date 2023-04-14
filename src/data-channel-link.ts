import { AnyRouter, ProcedureType, inferRouterError } from "@trpc/server";
import { Observer, UnsubscribeFn, observable } from "@trpc/server/observable";
import {
  TRPCClientIncomingMessage,
  TRPCClientIncomingRequest,
  TRPCClientOutgoingMessage,
  TRPCRequestMessage,
  TRPCResponseMessage,
} from "@trpc/server/rpc";
import { Operation, TRPCLink, TRPCClientError } from "@trpc/client";
import { transformResult } from "./internals/transformResult.js";

// converted from https://github.com/trpc/trpc/blob/9c2df391fea0ff735d0a6c4c0bbf6c1f7c2cbecd/packages/client/src/links/wsLink.ts

type RTCCallbackResult<
  TRouter extends AnyRouter,
  TOutput
> = TRPCResponseMessage<TOutput, inferRouterError<TRouter>>;

type RTCCallbackObserver<TRouter extends AnyRouter, TOutput> = Observer<
  RTCCallbackResult<TRouter, TOutput>,
  TRPCClientError<TRouter>
>;

export interface DataChannelClientOptions {
  dataChannel: RTCDataChannel;
}

export function createDataChannelClient(opts: DataChannelClientOptions) {
  const { dataChannel } = opts;

  /**
   * outgoing messages buffer whilst not open
   */
  let outgoing: TRPCClientOutgoingMessage[] = [];
  /**
   * pending outgoing requests that are awaiting callback
   */
  type TCallbacks = RTCCallbackObserver<AnyRouter, unknown>;
  type TRequest = {
    /**
     * Reference to the dataChannel instance this request was made to
     */
    dataChannel: RTCDataChannel;
    type: ProcedureType;
    callbacks: TCallbacks;
    op: Operation;
  };
  const pendingRequests: Record<number | string, TRequest> =
    Object.create(null);
  let dispatchTimer: NodeJS.Timer | number | null = null;
  let state: "open" | "connecting" | "closed" = "connecting";
  let activeConnection = configureDataChannel();

  // the data channel may already be open, in which case
  // we should invoke the open handler on behalf of the caller
  // see `configureDataChannel` to understand why this needs to be hoisted
  if (activeConnection.readyState === "open") {
    onOpen();
  }

  /**
   * tries to send the list of messages
   */
  function dispatch() {
    if (state !== "open" || dispatchTimer) {
      return;
    }
    dispatchTimer = setTimeout(() => {
      dispatchTimer = null;

      if (activeConnection.readyState !== "open") {
        return;
      }

      if (outgoing.length === 1) {
        // single send
        activeConnection.send(JSON.stringify(outgoing.pop()));
      } else {
        // batch send
        activeConnection.send(JSON.stringify(outgoing));
      }
      // clear
      outgoing = [];
    });
  }

  function closeIfNoPending(conn: RTCDataChannel) {
    // disconnect as soon as there are are no pending result
    const hasPendingRequests = Object.values(pendingRequests).some(
      (p) => p.dataChannel === conn
    );
    if (!hasPendingRequests) {
      conn.close();
    }
  }

  function onOpen() {
    /* istanbul ignore next -- @preserve */
    if (dataChannel !== activeConnection) {
      return;
    }
    state = "open";
    dispatch();
  }

  function configureDataChannel() {
    if (dataChannel.readyState !== "open") {
      dataChannel.addEventListener("open", onOpen, { once: true });
    } else {
      // this is handled above, as we cannot access activeConnection here (which is during assignment)
      // so we instead hoist the call to after `configureDataChannel` completes
      // this could be refactored, but am trying to keep the shape of this logic aligned with `wsLink`
    }

    const handleIncomingRequest = (req: TRPCClientIncomingRequest) => {
      // we can't "reconnect" a data channel on our own, so we instead close it out
      // in practice, this should not be used for webrtc connections
      if (req.method === "reconnect" && dataChannel === activeConnection) {
        if (state === "open") {
          closeIfNoPending(dataChannel);
        }
      }
    };
    const handleIncomingResponse = (data: TRPCResponseMessage) => {
      const req = data.id !== null && pendingRequests[data.id];

      if (!req) {
        // do something?
        return;
      }

      req.callbacks.next?.(data);
      if (
        req.dataChannel !== activeConnection &&
        dataChannel === activeConnection
      ) {
        const oldWs = req.dataChannel;
        // gracefully replace old connection with this
        req.dataChannel = activeConnection;
        closeIfNoPending(oldWs);
      }

      if (
        "result" in data &&
        data.result.type === "stopped" &&
        dataChannel === activeConnection
      ) {
        req.callbacks.complete();
      }
    };
    dataChannel.addEventListener("message", ({ data }) => {
      const msg = JSON.parse(data) as TRPCClientIncomingMessage;

      if ("method" in msg) {
        handleIncomingRequest(msg);
      } else {
        handleIncomingResponse(msg);
      }
      if (dataChannel !== activeConnection || state === "closed") {
        // when receiving a message, we close old connection that has no pending requests
        closeIfNoPending(dataChannel);
      }
    });

    dataChannel.addEventListener("close", () => {
      for (const [key, req] of Object.entries(pendingRequests)) {
        if (req.dataChannel !== dataChannel) {
          continue;
        }

        if (state === "closed") {
          // If the connection was closed, we just call `complete()` on the request
          delete pendingRequests[key];
          req.callbacks.complete?.();
          continue;
        }

        // error if interrupted
        delete pendingRequests[key];
        req.callbacks.error?.(
          TRPCClientError.from(
            new TRPCDataChannelClosedError("DataChannel closed prematurely")
          )
        );
      }
    });
    return dataChannel;
  }

  function request(op: Operation, callbacks: TCallbacks): UnsubscribeFn {
    const { type, input, path, id } = op;
    const envelope: TRPCRequestMessage = {
      id,
      method: type,
      params: {
        input,
        path,
      },
    };
    pendingRequests[id] = {
      dataChannel: activeConnection,
      type,
      callbacks,
      op,
    };

    // enqueue message
    outgoing.push(envelope);
    dispatch();

    return () => {
      const callbacks = pendingRequests[id]?.callbacks;
      delete pendingRequests[id];
      outgoing = outgoing.filter((msg) => msg.id !== id);

      callbacks?.complete?.();
      if (
        activeConnection.readyState === "open" &&
        op.type === "subscription"
      ) {
        outgoing.push({
          id,
          method: "subscription.stop",
        });
        dispatch();
      }
    };
  }
  return {
    close: () => {
      state = "closed";
      closeIfNoPending(activeConnection);
    },
    request,
    getConnection() {
      return activeConnection;
    },
  };
}
export type TRPCDataChannelClient = ReturnType<typeof createDataChannelClient>;

export interface DataChannelLinkOptions {
  client: TRPCDataChannelClient;
}
class TRPCDataChannelClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TRPCDataChannelClosedError";
    Object.setPrototypeOf(this, TRPCDataChannelClosedError.prototype);
  }
}

class TRPCSubscriptionEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TRPCSubscriptionEndedError";
    Object.setPrototypeOf(this, TRPCSubscriptionEndedError.prototype);
  }
}

export function dataChannelLink<TRouter extends AnyRouter>(
  opts: DataChannelLinkOptions
): TRPCLink<TRouter> {
  return (runtime) => {
    const { client } = opts;
    return ({ op }) => {
      return observable((observer) => {
        const { type, path, id, context } = op;

        const input = runtime.transformer.serialize(op.input);

        let isDone = false;
        const unsub = client.request(
          { type, path, input, id, context },
          {
            error(err) {
              isDone = true;
              observer.error(err as TRPCClientError<any>);
              unsub();
            },
            complete() {
              if (!isDone) {
                isDone = true;
                observer.error(
                  TRPCClientError.from(
                    new TRPCSubscriptionEndedError(
                      "Operation ended prematurely"
                    )
                  )
                );
              } else {
                observer.complete();
              }
            },
            next(message) {
              runtime.transformer;
              const transformed = transformResult(message, runtime);

              if (!transformed.ok) {
                observer.error(TRPCClientError.from(transformed.error));
                return;
              }

              observer.next({
                result: transformed.result,
              });

              if (op.type !== "subscription") {
                // if it isn't a subscription we don't care about next response

                isDone = true;
                unsub();
                observer.complete();
              }
            },
          }
        );
        return () => {
          isDone = true;
          unsub();
        };
      });
    };
  };
}
