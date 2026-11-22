import { Miniflare as MiniflareRuntime, convertV4MiniflareOptions } from "miniflare";

// Keep existing test fixtures on the SDK's supported v4 options adapter.
export class Miniflare extends MiniflareRuntime {
  constructor(options) {
    super(convertV4MiniflareOptions(options));
  }
}
