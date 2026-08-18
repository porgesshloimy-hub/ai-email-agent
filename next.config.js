/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * openai and @anthropic-ai/sdk both ship a runtime-detection shim
   * (node_modules/<pkg>/_shims/auto/runtime-node.mjs) that re-exports
   * conditionally based on the environment. Next.js's production
   * webpack build tries to statically resolve every named export for
   * tree-shaking, and fails on that shim with:
   *
   *   Cannot get final name for export 'getRuntime' of
   *   ./node_modules/openai/_shims/auto/runtime-node.mjs
   *
   * This only started surfacing once these packages were imported from
   * more places in the module graph (lib/agent/llm/openai.ts and
   * lib/agent/llm/anthropic.ts, on top of the pre-existing OpenAI
   * import in lib/agent/run.ts) — a known issue with these SDKs' build
   * output under Next.js's webpack bundler, not a bug in this
   * project's code. Marking them external tells Next.js's server
   * bundle to require() them directly from node_modules at runtime
   * instead of bundling/tree-shaking them, which sidesteps the
   * analysis entirely. Safe to do since both are server-only
   * dependencies (never imported from client components).
   */
  experimental: {
    serverComponentsExternalPackages: [
      "openai",
      "@anthropic-ai/sdk",
    ],
  },
};

module.exports = nextConfig;
