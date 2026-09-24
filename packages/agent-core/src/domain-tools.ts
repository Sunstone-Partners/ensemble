import { ToolDescriptor } from "./tools";

/**
 * Example provider-neutral domain tool descriptors. Real behavior
 * packages define their own; this module exists to prove the
 * ToolDescriptor contract is usable end-to-end without any Pi-specific
 * type, and to give adapters a minimal working example to register.
 *
 * Every ToolDescriptor in this codebase is invoked with raw
 * `Record<string, unknown>` args (see ToolCallRequest.args) — the args
 * generic exists for documentation/self-checking within `execute`, not
 * as a distinct wire type callers can rely on structurally, so it is
 * declared as `Record<string, unknown>` here rather than a bespoke
 * interface that would be structurally incompatible with every other
 * ToolDescriptor<Record<string, unknown>, ...> caller expects.
 */
export const echoTool: ToolDescriptor<Record<string, unknown>, { echoed: string }> = {
  name: "echo",
  description: "Returns the given message unchanged; used to prove tool wiring end-to-end.",
  async execute(args) {
    const message = typeof args.message === "string" ? args.message : "";
    return { echoed: message };
  },
};
