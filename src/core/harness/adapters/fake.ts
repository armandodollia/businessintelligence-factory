import type { FakeScript, ToolClient } from '../adapter.js';

export type { FakeScript, ToolClient };

/**
 * Builds a `FakeScript` that makes the given tool calls in order (each awaited), for tests and
 * dry runs. A call whose `input` is a function receives the previous call's result.
 */
export function scriptedCalls(
  calls: Array<{ name: string; input: unknown | ((prev: unknown) => unknown) }>,
): FakeScript {
  return async (tools: ToolClient) => {
    let prev: unknown;
    for (const c of calls) {
      const input = typeof c.input === 'function' ? (c.input as (p: unknown) => unknown)(prev) : c.input;
      prev = await tools.call(c.name, input);
    }
  };
}
