import { ToolCallRequest, ToolCallResult } from "./protocol";

/**
 * Provider-neutral tool descriptor and grant model. An adapter (e.g.
 * pi-extension) registers tools with its host using its own native
 * registration API, but the tool's typed contract and the grant check
 * live here so it is reusable across adapters.
 */

export interface ToolGrant {
  toolName: string;
  grantedTo: string;
}

export interface ToolDescriptor<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  execute(args: Args, request: ToolCallRequest): Promise<Result>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor<unknown, unknown>>();
  private readonly grants = new Set<string>();

  register<Args, Result>(descriptor: ToolDescriptor<Args, Result>): void {
    this.tools.set(descriptor.name, descriptor as unknown as ToolDescriptor<unknown, unknown>);
  }

  grant(grant: ToolGrant): void {
    this.grants.add(`${grant.toolName}:${grant.grantedTo}`);
  }

  async invoke(request: ToolCallRequest): Promise<ToolCallResult> {
    const descriptor = this.tools.get(request.toolName);
    if (!descriptor) {
      return { status: "error", error: `unknown tool: ${request.toolName}` };
    }

    // Prompt text cannot bypass this: the grant check is a runtime
    // boundary keyed on (tool, requester), independent of args/payload.
    const grantKey = `${request.toolName}:${request.requestedBy}`;
    if (!this.grants.has(grantKey)) {
      return { status: "unauthorized", reason: `no grant for ${grantKey}` };
    }

    try {
      const result = await descriptor.execute(request.args, request);
      return { status: "ok", result };
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
