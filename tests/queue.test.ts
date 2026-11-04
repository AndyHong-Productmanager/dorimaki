import { expect, test } from "bun:test";
import { ConversationQueue } from "../src/queue.js";

test("serializes one conversation while another can finish independently", async () => {
  const queue = new ConversationQueue();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const events: string[] = [];
  const first = queue.run("thread-a", async () => {
    events.push("first-start");
    started.resolve();
    await release.promise;
    events.push("first-end");
  });
  await started.promise;
  const second = queue.run("thread-a", async () => { events.push("second"); });
  await queue.run("thread-b", async () => { events.push("independent"); });
  expect(events).toEqual(["first-start", "independent"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["first-start", "independent", "first-end", "second"]);
});

test("failed operations release the conversation for the next message", async () => {
  const queue = new ConversationQueue();
  const failed = queue.run("thread", async () => { throw new Error("fixture failure"); });
  const next = queue.run("thread", async () => "next delivered");
  await expect(failed).rejects.toThrow("fixture failure");
  expect(await next).toBe("next delivered");
  await queue.drain();
});
