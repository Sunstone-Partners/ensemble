import { ToolDescriptor } from "./tools";

/**
 * Example provider-neutral domain tool descriptors. Real behavior
 * packages define their own; this module exists to prove the
 * ToolDescriptor contract is usable end-to-end without any Pi-specific
 * type, and to give adapters a minimal working example to register.
 */

export interface EchoToolArgs {
  message: string;
}

export const echoTool: ToolDescriptor<EchoToolArgs, { echoed: string }> = {
  name: "echo",
  description: "Returns the given message unchanged; used to prove tool wiring end-to-end.",
  async execute(args) {
    return { echoed: args.message };
  },
};
