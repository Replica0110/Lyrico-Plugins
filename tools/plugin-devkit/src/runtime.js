import vm from 'node:vm';
import { createHostApi } from './host-api.js';

export async function createRuntime(plugin, options = {}) {
  const host = createHostApi({ echoLogs: options.echoLogs });
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  sandbox.app = host.api.app;
  sandbox.runtime = host.api.runtime;
  sandbox.Platform = host.api;

  const context = vm.createContext(sandbox, {
    name: `LyricoPlugin:${plugin.manifest.id}`
  });

  vm.runInContext(plugin.script, context, {
    filename: plugin.manifest.entry ?? 'source.js',
    timeout: Number(options.loadTimeoutMs ?? 15000)
  });

  return {
    host,
    context,
    async call(functionName, request) {
      const fn = context[functionName];
      if (typeof fn !== 'function') {
        throw new Error(`Plugin function ${functionName} is not defined`);
      }
      const startedAt = performance.now();
      const raw = await fn.call(context, request);
      const durationMs = Math.round(performance.now() - startedAt);
      return {
        raw: raw == null ? null : (typeof raw === 'string' ? raw : JSON.stringify(raw)),
        durationMs,
        logs: host.logs
      };
    }
  };
}
