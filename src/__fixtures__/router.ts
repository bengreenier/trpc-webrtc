import Emitter from "emittery";
import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";

const t = initTRPC.create({ allowOutsideOfServer: true });

const ee = new Emitter();
const Message = z.object({
  id: z.string(),
  channel: z.string(),
  content: z.string(),
});
export type Message = z.infer<typeof Message>;

export const appRouter = t.router({
  testQuery: t.procedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      return {
        hello: input.id,
      };
    }),
  testSubscription: t.procedure
    .input(Message.pick({ channel: true }))
    .subscription(({ input }) => {
      return observable<Message>((emit) => {
        const unsub = ee.on(input.channel, (data: Message) => {
          emit.next(data);
        });

        return () => {
          unsub();
        };
      });
    }),
  addToTestSubscription: t.procedure
    .input(Message)
    .mutation(async ({ input }) => {
      await ee.emit(input.channel, input);

      return input;
    }),
});

export type AppRouter = typeof appRouter;
