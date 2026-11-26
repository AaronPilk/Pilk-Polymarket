// Test stand-in for the Workers runtime module, so Durable Object classes can be loaded and poked in Node.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
