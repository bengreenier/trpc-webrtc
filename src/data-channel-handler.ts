import {
  AnyRouter,
  ProcedureType,
  callProcedure,
  inferRouterContext,
  TRPCError,
  getTRPCErrorFromUnknown,
  CombinedDataTransformer,
} from "@trpc/server";
import { Unsubscribable, isObservable } from "@trpc/server/observable";
import {
  JSONRPC2,
  TRPCClientOutgoingMessage,
  TRPCReconnectNotification,
  TRPCResponseMessage,
} from "@trpc/server/rpc";
import { transformTRPCResponse } from "./internals/transformTRPCResponse.js";

// converted from https://github.com/trpc/trpc/blob/9c2df391fea0ff735d0a6c4c0bbf6c1f7c2cbecd/packages/server/src/adapters/ws.ts

/* istanbul ignore next -- @preserve */
function assertIsObject(obj: unknown): asserts obj is Record<string, unknown> {
  if (typeof obj !== "object" || Array.isArray(obj) || !obj) {
    throw new Error("Not an object");
  }
}
/* istanbul ignore next -- @preserve */
function assertIsProcedureType(obj: unknown): asserts obj is ProcedureType {
  if (obj !== "query" && obj !== "subscription" && obj !== "mutation") {
    throw new Error("Invalid procedure type");
  }
}
/* istanbul ignore next -- @preserve */
function assertIsRequestId(
  obj: unknown
): asserts obj is number | string | null {
  if (
    obj !== null &&
    typeof obj === "number" &&
    isNaN(obj) &&
    typeof obj !== "string"
  ) {
    throw new Error("Invalid request id");
  }
}
/* istanbul ignore next -- @preserve */
function assertIsString(obj: unknown): asserts obj is string {
  if (typeof obj !== "string") {
    throw new Error("Invalid string");
  }
}
/* istanbul ignore next -- @preserve */
function assertIsJSONRPC2OrUndefined(
  obj: unknown
): asserts obj is "2.0" | undefined {
  if (typeof obj !== "undefined" && obj !== "2.0") {
    throw new Error("Must be JSONRPC 2.0");
  }
}
export function parseMessage(
  obj: unknown,
  transformer: CombinedDataTransformer
): TRPCClientOutgoingMessage {
  assertIsObject(obj);
  const { method, params, id, jsonrpc } = obj;
  assertIsRequestId(id);
  assertIsJSONRPC2OrUndefined(jsonrpc);
  if (method === "subscription.stop") {
    return {
      id,
      jsonrpc,
      method,
    };
  }
  assertIsProcedureType(method);
  assertIsObject(params);

  const { input: rawInput, path } = params;
  assertIsString(path);
  const input = transformer.input.deserialize(rawInput);
  return {
    id,
    jsonrpc,
    method,
    params: {
      input,
      path,
    },
  };
}

/**
 * Data channel "server" handler
 */
export type DataChannelHandlerOptions<TRouter extends AnyRouter> = {
  onError?: (opts: {
    error: TRPCError;
    type: ProcedureType | "unknown";
    path: string | undefined;
    input: unknown;
    ctx: undefined | inferRouterContext<TRouter>;
  }) => void;
  createContext?: () =>
    | inferRouterContext<TRouter>
    | Promise<inferRouterContext<TRouter>>;
  router: TRouter;
  dataChannel: RTCDataChannel;
};

