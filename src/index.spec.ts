import { expect } from "@esm-bundle/chai";
import { createTRPCProxyClient } from "@trpc/client";
import { appRouter, AppRouter, Message } from "./__fixtures__/router.js";
import { establishConnection } from "./__fixtures__/util.js";
import { applyDataChannelHandler } from "./data-channel-handler.js";
import {
  createDataChannelClient,
  dataChannelLink,
} from "./data-channel-link.js";

describe("trpc-webrtc", () => {
  let client: RTCPeerConnection;
  let server: RTCPeerConnection;
  let tx: RTCDataChannel;
  let rx: RTCDataChannel;

  beforeEach(async () => {
    server = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    client = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const { from: fromChannel, to: toChannel } = await establishConnection({
      from: client,
      to: server,
    });

    tx = fromChannel;
    rx = toChannel;
  });

  afterEach(() => {
    client.close();
    server.close();
  });

  it("should handle raw data", async () => {
    const expected = "test data 123";
    const actualPromise = new Promise((resolve) =>
      rx.addEventListener(
        "message",
        (ev) => {
          resolve(ev.data);
        },
        { once: true }
      )
    );
    tx.send(expected);

    const actual = await actualPromise;
    expect(actual).to.deep.equal(expected);
  });

  it("should handle queries over connected data channels", async () => {
    const handler = applyDataChannelHandler({
      dataChannel: rx,
      router: appRouter,
    });

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        dataChannelLink({
          client: createDataChannelClient({ dataChannel: tx }),
        }),
      ],
    });

    const response = await client.testQuery.query({ id: "world" });

    expect(response).to.deep.equal({
      hello: "world",
    } satisfies typeof response);
  });

  it("should handle subscriptions over connected data channels", async () => {
    const handler = applyDataChannelHandler({
      dataChannel: rx,
      router: appRouter,
    });

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        dataChannelLink({
          client: createDataChannelClient({ dataChannel: tx }),
        }),
      ],
    });

    const expectedMessages: Message[] = [
      {
        id: "1",
        channel: "test",
        content: "hello",
      },
      {
        id: "2",
        channel: "test",
        content: "there",
      },
      {
        id: "3",
        channel: "test",
        content: "world",
      },
    ];

    // this subscription API isn't very nice :(
    // here, we track
    // 1) when the subscription is created and ACKed
    // 2) when the expected data arrives
    // 3) when the subscription is destroyed and ACKed
    const subscriptionPromise = new Promise<{ data: Promise<Message[]> }>(
      (resolveSubscription, rejectSubscription) => {
        const dataPromise = new Promise<Message[]>(
          (resolveData, rejectData) => {
            let count = 0;
            const messages: Message[] = [];
            const subscription = client.testSubscription.subscribe(
              { channel: "test" },
              {
                onError(err) {
                  // reject both, something went wrong
                  rejectSubscription(err);
                  rejectData(err);
                },
                onStarted() {
                  // the subscription is setup, complete the outer promise
                  resolveSubscription({ data: dataPromise });
                },
                onData(data) {
                  messages.push(data);
                  count++;
                  if (count >= expectedMessages.length) {
                    // when we've got the expected amount of messages, unsubscribe
                    subscription.unsubscribe();
                  }
                },
                onComplete() {
                  // when we've unsubscribed successfully, complete the inner promise
                  resolveData(messages);
                },
              }
            );
          }
        );
      }
    );

    // wait for the subscription to connect
    const subscriptionDataPromise = await subscriptionPromise;

    // send the events to create subscription data
    const expectedMessageResults = await Promise.all(
      expectedMessages.map((expected) =>
        client.addToTestSubscription.mutate(expected)
      )
    );

    // assert that the events sent
    expect(expectedMessageResults).to.deep.equal(expectedMessages);

    // wait for the data via the subscription
    const subscriptionResults = await subscriptionDataPromise.data;

    // assert that the data arrived
    expect(subscriptionResults).to.deep.equal(expectedMessages);
  });

  it("should error if disconnected", async () => {
    const handler = applyDataChannelHandler({
      dataChannel: rx,
      router: appRouter,
    });

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        dataChannelLink({
          client: createDataChannelClient({ dataChannel: tx }),
        }),
      ],
    });

    tx.close();

    let error = null;
    try {
      await client.testQuery.query({ id: "world" });
    } catch (e) {
      error = e;
    }

    expect(error).to.be.an("Error");
    expect(error).to.match(/DataChannel closed prematurely/);
  });

  it("should survive reconnection on the server", async () => {
    const didCloseRx = new Promise<void>((resolve) => {
      rx.addEventListener("close", () => resolve(), { once: true });
    });

    const handler = applyDataChannelHandler({
      dataChannel: rx,
      router: appRouter,
    });

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        dataChannelLink({
          client: createDataChannelClient({ dataChannel: tx }),
        }),
      ],
    });

    const normalResponse = await client.testQuery.query({ id: "world" });

    expect(normalResponse).to.deep.equal({
      hello: "world",
    } satisfies typeof normalResponse);

    rx.dispatchEvent(new Event("close"));
    rx.dispatchEvent(new Event("open"));

    await didCloseRx;

    const reconnectedResponse = await client.testQuery.query({ id: "world" });

    expect(reconnectedResponse).to.deep.equal({
      hello: "world",
    } satisfies typeof reconnectedResponse);
  });

  it("should survive reconnection on the client", async () => {
    const handler = applyDataChannelHandler({
      dataChannel: rx,
      router: appRouter,
    });

    const didCloseTx = new Promise<void>((resolve) => {
      tx.addEventListener("close", () => resolve(), { once: true });
    });

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        dataChannelLink({
          client: createDataChannelClient({ dataChannel: tx }),
        }),
      ],
    });

    const normalResponse = await client.testQuery.query({ id: "world" });

    expect(normalResponse).to.deep.equal({
      hello: "world",
    } satisfies typeof normalResponse);

    tx.dispatchEvent(new Event("close"));
    tx.dispatchEvent(new Event("open"));

    await didCloseTx;

    const reconnectedResponse = await client.testQuery.query({ id: "world" });

    expect(reconnectedResponse).to.deep.equal({
      hello: "world",
    } satisfies typeof reconnectedResponse);
  });
});