export function applyDataChannelHandler<TRouter extends AnyRouter>(
  opts: DataChannelHandlerOptions<TRouter>
) {
  const { dataChannel, createContext, router } = opts;

  const { transformer } = router._def._config;

  async function onOpen() {
    const clientSubscriptions = new Map<number | string, Unsubscribable>();

    function respond(untransformedJSON: TRPCResponseMessage) {
      dataChannel.send(
        JSON.stringify(transformTRPCResponse(router, untransformedJSON))
      );
    }

    function stopSubscription(
      subscription: Unsubscribable,
      { id, jsonrpc }: { id: JSONRPC2.RequestId } & JSONRPC2.BaseEnvelope
    ) {
      subscription.unsubscribe();

      respond({
        id,
        jsonrpc,
        result: {
          type: "stopped",
        },
      });
    }

    const ctxPromise = createContext?.();
    let ctx: inferRouterContext<TRouter> | undefined = undefined;

    async function handleRequest(msg: TRPCClientOutgoingMessage) {
      const { id, jsonrpc } = msg;
      /* istanbul ignore next -- @preserve */
      if (id === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "`id` is required",
        });
      }
      if (msg.method === "subscription.stop") {
        const sub = clientSubscriptions.get(id);
        if (sub) {
          stopSubscription(sub, { id, jsonrpc });
        }
        clientSubscriptions.delete(id);
        return;
      }
      const { path, input } = msg.params;
      const type = msg.method;
      try {
        await ctxPromise; // asserts context has been set

        const result = await callProcedure({
          procedures: router._def.procedures,
          path,
          rawInput: input,
          ctx,
          type,
        });

        if (type === "subscription") {
          if (!isObservable(result)) {
            throw new TRPCError({
              message: `Subscription ${path} did not return an observable`,
              code: "INTERNAL_SERVER_ERROR",
            });
          }
        } else {
          // send the value as data if the method is not a subscription
          respond({
            id,
            jsonrpc,
            result: {
              type: "data",
              data: result,
            },
          });
          return;
        }

        const observable = result;
        const sub = observable.subscribe({
          next(data) {
            respond({
              id,
              jsonrpc,
              result: {
                type: "data",
                data,
              },
            });
          },
          error(err) {
            const error = getTRPCErrorFromUnknown(err);
            opts.onError?.({ error, path, type, ctx, input });
            respond({
              id,
              jsonrpc,
              error: router.getErrorShape({
                error,
                type,
                path,
                input,
                ctx,
              }),
            });
          },
          complete() {
            respond({
              id,
              jsonrpc,
              result: {
                type: "stopped",
              },
            });
          },
        });
        /* istanbul ignore next -- @preserve */
        if (dataChannel.readyState !== "open") {
          // if the client got disconnected whilst initializing the subscription
          // no need to send stopped message if the client is disconnected
          sub.unsubscribe();
          return;
        }

        /* istanbul ignore next -- @preserve */
        if (clientSubscriptions.has(id)) {
          // duplicate request ids for client
          stopSubscription(sub, { id, jsonrpc });
          throw new TRPCError({
            message: `Duplicate id ${id}`,
            code: "BAD_REQUEST",
          });
        }
        clientSubscriptions.set(id, sub);

        respond({
          id,
          jsonrpc,
          result: {
            type: "started",
          },
        });
      } catch (cause) /* istanbul ignore next -- @preserve */ {
        // procedure threw an error
        const error = getTRPCErrorFromUnknown(cause);
        opts.onError?.({ error, path, type, ctx, input });
        respond({
          id,
          jsonrpc,
          error: router.getErrorShape({
            error,
            type,
            path,
            input,
            ctx,
          }),
        });
      }
    }
    dataChannel.addEventListener("message", async (message) => {
      try {
        const msgJSON: unknown = JSON.parse(message.data.toString());
        const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
        const promises = msgs
          .map((raw) => parseMessage(raw, transformer))
          .map(handleRequest);
        await Promise.all(promises);
      } catch (cause) {
        const error = new TRPCError({
          code: "PARSE_ERROR",
          cause: cause instanceof Error ? cause : undefined,
        });

        respond({
          id: null,
          error: router.getErrorShape({
            error,
            type: "unknown",
            path: undefined,
            input: undefined,
            ctx: undefined,
          }),
        });
      }
    });

    dataChannel.addEventListener("error", () => {
      opts.onError?.({
        ctx,
        error: getTRPCErrorFromUnknown(
          new Error("Underlying RTCDataChannel error")
        ),
        input: undefined,
        path: undefined,
        type: "unknown",
      });
    });

    dataChannel.addEventListener(
      "close",
      () => {
        for (const sub of clientSubscriptions.values()) {
          sub.unsubscribe();
        }
        clientSubscriptions.clear();
      },
      { once: true }
    );
    async function createContextAsync() {
      try {
        ctx = await ctxPromise;
      } catch (cause) {
        const error = getTRPCErrorFromUnknown(cause);
        opts.onError?.({
          error,
          path: undefined,
          type: "unknown",
          ctx,
          input: undefined,
        });
        respond({
          id: null,
          error: router.getErrorShape({
            error,
            type: "unknown",
            path: undefined,
            input: undefined,
            ctx,
          }),
        });

        // close in next tick
        (global.setImmediate ?? global.setTimeout)(() => {
          dataChannel.close();
        });
      }
    }
    await createContextAsync();
  }

  if (dataChannel.readyState !== "open") {
    dataChannel.addEventListener("open", onOpen, { once: true });
  } else {
    onOpen();
  }

  return {
    /**
     * Don't use this, data channels can't be automatically reconnected.
     */
    broadcastReconnectNotification: () => {
      // TODO(bengreenier): remove this handler from the returned object
      throw new Error("Reconnection is not supported");
    },
  };
}
